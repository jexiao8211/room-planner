import { describe, expect, it } from "vitest";
import type { PlacedItem, Room } from "../shared/types";
import {
  canSupport,
  carryWithSupport,
  constrainToRoom,
  findSupportAt,
  fitsOnTop,
  pointInFootprint,
  settleStacks,
  stackDescendants,
  stackOrder,
  supportTop,
  validSupports,
} from "./geometry";

const room: Room = { name: "T", width: 4, depth: 3, height: 2.5, wallColor: "#ffffff", floorColor: "#000000", openings: [] };

function item(id: string, over: Partial<PlacedItem> = {}): PlacedItem {
  return {
    id,
    name: id,
    position: { x: 0, y: 0, z: 0 },
    rotationY: 0,
    dims: { w: 0.5, h: 0.5, d: 0.5 },
    color: "#888888",
    mount: "floor",
    parts: [],
    origin: "shape",
    ...over,
  };
}

const desk = () => item("desk", { dims: { w: 1.2, h: 0.75, d: 0.6 } });
const monitor = (over: Partial<PlacedItem> = {}) =>
  item("mon", { dims: { w: 0.6, h: 0.4, d: 0.2 }, position: { x: 0, y: 0.75, z: 0 }, supportId: "desk", ...over });
const byId = (items: PlacedItem[], id: string) => items.find((it) => it.id === id)!;

describe("stacking geometry", () => {
  it("supportTop is the support's bottom plus its height", () => {
    expect(supportTop(item("a", { position: { x: 0, y: 0.75, z: 0 }, dims: { w: 1, h: 0.3, d: 1 } }))).toBeCloseTo(1.05);
  });

  it("pointInFootprint uses the rotated footprint", () => {
    const d = desk();
    expect(pointInFootprint({ x: 0.55, z: 0 }, d)).toBe(true);
    expect(pointInFootprint({ x: 0, z: 0.35 }, d)).toBe(false);
    const turned = { ...d, rotationY: Math.PI / 2 };
    expect(pointInFootprint({ x: 0.55, z: 0 }, turned)).toBe(false);
    expect(pointInFootprint({ x: 0, z: 0.55 }, turned)).toBe(true);
  });

  it("fitsOnTop allows up to 1.5x the support's top per axis", () => {
    const d = desk();
    expect(fitsOnTop(item("m", { dims: { w: 1.8, h: 0.1, d: 0.9 } }), d)).toBe(true);
    expect(fitsOnTop(item("m", { dims: { w: 1.9, h: 0.1, d: 0.5 } }), d)).toBe(false);
    expect(fitsOnTop(item("m", { dims: { w: 0.5, h: 0.1, d: 1.0 } }), d)).toBe(false);
    // Turned 90° relative to the desk, a long thin item's width runs along the desk's depth.
    expect(fitsOnTop(item("m", { dims: { w: 1.0, h: 0.1, d: 0.2 }, rotationY: Math.PI / 2 }), d)).toBe(false);
  });

  it("findSupportAt picks the highest valid support under the center", () => {
    const d = desk();
    const riser = item("riser", { dims: { w: 0.5, h: 0.1, d: 0.3 }, position: { x: 0.3, y: 0.75, z: 0 }, supportId: "desk" });
    const box = item("box", { position: { x: 2, y: 0, z: 0 }, dims: { w: 0.3, h: 0.3, d: 0.2 } });
    const items = [d, riser, box];
    expect(findSupportAt(box, { x: 0.3, z: 0 }, items)?.id).toBe("riser");
    expect(findSupportAt(box, { x: -0.4, z: 0 }, items)?.id).toBe("desk");
    expect(findSupportAt(box, { x: 1.5, z: 1 }, items)).toBeNull();
    // maxTop limits to what is below a height (dropping)
    expect(findSupportAt(box, { x: 0.3, z: 0 }, items, 0.8)?.id).toBe("desk");
  });

  it("never uses hidden items, non-floor items, the item itself, or something resting on it as a support", () => {
    const d = desk();
    const mon = monitor();
    expect(findSupportAt(d, { x: 0, z: 0 }, [d, mon])).toBeNull(); // the monitor rests on the desk: no cycle
    expect(canSupport("desk", mon, [d, mon])).toBe(false);
    expect(canSupport("desk", d, [d])).toBe(false);
    const box = item("box", { dims: { w: 0.3, h: 0.3, d: 0.3 } });
    expect(findSupportAt(box, { x: 0, z: 0 }, [{ ...d, hidden: true }, box])).toBeNull();
    expect(findSupportAt(box, { x: 0, z: 0 }, [{ ...d, mount: "ceiling" }, box])).toBeNull();
    expect(findSupportAt({ ...box, mount: "wall" }, { x: 0, z: 0 }, [d, box])).toBeNull();
  });

  it("stackDescendants is transitive and cycle-safe", () => {
    const items = [item("a"), item("b", { supportId: "a" }), item("c", { supportId: "b" }), item("x", { supportId: "y" }), item("y", { supportId: "x" })];
    expect([...stackDescendants(items, "a")].sort()).toEqual(["b", "c"]);
    expect([...stackDescendants(items, "x")]).toEqual(["y"]);
  });

  it("validSupports lists structurally valid supports the item fits on, highest first", () => {
    const d = desk();
    const night = item("night", { dims: { w: 0.5, h: 0.6, d: 0.4 }, position: { x: 1.5, y: 0, z: 0 } });
    const mon = item("mon", { dims: { w: 0.6, h: 0.4, d: 0.2 }, position: { x: -1.5, y: 0, z: 1 } });
    const bed = item("bed", { dims: { w: 1.6, h: 0.5, d: 2 } });
    expect(validSupports(mon, [d, night, mon, bed]).map((s) => s.id)).toEqual(["desk", "night", "bed"]);
    expect(validSupports(bed, [d, night, mon, bed]).map((s) => s.id)).toEqual([]);
  });

  it("carryWithSupport keeps the offset when the support moves", () => {
    const before = desk();
    const after = { ...before, position: { x: 1, y: 0, z: -0.5 } };
    const r = carryWithSupport({ position: { x: 0.3, y: 0.75, z: -0.1 }, rotationY: 0 }, before, after);
    expect(r.position.x).toBeCloseTo(1.3);
    expect(r.position.z).toBeCloseTo(-0.6);
    expect(r.position.y).toBeCloseTo(0.75);
    expect(r.rotationY).toBeCloseTo(0);
  });

  it("carryWithSupport rotates the offset (and the item) around the support", () => {
    const before = desk();
    const after = { ...before, rotationY: Math.PI / 2 };
    // An item 0.4 m to the desk's right (+x) ends up at -z after a +90° turn about +Y (three.js convention).
    const r = carryWithSupport({ position: { x: 0.4, y: 0.75, z: 0 }, rotationY: 0 }, before, after);
    expect(r.position.x).toBeCloseTo(0);
    expect(r.position.z).toBeCloseTo(-0.4);
    expect(r.rotationY).toBeCloseTo(Math.PI / 2);
  });

  it("constrainToRoom keeps a stacked floor item's height but flattens an unstacked one", () => {
    expect(constrainToRoom(monitor(), room).y).toBeCloseTo(0.75);
    expect(constrainToRoom({ ...monitor(), supportId: undefined }, room).y).toBe(0);
  });
});

