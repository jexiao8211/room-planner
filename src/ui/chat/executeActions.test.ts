import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAction, ChatPlacement, PlacedItem, ProductCandidate } from "../../shared/types";
import { defaultRoom } from "../../lib/presets";
import { footprintsOverlap } from "../../lib/geometry";
import type { PlannerState } from "../../state/store";
import type * as ExecModule from "./executeActions";

// zustand's persist middleware writes to localStorage, which node doesn't have.
// Stub an in-memory implementation BEFORE the store module is imported (same as the store tests).
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
}

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
  vi.stubGlobal("localStorage", new MemoryStorage());
  usePlanner = (await import("../../state/store")).usePlanner;
  X = await import("./executeActions");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  usePlanner.setState({
    room: defaultRoom(), // 3.66 × 3.35 × 2.44
    items: [],
    selectedId: null,
    units: "metric",
    preview: null,
    previewTargetId: null,
    placementHint: null,
    past: [],
    future: [],
  });
});

const run = (actions: ChatAction[], extra: Partial<ExecModule.ExecContext> = {}) => X.executeActions(actions, { planner: usePlanner, ...extra });

const add = (name: string, preset: string, placement?: ChatPlacement, ref?: string): ChatAction => ({
  type: "addShape",
  name,
  preset,
  placement,
  ref,
});

const monitor = (placement?: ChatPlacement, ref = "mon"): ChatAction => ({
  type: "addShape",
  ref,
  name: "Monitor",
  preset: "box",
  dims: { w: 0.6, h: 0.4, d: 0.2 },
  color: "#222222",
  parts: [
    { kind: "box", center: { x: 0, y: 0.6, z: 0 }, size: { x: 1, y: 0.8, z: 0.15 } },
    { kind: "box", center: { x: 0, y: 0.1, z: 0 }, size: { x: 0.1, y: 0.2, z: 0.1 } },
    { kind: "box", center: { x: 0, y: 0.01, z: 0 }, size: { x: 0.4, y: 0.02, z: 0.8 } },
  ],
  placement,
});

const candidate = (id: string, name: string, extra: Partial<ProductCandidate> = {}): ProductCandidate => ({
  id,
  name,
  retailer: "Shop",
  url: `https://example.com/${id}`,
  price: 99,
  currency: "USD",
  dims: { w: 0.3, h: 0.45, d: 0.3 },
  dimsSource: "listed",
  colors: [{ name: "White", hex: "#ffffff" }],
  style: ["Japanese"],
  materials: ["paper"],
  mount: "floor",
  parts: [{ kind: "cylinder", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } }],
  ...extra,
});

