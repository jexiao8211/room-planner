import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAction, PlacedItem } from "../../shared/types";
import { defaultRoom } from "../../lib/presets";
import { footprintsOverlap } from "../../lib/geometry";
import type { PlannerState } from "../../state/store";
import type * as ExecModule from "./executeActions";
import { buildChatScene } from "./buildScene";
import { chatResponseFrom } from "../../../server/sanitizeChat";

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

const pointInFootprintOf = (p: { x: number; z: number }, of: PlacedItem) => {
  const dx = p.x - of.position.x;
  const dz = p.z - of.position.z;
  const c = Math.cos(of.rotationY);
  const s = Math.sin(of.rotationY);
  return Math.abs(dx * c - dz * s) <= of.dims.w / 2 + 1e-6 && Math.abs(dx * s + dz * c) <= of.dims.d / 2 + 1e-6;
};

// Review round 5: "next to" a target that stands under / on a support, when nothing fits right beside the target.
describe("next to something under a desk or on a cat tower", () => {
  const deskAndBin = () => {
    run([
      { type: "addShape", ref: "desk", name: "Desk", preset: "desk", placement: { kind: "wall", wall: "west" } },
      { type: "addShape", ref: "bin", name: "Bin", preset: "cylinder", dims: { w: 0.25, h: 0.3, d: 0.25 }, placement: { kind: "under", targetId: "desk" } },
    ]);
    const desk = byName("Desk");
    const bin = byName("Bin");
    expect(bin).toMatchObject({ supportId: desk.id, supportSurfaceY: 0 });
    return { desk, bin };
  };

  it("a floor lamp next to the bin under a desk goes on the floor beside the desk (its front), near the bin, with an adjusted chip", () => {
    const { desk, bin } = deskAndBin();
    const [r] = run([{ type: "addShape", name: "Floor lamp", preset: "floorlamp", placement: { kind: "nextTo", targetId: bin.id } }]).results;
    const lamp = byName("Floor lamp");
    expect(r).toMatchObject({ ok: true, status: "adjusted" });
    expect(r.note).toMatch(/beside Desk/);
    expect(lamp.supportId).toBeUndefined();
    expect(lamp.position.y).toBe(0);
    expect(footprintsOverlap(lamp, desk)).toBe(false);
    // In front of the desk (it faces east, into the room), close to the bin.
    expect(lamp.position.x).toBeGreaterThan(desk.position.x + desk.dims.d / 2);
    expect(Math.hypot(lamp.position.x - bin.position.x, lamp.position.z - bin.position.z)).toBeLessThan(0.7);
  });

  it("moving a plant / a box next to the bin works the same way (no failed chip)", () => {
    const { desk, bin } = deskAndBin();
    run([
      { type: "addShape", ref: "plant", name: "Plant", preset: "cylinder", dims: { w: 0.35, h: 0.6, d: 0.35 } },
      { type: "addShape", ref: "box", name: "Box", preset: "box", dims: { w: 0.4, h: 0.3, d: 0.4 } },
    ]);
    const [a] = run([{ type: "move", itemId: byName("Plant").id, placement: { kind: "nextTo", targetId: bin.id } }]).results;
    expect(a.status).not.toBe("failed");
    const [b] = run([{ type: "move", itemId: byName("Box").id, placement: { kind: "nextTo", targetId: bin.id } }]).results;
    expect(b.status).not.toBe("failed");
    for (const name of ["Plant", "Box"]) {
      const it = byName(name);
      expect(footprintsOverlap(it, desk)).toBe(false);
      expect(Math.hypot(it.position.x - bin.position.x, it.position.z - bin.position.z)).toBeLessThan(1);
    }
    expect(footprintsOverlap(byName("Plant"), byName("Box"))).toBe(false);
  });

  it("a bowl next to the cat on the tower's middle level goes beside the tower, not to the middle of the room", () => {
    run([
      { type: "addShape", ref: "tower", name: "Cat tower", preset: "cattower", placement: { kind: "corner", corner: "nw" } },
      { type: "addShape", ref: "cat", name: "Cat", preset: "cat", placement: { kind: "onTop", targetId: "tower", level: "middle" } },
    ]);
    const tower = byName("Cat tower");
    const cat = byName("Cat");
    expect(cat.supportId).toBe(tower.id);
    expect(cat.supportSurfaceY).toBeCloseTo(0.945, 3);
    const [r] = run([{ type: "addShape", name: "Bowl", preset: "cylinder", dims: { w: 0.2, h: 0.08, d: 0.2 }, placement: { kind: "nextTo", targetId: cat.id } }]).results;
    expect(r.status).not.toBe("failed");
    expect(r.label).not.toMatch(/couldn/);
    const bowl = byName("Bowl");
    // Either on the cat's level of the tower, or on the floor right beside the tower: never the room's middle.
    if (bowl.supportId) expect(bowl.supportId).toBe(tower.id);
    else {
      expect(bowl.position.y).toBe(0);
      expect(pointInFootprintOf(bowl.position, tower)).toBe(false);
      expect(Math.hypot(bowl.position.x - tower.position.x, bowl.position.z - tower.position.z)).toBeLessThan(0.8);
    }
  });
});