describe("settleStacks", () => {
  it("carries dependents (transitively) when their support moves", () => {
    const d = desk();
    const mon = monitor({ position: { x: 0.2, y: 0.75, z: 0 } });
    const cup = item("cup", { dims: { w: 0.08, h: 0.1, d: 0.08 }, position: { x: 0.2, y: 1.15, z: 0 }, supportId: "mon" });
    const prev = [d, mon, cup];
    const moved = { ...d, position: { x: -1, y: 0, z: 0.5 } };
    const out = settleStacks(prev, [moved, mon, cup], room, { moved: ["desk"] });
    expect(byId(out, "mon").position).toEqual({ x: expect.closeTo(-0.8), y: expect.closeTo(0.75), z: expect.closeTo(0.5) });
    expect(byId(out, "cup").position).toEqual({ x: expect.closeTo(-0.8), y: expect.closeTo(1.15), z: expect.closeTo(0.5) });
    expect(byId(out, "mon").supportId).toBe("desk");
  });

  it("rotates dependents around a turning support", () => {
    const d = desk();
    const mon = monitor({ position: { x: 0.4, y: 0.75, z: 0 } });
    const out = settleStacks([d, mon], [{ ...d, rotationY: Math.PI / 2 }, mon], room, { moved: ["desk"] });
    const m = byId(out, "mon");
    expect(m.position.x).toBeCloseTo(0);
    expect(m.position.z).toBeCloseTo(-0.4);
    expect(m.rotationY).toBeCloseTo(Math.PI / 2);
  });

  it("re-seats dependents when the support's height changes", () => {
    const d = desk();
    const mon = monitor();
    const out = settleStacks([d, mon], [{ ...d, dims: { ...d.dims, h: 0.9 } }, mon], room);
    expect(byId(out, "mon").position.y).toBeCloseTo(0.9);
  });

  it("drops dependents to the floor when the support is deleted", () => {
    const out = settleStacks([desk(), monitor()], [monitor()], room);
    expect(out[0].position.y).toBe(0);
    expect(out[0].supportId).toBeUndefined();
  });

  it("drops dependents onto whatever is below when a middle support is removed", () => {
    const d = desk();
    const riser = item("riser", { dims: { w: 0.5, h: 0.1, d: 0.3 }, position: { x: 0, y: 0.75, z: 0 }, supportId: "desk" });
    const mon = monitor({ position: { x: 0, y: 0.85, z: 0 }, supportId: "riser" });
    const out = settleStacks([d, riser, mon], [d, mon], room);
    expect(byId(out, "mon").supportId).toBe("desk");
    expect(byId(out, "mon").position.y).toBeCloseTo(0.75);
  });

  it("drops dependents when the support is hidden or stops being a floor item", () => {
    const d = desk();
    const hidden = settleStacks([d, monitor()], [{ ...d, hidden: true }, monitor()], room);
    expect(byId(hidden, "mon").supportId).toBeUndefined();
    expect(byId(hidden, "mon").position.y).toBe(0);
    const ceiling = settleStacks([d, monitor()], [{ ...d, mount: "ceiling" }, monitor()], room);
    expect(byId(ceiling, "mon").supportId).toBeUndefined();
  });

  it("clears supportId when the item itself becomes a wall item", () => {
    const d = desk();
    const out = settleStacks([d, monitor()], [d, monitor({ mount: "wall", position: { x: 0, y: 1.2, z: -1.4 } })], room);
    expect(byId(out, "mon").supportId).toBeUndefined();
    expect(byId(out, "mon").position.y).toBeCloseTo(1.2);
  });

  it("keeps a moved item stacked while its center is over the support, drops it once it leaves", () => {
    const d = desk();
    const still = settleStacks([d, monitor()], [d, monitor({ position: { x: 0.5, y: 0.75, z: 0.1 } })], room, { moved: ["mon"] });
    expect(byId(still, "mon").supportId).toBe("desk");
    const off = settleStacks([d, monitor()], [d, monitor({ position: { x: 1.2, y: 0.75, z: 0 } })], room, { moved: ["mon"] });
    expect(byId(off, "mon").supportId).toBeUndefined();
    expect(byId(off, "mon").position.y).toBe(0);
  });

  it("breaks support cycles", () => {
    const a = item("a", { supportId: "b", position: { x: 0, y: 0.5, z: 0 } });
    const b = item("b", { supportId: "a", position: { x: 0, y: 0.5, z: 0 } });
    const out = settleStacks([], [a, b], room);
    const stacked = out.filter((it) => it.supportId);
    expect(stacked.length).toBeLessThanOrEqual(1);
    const floor = out.find((it) => !it.supportId)!;
    expect(floor.position.y).toBe(0);
  });

  it("breaks a cycle only on the loop: an item resting on the loop keeps its support and follows it down", () => {
    // C rests on A; A and B rest on each other (e.g. from an imported file).
    const a = item("A", { position: { x: 0, y: 0.75, z: 0 }, supportId: "B" });
    const b = item("B", { position: { x: 0, y: 0.5, z: 0 }, supportId: "A" });
    const c = item("C", { dims: { w: 0.2, h: 0.2, d: 0.2 }, position: { x: 0, y: 1.5, z: 0 }, supportId: "A" });
    const out = settleStacks([], [c, a, b], room);
    const C = byId(out, "C");
    const A = byId(out, "A");
    expect(C.supportId).toBe("A");
    expect(C.position.y).toBeCloseTo(A.position.y + A.dims.h, 6);
    // No loop is left.
    for (const it of out) expect(stackDescendants(out, it.id).has(it.id)).toBe(false);
  });

  it("showing a hidden support again puts back what had dropped from it onto the surface below", () => {
    const d = desk();
    const box = item("box", { position: { x: 0, y: 0.75, z: 0 }, supportId: "desk" });
    const lamp = item("lamp", { dims: { w: 0.3, h: 0.5, d: 0.3 }, position: { x: 0, y: 1.25, z: 0 }, supportId: "box" });
    const hidden = settleStacks([d, box, lamp], [d, { ...box, hidden: true }, lamp], room);
    expect(byId(hidden, "lamp")).toMatchObject({ supportId: "desk", position: { y: 0.75 } });
    const shown = settleStacks(hidden, hidden.map((it) => (it.id === "box" ? { ...it, hidden: false } : it)), room);
    expect(byId(shown, "lamp")).toMatchObject({ supportId: "box", position: { y: 1.25 } });
    // Also when the box stood on the floor (nothing stacked anywhere while it was hidden).
    const floorBox = item("box");
    const fell = settleStacks([floorBox, item("cup", { dims: { w: 0.1, h: 0.1, d: 0.1 }, position: { x: 0, y: 0.5, z: 0 }, supportId: "box" })], [
      { ...floorBox, hidden: true },
      item("cup", { dims: { w: 0.1, h: 0.1, d: 0.1 }, position: { x: 0, y: 0.5, z: 0 }, supportId: "box" }),
    ], room);
    expect(byId(fell, "cup").supportId).toBeUndefined();
    const back = settleStacks(fell, fell.map((it) => (it.id === "box" ? { ...it, hidden: false } : it)), room);
    expect(byId(back, "cup")).toMatchObject({ supportId: "box", position: { y: 0.5 } });
  });

  it("showing an item again only takes back what fell off it (a rug under a bed stays on the floor)", () => {
    const rug = item("rug", { dims: { w: 2, h: 0.02, d: 2.3 } });
    const bed = item("bed", { dims: { w: 1.6, h: 0.6, d: 2.1 } });
    const hidden = settleStacks([rug, bed], [rug, { ...bed, hidden: true }], room);
    const shown = settleStacks(hidden, hidden.map((it) => (it.id === "bed" ? { ...it, hidden: false } : it)), room);
    expect(byId(shown, "rug")).toMatchObject({ position: { y: 0 } });
    expect(byId(shown, "rug").supportId).toBeUndefined();
    // The other way round: showing the rug doesn't put the bed on it.
    const rugHidden = settleStacks(shown, shown.map((it) => (it.id === "rug" ? { ...it, hidden: true } : it)), room);
    const rugShown = settleStacks(rugHidden, rugHidden.map((it) => (it.id === "rug" ? { ...it, hidden: false } : it)), room);
    expect(byId(rugShown, "bed").supportId).toBeUndefined();
    expect(byId(rugShown, "bed").position.y).toBe(0);
  });

  it("a dropped item remembers its hidden support until it is moved on purpose", () => {
    const d = desk();
    const box = item("box", { position: { x: 0, y: 0.75, z: 0 }, supportId: "desk" });
    const lamp = item("lamp", { dims: { w: 0.3, h: 0.5, d: 0.3 }, position: { x: 0, y: 1.25, z: 0 }, supportId: "box" });
    const hidden = settleStacks([d, box, lamp], [d, { ...box, hidden: true }, lamp], room);
    expect(byId(hidden, "lamp").droppedFromId).toBe("box");
    // Nudged (moved explicitly) while the box is hidden: it now belongs where it was put.
    const nudged = settleStacks(hidden, hidden.map((it) => (it.id === "lamp" ? { ...it, position: { x: 0.05, y: 0.75, z: 0 } } : it)), room, { moved: ["lamp"] });
    expect(byId(nudged, "lamp").droppedFromId).toBeUndefined();
    expect(byId(nudged, "lamp").supportId).toBe("desk");
    const shown = settleStacks(nudged, nudged.map((it) => (it.id === "box" ? { ...it, hidden: false } : it)), room);
    expect(byId(shown, "lamp").supportId).toBe("desk");
  });

  it("returns the same objects when nothing about stacking changes", () => {
    const d = desk();
    const mon = monitor();
    const out = settleStacks([d, mon], [d, mon], room);
    expect(out[0]).toBe(d);
    expect(out[1]).toBe(mon);
  });
});

describe("stackOrder", () => {
  it("lists stacked items right after their support with their depth", () => {
    const items = [item("mon", { supportId: "desk" }), item("chair"), item("desk"), item("cup", { supportId: "mon" })];
    expect(stackOrder(items).map((r) => `${r.item.id}:${r.depth}`)).toEqual(["chair:0", "desk:0", "mon:1", "cup:2"]);
  });

  it("treats a support outside the list as the floor", () => {
    expect(stackOrder([item("mon", { supportId: "elsewhere" })]).map((r) => r.depth)).toEqual([0]);
  });
});
