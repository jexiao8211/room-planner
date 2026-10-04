// Chat executor, round 3 (ROUND3-SPEC §3-5): dependency order, ok / adjusted / failed chips, "under", levels, hang.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAction, PlacedItem } from "../../shared/types";
import { defaultRoom } from "../../lib/presets";
import { fitsAtSpot, footprintsOverlap, supportSurfaces, worldToSupport } from "../../lib/geometry";
import type { PlannerState } from "../../state/store";
import type * as ExecModule from "./executeActions";

const memory = new Map<string, string>();
const storage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, String(v)),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
  key: (i: number) => [...memory.keys()][i] ?? null,
  get length() {
    return memory.size;
  },
};

type StoreModule = typeof import("../../state/store");
let usePlanner: StoreModule["usePlanner"];
let X: typeof ExecModule;
const S = (): PlannerState => usePlanner.getState();
const byName = (name: string): PlacedItem => {
  const it = [...S().items].reverse().find((i) => i.name === name);
  if (!it) throw new Error(`no item ${name}`);
  return it;
};

beforeAll(async () => {
  vi.stubGlobal("localStorage", storage);
  usePlanner = (await import("../../state/store")).usePlanner;
  X = await import("./executeActions");
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  usePlanner.setState({ room: defaultRoom(), items: [], selectedId: null, units: "metric", preview: null, previewTargetId: null, placementHint: null, past: [], future: [] });
});

const run = (actions: ChatAction[]) => X.executeActions(actions, { planner: usePlanner });
/** Every chip is exactly one of ok / adjusted / failed, never "ok" with an error. */
const expectCleanChips = (results: ExecModule.ActionResult[]) => {
  for (const r of results) {
    expect(["ok", "adjusted", "failed"]).toContain(r.status);
    if (r.status === "ok") expect(r.error ?? r.note).toBeUndefined();
    if (r.status === "adjusted") {
      expect(r.ok).toBe(true);
      expect(r.error).toBeUndefined();
      expect(r.note).toBeTruthy();
    }
    if (r.status === "failed") {
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    }
  }
};
const bin: ChatAction = { type: "addShape", ref: "bin", name: "Bin", preset: "cylinder", dims: { w: 0.3, h: 0.35, d: 0.3 } };