// Review round 5: the sanitizer kept a hanging item "on / under" a scene item as a fixed spot (the target's position
// when the message was sent), so a pendant put "on the desk" after the same answer moved the desk hung at the old spot.
describe("a hanging lamp put on / under something an earlier step of the same answer moved", () => {
  it("hangs above the desk where the desk ends up; the chip says above Desk", () => {
    run([
      { type: "addShape", ref: "desk", name: "Desk", preset: "desk", placement: { kind: "at", x: -1, z: 0 } },
      { type: "addShape", ref: "pend", name: "Hanging lamp", preset: "pendant", placement: { kind: "at", x: 0.5, z: -0.8 } },
    ]);
    const desk = byName("Desk");
    const pendant = byName("Hanging lamp");
    expect(desk.position.x).toBeCloseTo(-1, 6);
    for (const kind of ["onTop", "under"] as const) {
      const response = chatResponseFrom(
        { reply: "ok", actions: [{ type: "move", itemId: desk.id, placement: { kind: "wall", wall: "east" } }, { type: "move", itemId: pendant.id, placement: { kind, targetId: desk.id } }] },
        buildChatScene(S()),
        false,
      );
      expect(response.actions[1]).toEqual({ type: "move", itemId: pendant.id, placement: { kind, targetId: desk.id } });
      const out = run(response.actions);
      const d = byName("Desk");
      const p = byName("Hanging lamp");
      expect(d.position.x).toBeGreaterThan(1.4);
      expect(p.mount).toBe("ceiling");
      expect(p.position.x).toBeCloseTo(d.position.x, 6);
      expect(p.position.z).toBeCloseTo(d.position.z, 6);
      // "under" is done differently than asked: the chip is adjusted and says it hangs above the desk.
      if (kind === "onTop") expect(out.results[1]).toMatchObject({ status: "ok", label: "Moved Hanging lamp → above Desk" });
      else expect(out.results[1]).toMatchObject({ status: "adjusted", label: "Moved Hanging lamp → under Desk", note: expect.stringMatching(/so it.s above Desk/) });
      // Move the desk back for the next round.
      run([{ type: "move", itemId: d.id, placement: { kind: "at", x: -1, z: 0 } }]);
    }
  });
});

// Review round 5: setMount "ceiling" hung a floor lamp flush, upright, with its base in mid-air.
describe('setMount "ceiling" hangs the item like "hang it from the ceiling"', () => {
  it("a floor lamp becomes a pendant (its shade on a cord), the same as the hang action", () => {
    run([{ type: "addShape", ref: "a", name: "Floor lamp", preset: "floorlamp", placement: { kind: "at", x: -1, z: 0 } }]);
    run([{ type: "addShape", ref: "b", name: "Floor lamp", preset: "floorlamp", placement: { kind: "at", x: 1, z: 0 } }]);
    const [a, b] = S().items.filter((it) => it.name === "Floor lamp");
    const viaMount = run([{ type: "setMount", itemId: a.id, mount: "ceiling" }]).results[0];
    run([{ type: "hang", itemId: b.id }]);
    const hungA = S().items.find((it) => it.id === a.id)!;
    const hungB = S().items.find((it) => it.id === b.id)!;
    expect(viaMount).toMatchObject({ ok: true, status: "ok" });
    expect(viaMount.label).toMatch(/^Hung Floor lamp from the ceiling/);
    expect(hungA.mount).toBe("ceiling");
    expect(hungA.dims).toEqual(hungB.dims);
    expect(hungA.parts).toEqual(hungB.parts);
    expect(hungA.position.y).toBeCloseTo(hungB.position.y, 9);
    // Its bottom hangs at a pendant's height, not ~0.84 m with an upright 1.6 m lamp above it.
    expect(hungA.dims.h).toBeLessThan(1);
    expect(hungA.position.y).toBeGreaterThan(1.2);
  });
});
