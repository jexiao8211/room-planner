import { describe, expect, it } from "vitest";
import type { PlacedItem } from "../shared/types";
import { floorDragTarget, rayHitsItemBox, type Ray } from "./dragMath";
import type { Room } from "../shared/types";

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

/** A ray from a camera above and in front (+z) of a point, aimed exactly at that point. */
function rayThrough(p: { x: number; y: number; z: number }): Ray {
  const origin = { x: p.x, y: p.y + 4, z: p.z + 3 };
  const d = { x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z };
  const len = Math.hypot(d.x, d.y, d.z);
  return { origin, dir: { x: d.x / len, y: d.y / len, z: d.z / len } };
}

const STEP = 0.001;
const CAM_Y = 6;
const desk = item("desk", { dims: { w: 1.2, h: 0.75, d: 0.6 }, position: { x: -1, y: 0, z: 0 } });
const box = item("box", { position: { x: 1, y: 0, z: 0 } });

describe("floorDragTarget", () => {
  it("lands on the desk when the grabbed point is over the desk top", () => {
    // Grabbed 0.25 m above the box's bottom; pointer over the point that would be grabbed if the box sat on the desk.
    const ray = rayThrough({ x: -1.1, y: 0.75 + 0.25, z: 0.05 });
    const t = floorDragTarget(ray, box, [desk, box], 0.25, { x: 0, z: 0 }, STEP, CAM_Y)!;
    expect(t.support?.id).toBe("desk");
    expect(t.x).toBeCloseTo(-1.1, 2);
    expect(t.z).toBeCloseTo(0.05, 2);
  });

  it("stays on the floor beside the desk", () => {
    const ray = rayThrough({ x: 0.5, y: 0.25, z: 0.8 });
    const t = floorDragTarget(ray, box, [desk, box], 0.25, { x: 0, z: 0 }, STEP, CAM_Y)!;
    expect(t.support).toBeNull();
    expect(t.x).toBeCloseTo(0.5, 2);
    expect(t.z).toBeCloseTo(0.8, 2);
  });

  it("keeps the grab offset", () => {
    const ray = rayThrough({ x: 0.5, y: 0.25, z: 0.8 });
    const t = floorDragTarget(ray, box, [desk, box], 0.25, { x: 0.1, z: -0.2 }, STEP, CAM_Y)!;
    expect(t.x).toBeCloseTo(0.6, 2);
    expect(t.z).toBeCloseTo(0.6, 2);
  });

  it("picks the highest support under the pointer", () => {
    const riser = item("riser", { dims: { w: 0.6, h: 0.1, d: 0.4 }, position: { x: -1, y: 0.75, z: 0 }, supportId: "desk" });
    const small = item("small", { dims: { w: 0.3, h: 0.2, d: 0.2 }, position: { x: 1, y: 0, z: 1 } });
    const ray = rayThrough({ x: -1, y: 0.85 + 0.1, z: 0 });
    const t = floorDragTarget(ray, small, [desk, riser, small], 0.1, { x: 0, z: 0 }, STEP, CAM_Y)!;
    expect(t.support?.id).toBe("riser");
  });

  it("never stacks an item on something resting on it, on hidden items, or when it is too big", () => {
    const mon = item("mon", { dims: { w: 0.6, h: 0.4, d: 0.2 }, position: { x: -1, y: 0.75, z: 0 }, supportId: "desk" });
    // Dragging the desk over its own monitor: the monitor is not a support for it.
    const ray = rayThrough({ x: -1, y: 1.15 + 0.3, z: 0 });
    expect(floorDragTarget(ray, desk, [desk, mon], 0.3, { x: 0, z: 0 }, STEP, CAM_Y)!.support).toBeNull();
    const ray2 = rayThrough({ x: -1, y: 0.75 + 0.25, z: 0 });
    expect(floorDragTarget(ray2, box, [{ ...desk, hidden: true }, box], 0.25, { x: 0, z: 0 }, STEP, CAM_Y)!.support).toBeNull();
    const bed = item("bed", { dims: { w: 1.6, h: 0.5, d: 2 }, position: { x: 1, y: 0, z: 0 } });
    expect(floorDragTarget(ray2, bed, [desk, bed], 0.25, { x: 0, z: 0 }, STEP, CAM_Y)!.support).toBeNull();
  });

  it("stacks when the pointer is on the support's top surface (the natural gesture), not only grab-height above it", () => {
    // A monitor grabbed by its screen (0.3 m above its bottom), released with the pointer on the desk-top center.
    const mon = item("mon", { dims: { w: 0.6, h: 0.4, d: 0.2 }, position: { x: 1, y: 0, z: 1 } });
    for (const [x, z] of [
      [-1, 0], // center
      [-1, 0.28], // front edge
      [-1.5, -0.25], // back-left
    ]) {
      const t = floorDragTarget(rayThrough({ x, y: 0.75, z }), mon, [desk, mon], 0.3, { x: 0, z: 0 }, STEP, CAM_Y)!;
      expect(t.support?.id, `pointer at ${x}, ${z}`).toBe("desk");
      // Kept fully on the desk top.
      expect(Math.abs(t.x - desk.position.x)).toBeLessThanOrEqual(desk.dims.w / 2 - mon.dims.w / 2 + 1e-6);
      expect(Math.abs(t.z - desk.position.z)).toBeLessThanOrEqual(desk.dims.d / 2 - mon.dims.d / 2 + 1e-6);
    }
    // Pointer on the desk's front face counts too.
    const front = floorDragTarget(rayThrough({ x: -1, y: 0.4, z: 0.3 }), mon, [desk, mon], 0.3, { x: 0, z: 0 }, STEP, CAM_Y)!;
    expect(front.support?.id).toBe("desk");
  });

  it("a floor spot that ends up inside a support (after clamping against the wall) goes on top of it", () => {
    const room: Room = { name: "R", width: 4, depth: 3, height: 2.5, wallColor: "#ffffff", floorColor: "#000000", openings: [] };
    // A desk against the north wall; the pointer behind it (toward the wall) misses the desk box from this camera.
    const northDesk = item("nd", { dims: { w: 1.2, h: 0.75, d: 0.6 }, position: { x: 0, y: 0, z: -1.2 } });
    const lamp = item("lamp", { dims: { w: 0.3, h: 0.5, d: 0.3 }, position: { x: 1.5, y: 0, z: 1 } });
    // Straight-down ray at the wall line: the floor point (z = -1.55, outside the room) is clamped to z = -1.35, inside the desk.
    const ray: Ray = { origin: { x: 0.2, y: 0.74, z: -1.55 }, dir: { x: 0, y: -1, z: 0 } };
    const t = floorDragTarget(ray, lamp, [northDesk, lamp], 0.25, { x: 0, z: 0 }, STEP, CAM_Y, room)!;
    expect(t.support?.id).toBe("nd");
    // Without the room (no clamping) the spot is outside the desk: floor.
    expect(floorDragTarget(ray, lamp, [northDesk, lamp], 0.25, { x: 0, z: 0 }, STEP, CAM_Y)!.support).toBeNull();
  });

  it("rayHitsItemBox finds the entry point of a rotated box and misses beside it", () => {
    const rotated = item("r", { dims: { w: 2, h: 1, d: 0.2 }, position: { x: 0, y: 0, z: 0 }, rotationY: Math.PI / 2 });
    // Turned 90°, the box spans x ±0.1, z ±1: a ray down at (0, z 0.9) hits its top; at (0.5, 0) it misses.
    expect(rayHitsItemBox({ origin: { x: 0, y: 3, z: 0.9 }, dir: { x: 0, y: -1, z: 0 } }, rotated)?.point.y).toBeCloseTo(1);
    expect(rayHitsItemBox({ origin: { x: 0.5, y: 3, z: 0 }, dir: { x: 0, y: -1, z: 0 } }, rotated)).toBeNull();
  });

  it("ceiling items never stack", () => {
    const pendant = item("p", { mount: "ceiling", position: { x: 1, y: 2, z: 0 } });
    const ray = rayThrough({ x: -1, y: 0.75 + 0.25, z: 0 });
    expect(floorDragTarget(ray, pendant, [desk, pendant], 0.25, { x: 0, z: 0 }, STEP, CAM_Y)?.support ?? null).toBeNull();
  });
});