describe("addShape", () => {
  it("starts from a preset and overrides name, dims, color", () => {
    const out = run([{ type: "addShape", preset: "desk", name: "Writing desk", dims: { w: 1.4, h: 0.74, d: 0.7 }, color: "#ABC" }]);
    expect(out.results).toEqual([expect.objectContaining({ ok: true, label: "Added Writing desk", swatch: "#aabbcc" })]);
    const desk = byName("Writing desk");
    expect(desk.dims).toEqual({ w: 1.4, h: 0.74, d: 0.7 });
    expect(desk.color).toBe("#aabbcc");
    expect(desk.parts).toHaveLength(3); // desk preset silhouette
    expect(desk.origin).toBe("shape");
    expect(S().selectedId).toBe(desk.id);
  });

  it("uses a full primitive for a shape kind, sanitizes custom parts and clamps dims", () => {
    run([
      { type: "addShape", preset: "cylinder", name: "Pillar", dims: { w: 9, h: 0.001, d: 0.3 } },
      {
        type: "addShape",
        name: "Odd",
        parts: [
          { kind: "box", center: { x: 2, y: -1, z: 0 }, size: { x: 5, y: 0.5, z: 1 }, color: "red" },
          { kind: "blob" as never, center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
        ],
      },
    ]);
    const pillar = byName("Pillar");
    expect(pillar.parts).toEqual([{ kind: "cylinder", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } }]);
    expect(pillar.dims).toEqual({ w: 5, h: 0.02, d: 0.3 });
    const odd = byName("Odd");
    expect(odd.parts).toEqual([{ kind: "box", center: { x: 0.5, y: 0, z: 0 }, size: { x: 1, y: 0.5, z: 1 } }]);
  });

  it("keeps the preset's mount unless one is given", () => {
    run([add("Lamp", "pendant"), { type: "addShape", name: "Shelf", preset: "box", mount: "wall" }]);
    expect(byName("Lamp").mount).toBe("ceiling");
    expect(byName("Shelf").mount).toBe("wall");
  });

  it("places against a wall, back to it, facing the room", () => {
    const out = run([add("Desk", "desk", { kind: "wall", wall: "west" })]);
    expect(out.results[0]).toMatchObject({ ok: true, label: "Added Desk · west wall" });
    const desk = byName("Desk");
    expect(desk.rotationY).toBeCloseTo(Math.PI / 2);
    expect(desk.position.x).toBeCloseTo(-3.66 / 2 + 0.3); // depth 0.6 against the wall
    expect(desk.position.z).toBeCloseTo(0);
  });

  it("without a fraction, takes the free stretch of the wall nearest its middle", () => {
    run([add("Chair", "box", { kind: "wall", wall: "west" })]);
    expect(byName("Chair").position.z).toBeCloseTo(0);
    run([add("Desk", "desk", { kind: "wall", wall: "west" })]);
    const desk = byName("Desk");
    expect(footprintsOverlap(desk, byName("Chair"))).toBe(false);
    expect(desk.position.x).toBeCloseTo(-3.66 / 2 + 0.3);
    expect(Math.abs(desk.position.z)).toBeGreaterThanOrEqual(0.25 + 0.6 - 1e-6);
  });

  it("keeps wall art off windows when no fraction is given", () => {
    // The default room has a 1.2 m window centered on the north wall.
    run([add("Art", "frame", { kind: "wall", wall: "north" })]);
    const art = byName("Art");
    expect(Math.abs(art.position.x)).toBeGreaterThanOrEqual(0.6 + 0.4);
  });

  it("places along a wall by fraction from the wall's min end", () => {
    run([add("Bed", "bed", { kind: "wall", wall: "north", along: 0 })]);
    const bed = byName("Bed");
    expect(bed.rotationY).toBeCloseTo(0);
    expect(bed.position.z).toBeCloseTo(-3.35 / 2 + 2.1 / 2);
    expect(bed.position.x).toBeCloseTo(-3.66 / 2 + 1.6 / 2); // clamped into the corner
  });

  it("puts a wall item on the requested wall at its fraction", () => {
    run([add("Art", "frame", { kind: "wall", wall: "east", along: 0.25 })]);
    const art = byName("Art");
    expect(art.mount).toBe("wall");
    expect(art.rotationY).toBeCloseTo(-Math.PI / 2);
    expect(art.position.x).toBeCloseTo(3.66 / 2 - 0.02);
    expect(art.position.z).toBeCloseTo(-3.35 / 2 + 0.25 * 3.35);
  });

  it("places in a corner", () => {
    run([add("Box", "box", { kind: "corner", corner: "se" })]);
    const box = byName("Box");
    expect(box.position.x).toBeCloseTo(3.66 / 2 - 0.25);
    expect(box.position.z).toBeCloseTo(3.35 / 2 - 0.25);
  });

  it("places at a point and at the center", () => {
    run([add("A", "box", { kind: "at", x: 1, z: -0.5 }), add("B", "box", { kind: "at", x: 99, z: 0 }), add("C", "box", { kind: "center" })]);
    expect(byName("A").position).toMatchObject({ x: 1, y: 0, z: -0.5 });
    expect(byName("B").position.x).toBeCloseTo(3.66 / 2 - 0.25); // kept inside the room
    expect(byName("C").position).toMatchObject({ x: 0, z: 0 });
  });

  it("keeps the item but reports a placement it couldn't do", () => {
    const out = run([add("Box", "box", { kind: "onTop", targetId: "nope" })]);
    expect(out.results[0]).toMatchObject({ ok: true, label: "Added Box" });
    expect(out.results[0]).toMatchObject({ status: "adjusted" });
    expect(out.results[0].error).toBeUndefined();
    expect(out.results[0].note).toMatch(/couldn't find "nope"/);
    expect(S().items).toHaveLength(1);
  });
});

describe("stacking (onTop)", () => {
  it("adds a desk and a monitor on it in one reply, as one undo step", () => {
    const out = run([add("Desk", "desk", { kind: "wall", wall: "west" }, "desk1"), monitor({ kind: "onTop", targetId: "desk1" })]);
    expect(out.results.map((r) => r.label)).toEqual(["Added Desk · west wall", "Added Monitor · on Desk"]);
    const desk = byName("Desk");
    const mon = byName("Monitor");
    expect(mon.supportId).toBe(desk.id);
    expect(mon.mount).toBe("floor");
    expect(mon.position.y).toBeCloseTo(0.75);
    // The desk stands against the west wall: the monitor goes to its back edge (toward the wall), still on it.
    expect(mon.position.x).toBeCloseTo(desk.position.x - (0.6 / 2 - 0.2 / 2 - 0.02));
    expect(mon.position.z).toBeCloseTo(desk.position.z);
    expect(mon.rotationY).toBeCloseTo(desk.rotationY); // faces the same way as the desk
    expect(S().past).toHaveLength(1);
    expect(out.step).not.toBeNull();
    S().undo();
    expect(S().items).toHaveLength(0);
  });

  it("puts an existing item on another by id", () => {
    run([add("Desk", "desk", { kind: "center" }), monitor({ kind: "corner", corner: "nw" })]);
    const desk = byName("Desk");
    const mon = byName("Monitor");
    const out = run([{ type: "move", itemId: mon.id, placement: { kind: "onTop", targetId: desk.id } }]);
    expect(out.results[0]).toMatchObject({ ok: true, label: "Moved Monitor → on Desk" });
    expect(byName("Monitor")).toMatchObject({ supportId: desk.id, position: { y: expect.closeTo(0.75) } });
  });

  it("refuses cycles and self-stacking", () => {
    run([add("Desk", "desk", { kind: "center" }, "d"), monitor({ kind: "onTop", targetId: "d" })]);
    const desk = byName("Desk");
    const mon = byName("Monitor");
    const out = run([
      { type: "move", itemId: desk.id, placement: { kind: "onTop", targetId: mon.id } },
      { type: "move", itemId: desk.id, placement: { kind: "onTop", targetId: desk.id } },
    ]);
    expect(out.results.map((r) => r.ok)).toEqual([false, false]);
    expect(out.results[0].error).toMatch(/resting on it/);
    expect(out.results[1].error).toMatch(/itself/);
    expect(byName("Desk").supportId).toBeUndefined();
    expect(out.step).toBeNull();
  });

  it("won't stack on a hidden or wall item", () => {
    run([add("Art", "frame"), add("Box", "box")]);
    S().updateItem(byName("Box").id, { hidden: true });
    run([add("Cube", "box")]);
    const out = run([
      { type: "move", itemId: byName("Cube").id, placement: { kind: "onTop", targetId: byName("Art").id } },
      { type: "move", itemId: byName("Cube").id, placement: { kind: "onTop", targetId: byName("Box").id } },
    ]);
    expect(out.results.map((r) => r.ok)).toEqual([false, false]);
    expect(out.results[0].error).toMatch(/isn't standing on the floor/);
    expect(out.results[1].error).toMatch(/hidden/);
  });

  it("spreads a second item out on the same surface instead of overlapping", () => {
    run([
      add("Desk", "desk", { kind: "center" }, "d"),
      monitor({ kind: "onTop", targetId: "d" }),
      { type: "addShape", name: "Desk lamp", preset: "cylinder", dims: { w: 0.15, h: 0.45, d: 0.15 }, placement: { kind: "onTop", targetId: "d" } },
    ]);
    const desk = byName("Desk");
    const mon = byName("Monitor");
    const lamp = byName("Desk lamp");
    expect(lamp.supportId).toBe(desk.id);
    expect(lamp.position.y).toBeCloseTo(0.75);
    expect(footprintsOverlap(lamp, mon)).toBe(false);
    // still on the desk top
    expect(Math.abs(lamp.position.x - desk.position.x)).toBeLessThanOrEqual(desk.dims.w / 2);
  });

  it("moving an item elsewhere takes it off its support", () => {
    run([add("Desk", "desk", { kind: "center" }, "d"), monitor({ kind: "onTop", targetId: "d" })]);
    run([{ type: "move", itemId: byName("Monitor").id, placement: { kind: "corner", corner: "ne" } }]);
    const mon = byName("Monitor");
    expect(mon.supportId).toBeUndefined();
    expect(mon.position.y).toBe(0);
    expect(mon.position.x).toBeCloseTo(3.66 / 2 - 0.3);
  });
});

describe("nextTo", () => {
  it("puts an item on the target's right (its own point of view) with a gap, matching its rotation", () => {
    run([add("Bed", "bed", { kind: "center" })]);
    const out = run([{ type: "addShape", name: "Nightstand", preset: "box", dims: { w: 0.5, h: 0.6, d: 0.4 }, placement: { kind: "nextTo", targetId: byName("Bed").id, side: "right", gap: 0.05 } }]);
    expect(out.results[0].label).toBe("Added Nightstand · right of Bed");
    const ns = byName("Nightstand");
    // Facing +z, the bed's right is −x.
    expect(ns.position.x).toBeCloseTo(-(0.8 + 0.05 + 0.25));
    expect(ns.position.z).toBeCloseTo(0);
    expect(ns.rotationY).toBeCloseTo(0);
  });

  it("follows the target's rotation; in front of it, it faces the target", () => {
    run([add("Bed", "bed", { kind: "center" })]);
    S().updateItem(byName("Bed").id, { rotationY: Math.PI / 2 });
    run([{ type: "addShape", name: "Stool", preset: "box", dims: { w: 0.3, h: 0.4, d: 0.3 }, placement: { kind: "nextTo", targetId: byName("Bed").id, side: "front", gap: 0.1 } }]);
    const stool = byName("Stool");
    // Turned +90°, the bed's front (+z) points to +x; the stool there turns to face the bed (−x).
    expect(stool.position.x).toBeCloseTo(2.1 / 2 + 0.1 + 0.15);
    expect(stool.position.z).toBeCloseTo(0);
    expect(stool.rotationY).toBeCloseTo(-Math.PI / 2);
    run([{ type: "addShape", name: "Side table", preset: "box", dims: { w: 0.3, h: 0.4, d: 0.3 }, placement: { kind: "nextTo", targetId: byName("Bed").id, side: "left" } }]);
    expect(byName("Side table").rotationY).toBeCloseTo(Math.PI / 2); // beside it: same way as the bed
  });

  it("without a side, picks a side that is free and inside the room", () => {
    run([add("Bed", "bed", { kind: "wall", wall: "west", along: 0.5 })]);
    // Against the west wall the bed faces +x; its right (−z side after rotation) and left are both open.
    run([add("Chair", "box", { kind: "nextTo", targetId: byName("Bed").id })]);
    const bed = byName("Bed");
    const chair = byName("Chair");
    expect(footprintsOverlap(chair, bed)).toBe(false);
    expect(Math.abs(chair.position.z - bed.position.z)).toBeCloseTo(0.8 + 0.05 + 0.25);
  });

  it("next to something on a desk goes on the same desk", () => {
    run([add("Desk", "desk", { kind: "center" }, "d"), monitor({ kind: "onTop", targetId: "d" })]);
    run([{ type: "addShape", name: "Lamp", preset: "cylinder", dims: { w: 0.15, h: 0.4, d: 0.15 }, placement: { kind: "nextTo", targetId: byName("Monitor").id } }]);
    const lamp = byName("Lamp");
    expect(lamp.supportId).toBe(byName("Desk").id);
    expect(lamp.position.y).toBeCloseTo(0.75);
    expect(footprintsOverlap(lamp, byName("Monitor"))).toBe(false);
  });
});

describe("edits", () => {
  it("rotates relative by default, absolute with relative:false; wall items refuse", () => {
    run([add("Box", "box"), add("Art", "frame")]);
    const box = byName("Box").id;
    run([{ type: "rotate", itemId: box, degrees: 90 }]);
    expect(byName("Box").rotationY).toBeCloseTo(Math.PI / 2);
    run([{ type: "rotate", itemId: box, degrees: 45, relative: false }]);
    expect(byName("Box").rotationY).toBeCloseTo(Math.PI / 4);
    const out = run([{ type: "rotate", itemId: byName("Art").id, degrees: 90 }]);
    expect(out.results[0]).toMatchObject({ ok: false });
  });

  it("resizes (partial, clamped), recolors, renames, removes", () => {
    run([add("Desk", "desk")]);
    const id = byName("Desk").id;
    const out = run([
      { type: "resize", itemId: id, dims: { w: 1.22 } },
      { type: "recolor", itemId: id, color: "#FF0000" },
      { type: "recolor", itemId: id, color: "reddish" },
      { type: "rename", itemId: id, name: "Big desk" },
    ]);
    expect(out.results.map((r) => r.ok)).toEqual([true, true, false, true]);
    expect(out.results[0].label).toMatch(/^Resized Desk → /);
    expect(out.results[2].error).toMatch(/isn't a color/);
    const desk = S().items.find((it) => it.id === id)!;
    expect(desk.dims).toEqual({ w: 1.22, h: 0.75, d: 0.6 });
    expect(desk.color).toBe("#ff0000");
    expect(desk.name).toBe("Big desk");
    expect(S().past).toHaveLength(2); // add + this turn
    run([{ type: "remove", itemId: id }]);
    expect(S().items).toHaveLength(0);
  });

  it("respects locks for move / rotate / resize", () => {
    run([add("Box", "box")]);
    S().updateItem(byName("Box").id, { locked: true });
    const id = byName("Box").id;
    const out = run([
      { type: "move", itemId: id, placement: { kind: "center" } },
      { type: "rotate", itemId: id, degrees: 90 },
      { type: "resize", itemId: id, dims: { w: 1 } },
      { type: "recolor", itemId: id, color: "#000000" },
    ]);
    expect(out.results.map((r) => r.ok)).toEqual([false, false, false, true]);
    expect(out.results[0].error).toMatch(/locked/);
  });

  it("duplicates with a ref and a placement", () => {
    run([add("Chair", "box", { kind: "corner", corner: "nw" })]);
    const out = run([
      { type: "duplicate", itemId: byName("Chair").id, ref: "c2", placement: { kind: "corner", corner: "ne" } },
      { type: "recolor", itemId: "c2", color: "#00ff00" },
    ]);
    expect(out.results.every((r) => r.ok)).toBe(true);
    const copy = byName("Chair (copy)");
    expect(copy.color).toBe("#00ff00");
    expect(copy.position.x).toBeCloseTo(3.66 / 2 - 0.25);
  });

  it("changes the room (clamped) with a readable label", () => {
    const out = run([{ type: "setRoom", patch: { width: 3.66, depth: 99, height: 2.44, wallColor: "#fff", floorColor: "nope" } }]);
    expect(out.results[0]).toMatchObject({ ok: true, label: "Room → 3.66 m × 15.00 m, 2.44 m ceiling, wall color" });
    expect(S().room).toMatchObject({ width: 3.66, depth: 15, height: 2.44, wallColor: "#ffffff", floorColor: "#b89874" });
    const bad = run([{ type: "setRoom", patch: { floorColor: "nope" } }]);
    expect(bad.results[0].ok).toBe(false);
  });

  it("selects items and moves the camera without an undo step", () => {
    run([add("Box", "box")]);
    S().select(null);
    const camera = vi.fn();
    const pastBefore = S().past.length;
    const out = run([{ type: "select", itemId: byName("Box").id }, { type: "camera", preset: "top" }], { camera });
    expect(out.results.map((r) => r.label)).toEqual(["Selected Box", "Top view"]);
    expect(S().selectedId).toBe(byName("Box").id);
    expect(camera).toHaveBeenCalledWith("top");
    expect(out.step).toBeNull();
    expect(S().past).toHaveLength(pastBefore);
  });
});

describe("references", () => {
  it("resolves refs, ids and (as a fallback) names, most recent first", () => {
    run([add("Box", "box"), add("Box", "box")]);
    const [first, second] = S().items;
    const out = run([{ type: "recolor", itemId: "box", color: "#123456" }]);
    expect(out.results[0].ok).toBe(true);
    expect(S().items.find((i) => i.id === second.id)!.color).toBe("#123456");
    expect(S().items.find((i) => i.id === first.id)!.color).not.toBe("#123456");
  });

  it("reports unknown items as failed chips and still applies the rest", () => {
    const out = run([{ type: "remove", itemId: "ghost" }, add("Box", "box")]);
    expect(out.results).toEqual([
      expect.objectContaining({ ok: false, label: "Remove", error: 'couldn\'t find "ghost"' }),
      expect.objectContaining({ ok: true, label: "Added Box" }),
    ]);
    expect(S().items).toHaveLength(1);
  });

  it("caps the number of actions", () => {
    const many: ChatAction[] = Array.from({ length: 40 }, (_, i) => add(`B${i}`, "box"));
    const out = run(many);
    expect(out.results).toHaveLength(X.MAX_ACTIONS);
    expect(S().items).toHaveLength(X.MAX_ACTIONS);
  });

  it("survives junk actions", () => {
    const out = run([{ type: "explode" } as never, null as never, { type: "move", itemId: "x", placement: { kind: "warp" } } as never]);
    expect(out.results.every((r) => !r.ok)).toBe(true);
    expect(out.step).toBeNull();
  });
});

describe("search and results", () => {
  const results = [candidate("p1", "Paper lantern", { mount: "ceiling", dims: { w: 0.4, h: 0.5, d: 0.4 } }), candidate("p2", "Desk lamp")];

  it("hands searches back to the caller with forItemId resolved, without touching the plan", () => {
    run([add("Lamp", "pendant", undefined, "l")]);
    const lampId = byName("Lamp").id;
    const out = run([{ type: "search", query: "  japanese hanging lamp ", maxPrice: 200, forItemId: "Lamp" }]);
    expect(out.searches).toEqual([{ type: "search", query: "japanese hanging lamp", maxPrice: 200, forItemId: lampId }]);
    expect(out.results[0]).toMatchObject({ ok: true, label: "Searching for “japanese hanging lamp”" });
    expect(out.step).toBeNull();
  });

  it("adds a result by index, placed on a surface", () => {
    run([add("Desk", "desk", { kind: "center" })]);
    const out = run([{ type: "addCandidate", index: 1, placement: { kind: "onTop", targetId: byName("Desk").id } }], { lastResults: results });
    expect(out.results[0]).toMatchObject({ ok: true, label: "Added Desk lamp · on Desk" });
    const lamp = byName("Desk lamp");
    expect(lamp.origin).toBe("product");
    expect(lamp.product?.id).toBe("p2");
    expect(lamp.supportId).toBe(byName("Desk").id);
    expect(S().selectedId).toBe(lamp.id);
  });

  it("previews and replaces; bad indexes fail", () => {
    run([add("Placeholder", "pendant")]);
    const ph = byName("Placeholder").id;
    const out = run(
      [
        { type: "previewCandidate", index: 0 },
        { type: "addCandidate", index: 0, replaceItemId: ph },
        { type: "addCandidate", index: 5 },
      ],
      { lastResults: results },
    );
    expect(out.results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(out.results[1].label).toBe("Replaced Placeholder with Paper lantern");
    expect(out.results[2].error).toMatch(/only 2 results/);
    expect(S().items.map((i) => i.name)).toEqual(["Paper lantern"]);
    const none = run([{ type: "addCandidate", index: 0 }]);
    expect(none.results[0].error).toMatch(/no search results/);
  });
});

describe("undo", () => {
  it("undo actions undo earlier turns and aren't collapsed into this one", () => {
    run([add("A", "box")]);
    run([add("B", "box")]);
    const out = run([{ type: "undo" }]);
    expect(out.results[0]).toMatchObject({ ok: true, label: "Undid 1 change" });
    expect(S().items.map((i) => i.name)).toEqual(["A"]);
    expect(S().future).toHaveLength(1);
    const two = run([{ type: "undo", steps: 5 }]);
    expect(two.results[0].label).toBe("Undid 1 change");
    expect(run([{ type: "undo" }]).results[0]).toMatchObject({ ok: false, error: "nothing to undo" });
  });

  it("a mixed turn undoes first, then applies the rest as one step", () => {
    run([add("A", "box")]);
    const out = run([add("B", "box"), { type: "undo" }]);
    expect(out.results.map((r) => r.label)).toEqual(["Added B", "Undid 1 change"]);
    expect(S().items.map((i) => i.name)).toEqual(["B"]);
    expect(S().past).toHaveLength(1);
  });

  it("'Undo this' reverts exactly the turn, then offers redo", () => {
    run([add("A", "box")]);
    const turn = run([add("Desk", "desk", undefined, "d"), monitor({ kind: "onTop", targetId: "d" }), { type: "setRoom", patch: { height: 2.7 } }]);
    const step = turn.step!;
    expect(X.turnStatus(step, S())).toEqual({ state: "applied", steps: 1 });
    expect(X.undoTurn(step, usePlanner)).toBe(true);
    expect(S().items.map((i) => i.name)).toEqual(["A"]);
    expect(S().room.height).toBeCloseTo(2.44);
    expect(X.turnStatus(step, S())).toEqual({ state: "undone", canRedo: true });
    expect(X.redoTurn(step, usePlanner)).toBe(true);
    expect(S().items.map((i) => i.name)).toEqual(["A", "Desk", "Monitor"]);
    expect(byName("Monitor").supportId).toBe(byName("Desk").id);
    expect(X.turnStatus(step, S())).toEqual({ state: "applied", steps: 1 });
  });

  it("knows how many later changes an undo would take with it", () => {
    const turn = run([add("A", "box")]);
    run([add("B", "box")]);
    S().updateItem(byName("B").id, { color: "#000000" });
    expect(X.turnStatus(turn.step!, S())).toEqual({ state: "applied", steps: 3 });
    X.undoTurn(turn.step!, usePlanner);
    expect(S().items).toHaveLength(0);
    // Something else happened after undoing: the turn can't be redone from here.
    run([add("C", "box")]);
    expect(X.turnStatus(turn.step!, S()).state).toBe("gone");
    expect(X.redoTurn(turn.step!, usePlanner)).toBe(false);
  });

  it("a turn without plan changes has no undo step", () => {
    expect(run([]).step).toBeNull();
    expect(S().past).toHaveLength(0);
  });
});

describe("normalizeHex", () => {
  it("accepts #rgb / #rrggbb only", () => {
    expect(X.normalizeHex("#ABC")).toBe("#aabbcc");
    expect(X.normalizeHex(" #a1B2c3 ")).toBe("#a1b2c3");
    expect(X.normalizeHex("red")).toBeNull();
    expect(X.normalizeHex("#12345")).toBeNull();
    expect(X.normalizeHex(5)).toBeNull();
  });
});

// ---------- review round 3 ----------

const overlapsAny = (it: PlacedItem) => S().items.some((o) => o.id !== it.id && !o.hidden && o.id !== it.supportId && it.id !== o.supportId && footprintsOverlap(it, o));

describe("surfaces: size rule and several items on one surface", () => {
  it("refuses to put a bed or a loaded desk on a nightstand, with the reason on a muted chip", () => {
    run([add("Desk", "desk", { kind: "wall", wall: "north" }, "d"), monitor({ kind: "onTop", targetId: "d" }), { type: "addShape", ref: "ns", name: "Nightstand", preset: "box", dims: { w: 0.5, h: 0.6, d: 0.4 }, placement: { kind: "corner", corner: "sw" } }]);
    run([add("Bed", "bed")]);
    const ns = byName("Nightstand").id;
    const out = run([
      { type: "move", itemId: byName("Bed").id, placement: { kind: "onTop", targetId: ns } },
      { type: "move", itemId: byName("Desk").id, placement: { kind: "onTop", targetId: ns } },
    ]);
    expect(out.results.map((r) => [r.ok, r.error])).toEqual([
      [false, "Bed is too big to go on Nightstand"],
      [false, "Desk is too big to go on Nightstand"],
    ]);
    expect(byName("Bed").supportId).toBeUndefined();
    expect(byName("Desk").position.y).toBe(0);
  });

  it("a second item on a desk goes beside the first; when there's no free spot the desk's items are re-packed", () => {
    run([add("Desk", "desk", { kind: "wall", wall: "west" }, "d"), { type: "addShape", name: "Table lamp", preset: "cylinder", dims: { w: 0.3, h: 0.5, d: 0.3 }, placement: { kind: "onTop", targetId: "d" } }]);
    const out = run([monitor({ kind: "onTop", targetId: byName("Desk").id })]);
    const lamp = byName("Table lamp");
    const mon = byName("Monitor");
    expect(mon.supportId).toBe(byName("Desk").id);
    expect(lamp.supportId).toBe(byName("Desk").id);
    expect(footprintsOverlap(lamp, mon)).toBe(false);
    expect(out.results[0].ok).toBe(true);
    // A third, wide item: the 1.2 m desk can't hold all three side by side → it goes beside the desk (on the floor,
    // clear of everything) and the partial chip says why; nothing on the desk moved.
    const before = { lamp: byName("Table lamp").position, mon: byName("Monitor").position };
    const full = run([{ type: "addShape", name: "Box", preset: "box", dims: { w: 0.5, h: 0.3, d: 0.5 }, placement: { kind: "onTop", targetId: byName("Desk").id } }]);
    expect(full.results[0]).toMatchObject({ ok: true, label: "Added Box · next to Desk" });
    expect(full.results[0].note).toMatch(/no room left on Desk \(.*\), so it's beside it/);
    const box = byName("Box");
    expect(box.supportId).toBeUndefined();
    expect(box.position.y).toBe(0);
    expect(overlapsAny(box)).toBe(false);
    expect(byName("Table lamp").position).toEqual(before.lamp);
    expect(byName("Monitor").position).toEqual(before.mon);
  });

  it("moving an existing item onto a full surface fails and leaves it where it was (no empty undo step)", () => {
    run([add("Desk", "desk", { kind: "wall", wall: "north" }, "d")]);
    run([{ type: "addShape", name: "Monitor", preset: "box", dims: { w: 0.6, h: 0.4, d: 0.2 }, placement: { kind: "onTop", targetId: byName("Desk").id } }]);
    run([{ type: "addShape", name: "Table lamp", preset: "box", dims: { w: 0.3, h: 0.5, d: 0.3 }, placement: { kind: "onTop", targetId: byName("Desk").id } }]);
    run([add("Plant", "box", { kind: "corner", corner: "se" })]);
    const plant = byName("Plant");
    const past = S().past.length;
    const out = run([{ type: "move", itemId: plant.id, placement: { kind: "onTop", targetId: byName("Desk").id } }]);
    expect(out.results[0]).toMatchObject({ ok: false, label: "Move" });
    expect(out.results[0].error).toMatch(/no room left on Desk/);
    expect(byName("Plant")).toEqual(plant);
    expect(out.step).toBeNull();
    expect(S().past.length).toBe(past);
  });

  it("re-packs siblings along the width when the new item fits only that way", () => {
    // Lamp in the middle of the desk: a 0.6 m monitor can't fit left or right of it without moving it.
    run([add("Desk", "desk", { kind: "center" }, "d"), { type: "addShape", name: "Table lamp", preset: "cylinder", dims: { w: 0.3, h: 0.5, d: 0.6 }, placement: { kind: "onTop", targetId: "d" } }]);
    const out = run([{ type: "addShape", name: "Speaker bar", preset: "box", dims: { w: 0.8, h: 0.1, d: 0.6 }, placement: { kind: "onTop", targetId: byName("Desk").id } }]);
    const lamp = byName("Table lamp");
    const bar = byName("Speaker bar");
    expect(footprintsOverlap(lamp, bar)).toBe(false);
    expect(lamp.supportId).toBe(byName("Desk").id);
    expect(out.results[0].note).toMatch(/moved Table lamp aside/);
  });
});

describe("free spots for wall / corner / nextTo placements", () => {
  it("an explicit along that is taken shifts to the nearest free stretch (the model always sends along)", () => {
    run([add("Bed", "bed", { kind: "wall", wall: "north", along: 0.5 })]);
    const out = run([{ type: "addShape", name: "Dresser", preset: "box", dims: { w: 0.8, h: 0.8, d: 0.5 }, placement: { kind: "wall", wall: "north", along: 0.5 } }]);
    expect(overlapsAny(byName("Dresser"))).toBe(false);
    expect(out.results[0].note).toMatch(/shifted .* to avoid Bed/);
    // No stretch of that wall is wide enough: it stays where asked and the chip says what it overlaps.
    const full = run([{ type: "addShape", name: "Wide dresser", preset: "box", dims: { w: 1.4, h: 0.8, d: 0.5 }, placement: { kind: "wall", wall: "north", along: 0.5 } }]);
    expect(full.results[0].note).toMatch(/no free spot on the north wall: overlaps/);
  });

  it("wall art doesn't cover the window", () => {
    // Default room: a window in the north wall, x -0.6..0.6, 0.9..2.1 high.
    run([add("Art", "frame", { kind: "wall", wall: "north", along: 0.5 })]);
    const art = byName("Art");
    expect(Math.abs(art.position.x)).toBeGreaterThan(0.6 + art.dims.w / 2 - 0.01);
  });

  it("a taken corner slides along a wall; floor items in a south corner turn to face the room", () => {
    run([{ type: "addShape", name: "Armchair", preset: "box", dims: { w: 0.8, h: 0.9, d: 0.8 }, placement: { kind: "corner", corner: "se" } }]);
    const chair = byName("Armchair");
    // Faces diagonally out of the corner (toward the room center: −x, −z).
    expect(Math.sin(chair.rotationY)).toBeLessThan(-0.5);
    expect(Math.cos(chair.rotationY)).toBeLessThan(-0.5);
    const out = run([{ type: "addShape", name: "Floor lamp", preset: "cylinder", dims: { w: 0.4, h: 1.6, d: 0.4 }, placement: { kind: "corner", corner: "se" } }]);
    expect(overlapsAny(byName("Floor lamp"))).toBe(false);
    expect(out.results[0].note).toMatch(/corner was taken by Armchair/);
    // A dresser in a south corner stands with its back to the south wall.
    run([{ type: "addShape", name: "Dresser", preset: "box", dims: { w: 1.0, h: 0.8, d: 0.5 }, placement: { kind: "corner", corner: "sw" } }]);
    expect(Math.cos(byName("Dresser").rotationY)).toBeCloseTo(-1);
  });

  it("nextTo tries the asked side first, then the other sides, and says so", () => {
    run([add("Bed", "bed", { kind: "wall", wall: "north" }, "b"), { type: "addShape", name: "Lamp", preset: "cylinder", dims: { w: 0.3, h: 1.5, d: 0.3 }, placement: { kind: "nextTo", targetId: "b", side: "right" } }]);
    const out = run([{ type: "addShape", name: "Nightstand", preset: "box", dims: { w: 0.5, h: 0.6, d: 0.4 }, placement: { kind: "nextTo", targetId: byName("Bed").id, side: "right" } }]);
    expect(overlapsAny(byName("Nightstand"))).toBe(false);
    expect(out.results[0].note).toMatch(/right side was taken by Lamp, so it went on the left/);
  });

  it("beside a bed against a wall, a nightstand lines up with the headboard", () => {
    run([add("Bed", "bed", { kind: "wall", wall: "north" }, "b"), { type: "addShape", name: "Nightstand", preset: "box", dims: { w: 0.5, h: 0.6, d: 0.4 }, placement: { kind: "nextTo", targetId: "b", side: "left" } }]);
    const bed = byName("Bed");
    const ns = byName("Nightstand");
    expect(ns.position.z - ns.dims.d / 2).toBeCloseTo(bed.position.z - bed.dims.d / 2); // backs flush
  });

  it("a chair in front of a desk faces the desk", () => {
    run([add("Desk", "desk", { kind: "wall", wall: "west" }, "d"), { type: "addShape", name: "Office chair", preset: "box", dims: { w: 0.6, h: 1, d: 0.6 }, placement: { kind: "nextTo", targetId: "d", side: "front" } }]);
    const chair = byName("Office chair");
    const desk = byName("Desk");
    // Front (+z rotated) points from the chair toward the desk (−x).
    expect(Math.sin(chair.rotationY)).toBeCloseTo(-1);
    expect(chair.position.x).toBeGreaterThan(desk.position.x);
  });

  it("an added item with no free spot left says what it overlaps", () => {
    usePlanner.setState({ room: { ...defaultRoom(), width: 1.6, depth: 2.2, openings: [] } });
    run([add("Bed", "bed")]);
    const out = run([add("Desk", "desk")]);
    expect(out.results[0].note).toMatch(/no free space: overlaps Bed/);
  });
});

describe("moving stacked items", () => {
  it("an at / center point still over the desk keeps the monitor on the desk", () => {
    run([add("Desk", "desk", { kind: "center" }, "d"), monitor({ kind: "onTop", targetId: "d" })]);
    const desk = byName("Desk");
    run([{ type: "move", itemId: byName("Monitor").id, placement: { kind: "at", x: 0.3, z: 0.1 } }]);
    expect(byName("Monitor")).toMatchObject({ supportId: desk.id, position: { y: 0.75 } });
    expect(byName("Monitor").position.x).toBeCloseTo(0.3);
    // Off the desk: it goes to the floor there.
    run([{ type: "move", itemId: byName("Monitor").id, placement: { kind: "at", x: 1.2, z: 1 } }]);
    expect(byName("Monitor").supportId).toBeUndefined();
    expect(byName("Monitor").position.y).toBe(0);
  });
});

describe("selection follows the conversation", () => {
  it("move / rotate / resize / recolor select the item, so the next 'it' means it", () => {
    run([add("Desk", "desk", { kind: "wall", wall: "west" }, "d"), monitor({ kind: "onTop", targetId: "d" })]);
    expect(S().selectedId).toBe(byName("Monitor").id);
    run([{ type: "rotate", itemId: byName("Desk").id, degrees: 45, relative: true }]);
    expect(S().selectedId).toBe(byName("Desk").id);
    run([{ type: "recolor", itemId: byName("Monitor").id, color: "#ff0000" }]);
    expect(S().selectedId).toBe(byName("Monitor").id);
    run([{ type: "remove", itemId: byName("Monitor").id }]);
    expect(S().selectedId).not.toBe("gone");
  });
});

describe("hide / mount / height / doors and windows", () => {
  it("hides and shows an item", () => {
    run([add("Dresser", "box")]);
    const id = byName("Dresser").id;
    expect(run([{ type: "setHidden", itemId: id, hidden: true }]).results[0].label).toBe("Hid Dresser");
    expect(byName("Dresser").hidden).toBe(true);
    run([{ type: "setHidden", itemId: id, hidden: false }]);
    expect(byName("Dresser").hidden).toBe(false);
  });

  it("hangs a mirror on the wall, then at a height; floor and ceiling items can't take a height", () => {
    run([{ type: "addShape", name: "Mirror", preset: "box", dims: { w: 0.6, h: 0.9, d: 0.03 } }]);
    const id = byName("Mirror").id;
    const out = run([
      { type: "setMount", itemId: id, mount: "wall" },
      { type: "setHeight", itemId: id, bottom: 1.2 },
    ]);
    expect(out.results.map((r) => r.ok)).toEqual([true, true]);
    expect(byName("Mirror")).toMatchObject({ mount: "wall", position: { y: 1.2 } });
    run([add("Box", "box")]);
    expect(run([{ type: "setHeight", itemId: byName("Box").id, bottom: 1 }]).results[0]).toMatchObject({ ok: false });
  });

  it("adds, moves and removes a window", () => {
    const n = S().room.openings.length;
    const out = run([{ type: "setOpening", op: "add", kind: "window", wall: "east", width: 1 }]);
    expect(out.results[0].label).toMatch(/Added window · east wall/);
    const win = S().room.openings[n];
    expect(win).toMatchObject({ kind: "window", wall: "east", width: 1, sill: 0.9 });
    expect(win.offset).toBeCloseTo(S().room.depth / 2);
    run([{ type: "setOpening", op: "update", openingId: win.id, offset: 1 }]);
    expect(S().room.openings[n].offset).toBe(1);
    run([{ type: "setOpening", op: "remove", openingId: win.id }]);
    expect(S().room.openings).toHaveLength(n);
    expect(run([{ type: "setOpening", op: "remove", openingId: "nope" }]).results[0].ok).toBe(false);
  });
});

describe("addCandidate", () => {
  it("replacing an item with a placement puts the product there", () => {
    run([add("Placeholder", "box", { kind: "center" }), add("Desk", "desk", { kind: "wall", wall: "west" })]);
    const c = candidate("c1", "Akari lamp");
    const out = run([{ type: "addCandidate", index: 0, replaceItemId: byName("Placeholder").id, placement: { kind: "onTop", targetId: byName("Desk").id } }], { lastResults: [c] });
    expect(out.results[0]).toMatchObject({ ok: true, label: "Replaced Placeholder with Akari lamp · on Desk" });
    expect(byName("Akari lamp").supportId).toBe(byName("Desk").id);
    expect(S().items.some((i) => i.name === "Placeholder")).toBe(false);
  });
});

describe("turnStatus after toolbar undos", () => {
  it("turns undone with several toolbar undos all read as undone; only the newest can be redone from here", () => {
    const t1 = run([add("A", "box")]);
    const t2 = run([add("B", "box")]);
    const t3 = run([add("C", "box")]);
    S().undo();
    S().undo();
    S().undo();
    expect(X.turnStatus(t1.step!, S())).toEqual({ state: "undone", canRedo: true });
    expect(X.turnStatus(t2.step!, S())).toEqual({ state: "undone", canRedo: false });
    expect(X.turnStatus(t3.step!, S())).toEqual({ state: "undone", canRedo: false });
    S().redo();
    expect(X.turnStatus(t1.step!, S())).toEqual({ state: "applied", steps: 1 });
    expect(X.turnStatus(t2.step!, S())).toEqual({ state: "undone", canRedo: true });
  });
});

describe("review round 4: taking things down", () => {
  const stackUp = () => {
    run([add("Desk", "desk", { kind: "wall", wall: "north" }, "d")]);
    run([{ type: "addShape", ref: "b", name: "Box", preset: "box", dims: { w: 0.4, h: 0.3, d: 0.4 }, placement: { kind: "onTop", targetId: byName("Desk").id } }]);
    run([{ type: "addShape", name: "Table lamp", preset: "cylinder", dims: { w: 0.3, h: 0.5, d: 0.3 }, placement: { kind: "onTop", targetId: byName("Box").id } }]);
  };

  it("the floor placement takes an item off a stack to the floor in front of it, whatever the stack stands on", () => {
    stackUp();
    const out = run([{ type: "move", itemId: byName("Table lamp").id, placement: { kind: "floor" } }]);
    expect(out.results[0]).toMatchObject({ ok: true, label: "Moved Table lamp → on the floor" });
    const lamp = byName("Table lamp");
    const desk = byName("Desk");
    expect(lamp.supportId).toBeUndefined();
    expect(lamp.position.y).toBe(0);
    expect(pointInFootprintOf(lamp, desk)).toBe(false);
    expect(overlapsAny(lamp)).toBe(false);
  });

  it('setMount "floor" on a stacked item takes it down instead of saying "already"', () => {
    stackUp();
    const out = run([{ type: "setMount", itemId: byName("Table lamp").id, mount: "floor" }]);
    expect(out.results[0]).toMatchObject({ ok: true, label: "Table lamp now stands on the floor" });
    expect(byName("Table lamp").supportId).toBeUndefined();
    expect(byName("Table lamp").position.y).toBe(0);
  });

  it("next to the thing it stands on = down from it (not onto what that stands on)", () => {
    run([add("Bed", "bed", { kind: "center" }, "bed")]);
    run([{ type: "addShape", name: "Nightstand", preset: "box", dims: { w: 0.5, h: 0.6, d: 0.4 }, placement: { kind: "onTop", targetId: byName("Bed").id } }]);
    run([{ type: "addShape", name: "Table lamp", preset: "cylinder", dims: { w: 0.3, h: 0.5, d: 0.3 }, placement: { kind: "onTop", targetId: byName("Nightstand").id } }]);
    // The floor all around the nightstand is the bed: no free spot down there, so it stays put (never onto the bed,
    // never into it) and the chip says why.
    const boxed = run([{ type: "move", itemId: byName("Table lamp").id, placement: { kind: "nextTo", targetId: byName("Nightstand").id, side: "front" } }]);
    expect(boxed.results[0]).toMatchObject({ status: "failed" });
    expect(boxed.results[0].error).toMatch(/no free spot next to Nightstand/);
    expect(byName("Table lamp").supportId).toBe(byName("Nightstand").id);
    // With floor in front of it, the lamp comes down there.
    run([{ type: "move", itemId: byName("Nightstand").id, placement: { kind: "floor" } }]);
    run([{ type: "move", itemId: byName("Bed").id, placement: { kind: "wall", wall: "north" } }]);
    run([{ type: "move", itemId: byName("Table lamp").id, placement: { kind: "nextTo", targetId: byName("Nightstand").id, side: "front" } }]);
    expect(byName("Table lamp").supportId).toBeUndefined();
    expect(byName("Table lamp").position.y).toBe(0);
  });

  it("the floor placement on a hanging item brings it down to the floor", () => {
    run([add("Pendant", "pendant", { kind: "center" })]);
    run([{ type: "move", itemId: byName("Pendant").id, placement: { kind: "floor" } }]);
    expect(byName("Pendant")).toMatchObject({ mount: "floor", position: { y: 0 } });
  });
});

const pointInFootprintOf = (it: PlacedItem, of: PlacedItem) =>
  Math.abs(it.position.x - of.position.x) < of.dims.w / 2 && Math.abs(it.position.z - of.position.z) < of.dims.d / 2;