describe("dependency order and chips", () => {
  it("moving the desk before the monitor goes on it: no 'that spot is taken: overlaps Monitor' (owner's report)", () => {
    run([
      { type: "addShape", name: "Desk", preset: "desk", placement: { kind: "corner", corner: "nw" } },
      { type: "addShape", name: "Monitor", preset: "box", dims: { w: 0.6, h: 0.4, d: 0.2 }, placement: { kind: "at", x: 0.5, z: 0.5 } },
    ]);
    const desk = byName("Desk");
    const mon = byName("Monitor");
    const out = run([
      { type: "move", itemId: desk.id, placement: { kind: "at", x: 0.5, z: 0.5 } },
      { type: "move", itemId: mon.id, placement: { kind: "onTop", targetId: desk.id } },
    ]);
    expectCleanChips(out.results);
    expect(out.results.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(byName("Monitor").supportId).toBe(desk.id);
    expect(byName("Desk").position).toMatchObject({ x: expect.closeTo(0.5), z: expect.closeTo(0.5) });
  });

  it("runs a support's move before the stacking that depends on it, but reports chips in the reply's order", () => {
    run([{ type: "addShape", name: "Desk", preset: "desk" }, { type: "addShape", name: "Monitor", preset: "box", dims: { w: 0.6, h: 0.4, d: 0.2 }, placement: { kind: "corner", corner: "se" } }]);
    const desk = byName("Desk");
    const mon = byName("Monitor");
    const out = run([
      { type: "move", itemId: mon.id, placement: { kind: "onTop", targetId: desk.id } },
      { type: "move", itemId: desk.id, placement: { kind: "wall", wall: "north" } },
    ]);
    expect(out.results.map((r) => r.type)).toEqual(["move", "move"]);
    expect(out.results[0].label).toMatch(/Monitor/);
    expectCleanChips(out.results);
    // The desk moved first, so the monitor went onto it at the wall, at the back edge (screens go to the back).
    const d = byName("Desk");
    const m = byName("Monitor");
    expect(m.supportId).toBe(d.id);
    expect(m.position.z).toBeLessThan(d.position.z);
    // One undo step.
    expect(out.step).not.toBeNull();
  });

  it("runOrder: refs before use, support moves before stacking, written order otherwise", () => {
    const list: ChatAction[] = [
      { type: "move", itemId: "mon", placement: { kind: "onTop", targetId: "desk1" } },
      { type: "addShape", ref: "desk1", name: "Desk", preset: "desk" },
      { type: "recolor", itemId: "lamp1", color: "#ff0000" },
      { type: "addShape", ref: "lamp1", name: "Lamp", preset: "cylinder" },
      { type: "camera", preset: "top" },
    ];
    expect(X.runOrder(list)).toEqual([1, 0, 3, 2, 4]);
    // A removal is never moved ahead of what uses the item.
    expect(X.runOrder([{ type: "move", itemId: "a", placement: { kind: "nextTo", targetId: "b" } }, { type: "remove", itemId: "b" }])).toEqual([0, 1]);
    // Saving a version is a barrier: "monitor on the desk, save as A, move the desk to the wall, save as B" saves A
    // with the monitor on the desk (reordering only happens between the saves).
    const saves: ChatAction[] = [
      { type: "move", itemId: "mon", placement: { kind: "onTop", targetId: "desk" } },
      { type: "saveVersion", name: "Option A" },
      { type: "move", itemId: "desk", placement: { kind: "wall", wall: "north" } },
      { type: "saveVersion", name: "Option B" },
    ];
    expect(X.runOrder(saves)).toEqual([0, 1, 2, 3]);
    expect(X.runOrder([saves[0], saves[1], saves[2], { type: "move", itemId: "x", placement: { kind: "onTop", targetId: "desk1" } }, { type: "addShape", ref: "desk1", name: "Desk" }])).toEqual([0, 1, 2, 4, 3]);
  });

  it("finalizeResult: a done action with caveats is 'adjusted' with a note, never ok + error", () => {
    expect(X.finalizeResult({ type: "move", ok: true, label: "Moved", error: "shifted" })).toEqual({ type: "move", ok: true, status: "adjusted", label: "Moved", note: "shifted" });
    expect(X.finalizeResult({ type: "move", ok: true, label: "Moved" }, ["a", "a"])).toMatchObject({ status: "adjusted", note: "a" });
    expect(X.finalizeResult({ type: "move", ok: false, label: "Move", error: "nope" })).toMatchObject({ status: "failed", error: "nope" });
    expect(X.chipStatus({ ok: true, error: "old saved caveat" })).toBe("adjusted");
  });
});

describe("under", () => {
  it("puts the bin under the desk; it moves with the desk and stays under it", () => {
    run([{ type: "addShape", ref: "d", name: "Desk", preset: "desk" }]);
    const out = run([{ ...bin, placement: { kind: "under", targetId: byName("Desk").id } }]);
    expectCleanChips(out.results);
    expect(out.results[0]).toMatchObject({ status: "ok", label: "Added Bin · under Desk" });
    const desk = byName("Desk");
    let b = byName("Bin");
    expect(b).toMatchObject({ supportId: desk.id, supportSurfaceY: 0 });
    expect(b.position.y).toBe(0);
    expect(fitsAtSpot(b, desk, supportSurfaces(desk)[1], worldToSupport(desk, b.position), b.rotationY)).toBe(true);
    run([{ type: "move", itemId: desk.id, placement: { kind: "wall", wall: "west" } }]);
    b = byName("Bin");
    const d2 = byName("Desk");
    expect(b).toMatchObject({ supportId: d2.id, supportSurfaceY: 0 });
    expect(b.position.y).toBe(0);
    expect(Math.hypot(b.position.x - d2.position.x, b.position.z - d2.position.z)).toBeLessThan(0.5);
  });

  it("refuses what doesn't fit under, and anything under a solid box", () => {
    run([{ type: "addShape", ref: "d", name: "Desk", preset: "desk" }, { type: "addShape", name: "Dresser", preset: "box", dims: { w: 1, h: 0.8, d: 0.5 }, placement: { kind: "corner", corner: "ne" } }]);
    run([{ type: "addShape", name: "Tall box", preset: "box", dims: { w: 0.3, h: 0.9, d: 0.3 }, placement: { kind: "corner", corner: "sw" } }]);
    const out = run([
      { type: "move", itemId: byName("Tall box").id, placement: { kind: "under", targetId: byName("Desk").id } },
      { type: "move", itemId: byName("Tall box").id, placement: { kind: "under", targetId: byName("Dresser").id } },
    ]);
    expectCleanChips(out.results);
    expect(out.results[0]).toMatchObject({ status: "failed", error: "Tall box doesn't fit under Desk" });
    expect(out.results[1]).toMatchObject({ status: "failed", error: "there's no room under Dresser" });
    expect(byName("Tall box").supportId).toBeUndefined();
  });
});

describe("levels", () => {
  it("puts the cat on the middle level of the cat tower, clear of the post", () => {
    run([{ type: "addShape", ref: "t", name: "Cat tower", preset: "cattower", placement: { kind: "corner", corner: "nw" } }]);
    const tower = byName("Cat tower");
    const out = run([{ type: "addShape", name: "Cat", preset: "cat", placement: { kind: "onTop", targetId: tower.id, level: "middle" } }]);
    expectCleanChips(out.results);
    expect(out.results[0]).toMatchObject({ status: "ok", label: "Added Cat · on the middle level of Cat tower" });
    const cat = byName("Cat");
    expect(cat.supportId).toBe(tower.id);
    expect(cat.supportSurfaceY).toBeCloseTo(0.945);
    expect(cat.position.y).toBeCloseTo(0.945);
    expect(fitsAtSpot(cat, tower, supportSurfaces(tower)[1], worldToSupport(tower, cat.position), cat.rotationY)).toBe(true);
    // Moving the tower carries the cat on its platform.
    run([{ type: "move", itemId: tower.id, placement: { kind: "corner", corner: "se" } }]);
    expect(byName("Cat").position.y).toBeCloseTo(0.945);
    expect(byName("Cat").supportId).toBe(tower.id);
    // A second cat on the top; "bottom" (the condo roof, too low for a cat) goes to the nearest level, adjusted.
    const more = run([
      { type: "addShape", name: "Cat 2", preset: "cat", placement: { kind: "onTop", targetId: tower.id } },
      { type: "addShape", name: "Cat 3", preset: "cat", placement: { kind: "onTop", targetId: tower.id, level: "bottom" } },
    ]);
    expectCleanChips(more.results);
    expect(byName("Cat 2").position.y).toBeCloseTo(1.5);
    expect(more.results[1].status).toBe("adjusted");
    expect(more.results[1].note).toMatch(/no bottom level that fits Cat 3/);
    expect(footprintsOverlap(byName("Cat"), byName("Cat 3"))).toBe(false);
  });

  it("a monitor on a bed rests on the mattress, not in the air at headboard height", () => {
    run([{ type: "addShape", name: "Bed", preset: "bed" }]);
    run([{ type: "addShape", name: "Laptop", preset: "box", dims: { w: 0.33, h: 0.02, d: 0.24 }, placement: { kind: "onTop", targetId: byName("Bed").id } }]);
    expect(byName("Laptop").position.y).toBeCloseTo(0.3);
  });
});

describe("ceiling items", () => {
  it("the owner's pendant: putting it on the desk keeps it hanging (Mount stays ceiling), above the desk", () => {
    run([{ type: "addShape", name: "Desk", preset: "desk", placement: { kind: "wall", wall: "west" } }, { type: "addShape", name: "Pendant", preset: "pendant" }]);
    const desk = byName("Desk");
    const out = run([{ type: "move", itemId: byName("Pendant").id, placement: { kind: "onTop", targetId: desk.id } }]);
    expectCleanChips(out.results);
    // Over the desk is what was asked: a plain ok chip that says so (no amber warning).
    expect(out.results[0]).toMatchObject({ status: "ok", label: "Moved Pendant → above Desk" });
    const p = byName("Pendant");
    expect(p.mount).toBe("ceiling");
    expect(p.supportId).toBeUndefined();
    expect(p.position.x).toBeCloseTo(desk.position.x);
    expect(p.position.z).toBeCloseTo(desk.position.z);
    expect(p.position.y + p.dims.h).toBeCloseTo(S().room.height);
  });

  it("a new hanging item put on a desk made in the same reply stays hanging, above it", () => {
    const out = run([
      { type: "addShape", ref: "desk1", name: "Desk", preset: "desk" },
      { type: "addShape", name: "Pendant", preset: "pendant", mount: "ceiling", placement: { kind: "onTop", targetId: "desk1" } },
    ]);
    expectCleanChips(out.results);
    const p = byName("Pendant");
    const desk = byName("Desk");
    expect(p.mount).toBe("ceiling");
    expect(p.supportId).toBeUndefined();
    expect(p.position.x).toBeCloseTo(desk.position.x);
    expect(p.position.z).toBeCloseTo(desk.position.z);
    expect(p.position.y + p.dims.h).toBeCloseTo(S().room.height);
    expect(out.results[1]).toMatchObject({ status: "ok", label: "Added Pendant · above Desk" });
    // "Under the desk" can't be done by a hanging lamp: done differently, and the chip says how.
    const under = run([{ type: "move", itemId: p.id, placement: { kind: "under", targetId: desk.id } }]);
    expect(under.results[0].status).toBe("adjusted");
    expect(under.results[0].note).toMatch(/hangs from the ceiling, so it's above Desk/);
    // The server's "at the desk's spot" for "hang it over the desk" reads "above Desk" too.
    run([{ type: "move", itemId: p.id, placement: { kind: "at", x: 0, z: 0 } }]);
    const at = run([{ type: "move", itemId: p.id, placement: { kind: "at", x: desk.position.x, z: desk.position.z } }]);
    expect(at.results[0]).toMatchObject({ status: "ok", label: "Moved Pendant → above Desk" });
  });

  it("hang: a table lamp off the desk up to the ceiling with a pendant drop; lower it by 6 inches", () => {
    run([{ type: "addShape", ref: "d", name: "Desk", preset: "desk" }, { type: "addShape", name: "Table lamp", preset: "cylinder", dims: { w: 0.3, h: 0.5, d: 0.3 }, placement: { kind: "onTop", targetId: "d" } }]);
    const lamp = byName("Table lamp");
    const out = run([{ type: "hang", itemId: lamp.id }]);
    expectCleanChips(out.results);
    let l = byName("Table lamp");
    expect(l.mount).toBe("ceiling");
    expect(l.supportId).toBeUndefined();
    const room = S().room;
    expect(l.dims.h).toBeCloseTo(room.height - 1.9);
    expect(out.results[0].label).toMatch(/^Hung Table lamp from the ceiling/);
    const lower = run([{ type: "hang", itemId: lamp.id, drop: l.dims.h + 0.1524 }]);
    expectCleanChips(lower.results);
    l = byName("Table lamp");
    expect(l.dims.h).toBeCloseTo(room.height - 1.9 + 0.1524);
    expect(l.position.y + l.dims.h).toBeCloseTo(room.height);
    expect(lower.results[0].label).toMatch(/^Lowered Table lamp by/);
    // Too low: kept 30 cm off the floor, and the chip says so.
    const tooLow = run([{ type: "hang", itemId: lamp.id, drop: 5 }]);
    expect(tooLow.results[0].status).toBe("adjusted");
    expect(byName("Table lamp").position.y).toBeCloseTo(0.3);
    // "hang it at 1.8 m" on a hanging item = its bottom at 1.8 m; higher than its own body allows is adjusted.
    run([{ type: "setHeight", itemId: lamp.id, bottom: 1.8 }]);
    expect(byName("Table lamp").position.y).toBeCloseTo(1.8);
    const high = run([{ type: "setHeight", itemId: lamp.id, bottom: 2.2 }]);
    expect(high.results[0]).toMatchObject({ status: "adjusted" });
    expect(byName("Table lamp").position.y).toBeCloseTo(S().room.height - 0.52);
  });
});

describe("next to: free floor, rugs and things under a desk (review round 3)", () => {
  const box = (id: string, name: string, x: number, z: number, rotDeg: number, dims: PlacedItem["dims"], extra: Partial<PlacedItem> = {}): PlacedItem => ({
    id,
    name,
    position: { x, y: 0, z },
    rotationY: (rotDeg * Math.PI) / 180,
    dims,
    color: "#888888",
    mount: "floor",
    parts: [{ kind: "box", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } }],
    origin: "shape",
    ...extra,
  });

  it("a floor lamp by a bed against the wall goes to free floor beside it, never into the nightstand; a rug is no obstacle", () => {
    const room = { ...defaultRoom(), width: 3.66, depth: 3.35 };
    usePlanner.setState({
      room,
      items: [
        box("rug", "Rug", 0.1, 0.35, 0, { w: 1.6, h: 0.02, d: 2.2 }),
        box("bed", "Bed", -0.78, 0.45, 90, { w: 1.6, h: 0.6, d: 2.1 }),
        box("ns", "Nightstand", -1.58, -0.62, 90, { w: 0.5, h: 0.6, d: 0.4 }),
      ],
    });
    const lamp = run([{ type: "addShape", name: "Floor lamp", preset: "cylinder", dims: { w: 0.4, h: 1.6, d: 0.4 }, placement: { kind: "nextTo", targetId: "bed" } }]);
    expectCleanChips(lamp.results);
    expect(lamp.results[0]).toMatchObject({ status: "ok", label: "Added Floor lamp · next to Bed" });
    const plant = run([{ type: "addShape", name: "Plant", preset: "cylinder", dims: { w: 0.4, h: 1, d: 0.4 }, placement: { kind: "nextTo", targetId: "bed" } }]);
    expect(plant.results[0].status).toBe("ok");
    for (const name of ["Floor lamp", "Plant"]) {
      for (const other of ["Bed", "Nightstand", "Floor lamp", "Plant"]) {
        if (other !== name) expect(footprintsOverlap(byName(name), byName(other)), `${name} vs ${other}`).toBe(false);
      }
    }
  });

  it("next to a bin under the desk = on the floor beside it, never on the desk top", () => {
    run([{ type: "addShape", ref: "d", name: "Desk", preset: "desk" }]);
    const desk = byName("Desk");
    run([{ type: "addShape", name: "Bin", preset: "cylinder", dims: { w: 0.3, h: 0.3, d: 0.3 }, placement: { kind: "under", targetId: desk.id } }]);
    expect(byName("Bin")).toMatchObject({ supportId: desk.id, supportSurfaceY: 0 });
    run([{ type: "addShape", name: "Plant", preset: "cylinder", dims: { w: 0.3, h: 1, d: 0.3 }, placement: { kind: "center" } }]);
    const out = run([{ type: "move", itemId: byName("Plant").id, placement: { kind: "nextTo", targetId: byName("Bin").id, side: "left" } }]);
    expectCleanChips(out.results);
    const plant = byName("Plant");
    expect(plant.supportId).toBeUndefined();
    expect(plant.position.y).toBe(0);
  });
});

describe("scene levels for the chat", () => {
  it("a cat tower lists its raised levels with heights and kinds; a desk lists none", async () => {
    const B = await import("./buildScene");
    run([{ type: "addShape", name: "Cat tower", preset: "cattower" }, { type: "addShape", name: "Desk", preset: "desk" }]);
    const scene = B.buildChatScene(S());
    const tower = scene.items.find((it) => it.name === "Cat tower")!;
    expect(tower.levels).toEqual([
      { name: "top", y: 1.5, kind: "platform" },
      { name: "middle level", y: 0.945, kind: "platform" },
      { name: "bottom level", y: 0.675, kind: "box" },
    ]);
    expect(scene.items.find((it) => it.name === "Desk")!.levels).toBeUndefined();
  });
});
