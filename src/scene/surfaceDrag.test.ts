// Drag decision over / under / onto a level (ROUND3-SPEC §3, §7): what the pointer ray points at decides.
import { describe, expect, it } from "vitest";
import type { PlacedItem } from "../shared/types";
import { SHAPE_PRESETS } from "../lib/presets";
import { floorDragTarget, type Ray } from "./dragMath";

function preset(key: string, id = key, over: Partial<PlacedItem> = {}): PlacedItem {
  const p = SHAPE_PRESETS.find((x) => x.key === key)!;
  return { id, name: p.label, position: { x: 0, y: 0, z: 0 }, rotationY: 0, dims: { ...p.dims }, color: p.color, mount: p.mount, parts: p.parts, origin: "shape", ...over };
}
function box(id: string, w: number, h: number, d: number, over: Partial<PlacedItem> = {}): PlacedItem {
  return { id, name: id, position: { x: 1.2, y: 0, z: 1 }, rotationY: 0, dims: { w, h, d }, color: "#888888", mount: "floor", parts: [], origin: "shape", ...over };
}
/** A ray from a camera 2 m above and 2.5 m in front (+z) of a point, aimed exactly at it (an iso-like view). */
function rayAt(p: { x: number; y: number; z: number }): Ray {
  const origin = { x: p.x, y: p.y + 2, z: p.z + 2.5 };
  const d = { x: 0, y: -2, z: -2.5 };
  const len = Math.hypot(d.x, d.y, d.z);
  return { origin, dir: { x: d.x / len, y: d.y / len, z: d.z / len } };
}
const STEP = 0.001;
const CAM_Y = 4;
const NO_OFFSET = { x: 0, z: 0 };

describe("floorDragTarget: over or under a desk", () => {
  const desk = preset("desk", "desk");
  const bin = box("bin", 0.3, 0.35, 0.3);

  it("pointing at the floor between the desk's legs puts a bin UNDER the desk (it fits)", () => {
    const t = floorDragTarget(rayAt({ x: 0, y: 0, z: 0 }), bin, [desk, bin], 0.2, NO_OFFSET, STEP, CAM_Y)!;
    expect(t.support?.id).toBe("desk");
    expect(t.surfaceY).toBe(0);
    expect(t.y).toBe(0);
    // Kept fully under the desk top.
    expect(Math.abs(t.z)).toBeLessThanOrEqual(0.15 + 1e-6);
    expect(Math.abs(t.x)).toBeLessThanOrEqual(0.45);
  });

  it("pointing at the desk top puts it ON the desk", () => {
    const t = floorDragTarget(rayAt({ x: 0.2, y: 0.75, z: 0 }), bin, [desk, bin], 0.2, NO_OFFSET, STEP, CAM_Y)!;
    expect(t.support?.id).toBe("desk");
    expect(t.surfaceY).toBeUndefined();
    expect(t.y).toBeCloseTo(0.75);
  });

  it("something too tall to fit under goes on top, as before", () => {
    const tall = box("tall", 0.3, 0.8, 0.3);
    const t = floorDragTarget(rayAt({ x: 0, y: 0, z: 0 }), tall, [desk, tall], 0.2, NO_OFFSET, STEP, CAM_Y)!;
    expect(t.support?.id).toBe("desk");
    expect(t.surfaceY).toBeUndefined();
    expect(t.y).toBeCloseTo(0.75);
  });

  it("pointing at a leg is not 'under' it; beside the desk is the floor", () => {
    const beside = floorDragTarget(rayAt({ x: 1.0, y: 0, z: 0.8 }), bin, [desk, bin], 0.2, NO_OFFSET, STEP, CAM_Y)!;
    expect(beside.support).toBeNull();
    expect(beside.y).toBe(0);
  });

  it("a solid box has no room under it: pointing at its foot puts the bin on top", () => {
    const solid = box("solid", 1.2, 0.75, 0.6, { position: { x: 0, y: 0, z: 0 } });
    const t = floorDragTarget(rayAt({ x: 0, y: 0, z: 0.25 }), bin, [solid, bin], 0.2, NO_OFFSET, STEP, CAM_Y)!;
    expect(t.support?.id).toBe("solid");
    expect(t.surfaceY).toBeUndefined();
  });
});

describe("floorDragTarget: levels of a cat tower", () => {
  const tower = preset("cattower", "tower");
  const cat = preset("cat", "cat", { position: { x: 1.2, y: 0, z: 1 } });

  it("pointing at the middle platform puts the cat on it (clear of the post)", () => {
    const t = floorDragTarget(rayAt({ x: -0.15, y: 0.945, z: 0.2 }), cat, [tower, cat], 0.15, NO_OFFSET, STEP, CAM_Y)!;
    expect(t.support?.id).toBe("tower");
    expect(t.surfaceY).toBeCloseTo(0.945);
    expect(t.y).toBeCloseTo(0.945);
  });

  it("pointing at the top perch puts it on top", () => {
    const t = floorDragTarget(rayAt({ x: 0, y: 1.5, z: 0 }), cat, [tower, cat], 0.15, NO_OFFSET, STEP, CAM_Y)!;
    expect(t.support?.id).toBe("tower");
    expect(t.surfaceY).toBeUndefined();
    expect(t.y).toBeCloseTo(1.5);
  });

  it("a hanging lamp dragged over the tower never lands on it", () => {
    const pendant = preset("pendant", "p", { position: { x: 1, y: 1.54, z: 0 } });
    const t = floorDragTarget(rayAt({ x: -0.15, y: 0.945, z: 0.2 }), pendant, [tower, pendant], 0.5, NO_OFFSET, STEP, CAM_Y);
    expect(t?.support ?? null).toBeNull();
  });
});

describe("floorDragTarget: pointing low on a cat tower (review round 3)", () => {
  const tower = preset("cattower", "tower", { position: { x: -0.6, y: 0, z: -0.4 } });
  const cat = preset("cat", "cat", { position: { x: 1, y: 0, z: 1 } });

  it("the base plate or the condo box puts the cat on the lowest level it fits on (the middle platform), not the top perch", () => {
    // Front-left base corner (y 0.03), the condo box's front at 0.2 m, just below the platform.
    for (const p of [
      { x: -0.85, y: 0.03, z: -0.15 },
      { x: -0.5, y: 0.2, z: -0.25 },
      { x: -0.55, y: 0.5, z: -0.15 },
    ]) {
      const t = floorDragTarget(rayAt(p), cat, [tower, cat], 0.15, NO_OFFSET, STEP, CAM_Y)!;
      expect(t.support?.id, JSON.stringify(p)).toBe("tower");
      expect(t.y, JSON.stringify(p)).toBeCloseTo(0.945, 3);
    }
    // Pointing at the top part of the tower still means the top perch.
    const top = floorDragTarget(rayAt({ x: -0.6, y: 1.45, z: -0.15 }), cat, [tower, cat], 0.15, NO_OFFSET, STEP, CAM_Y)!;
    expect(top.y).toBeCloseTo(1.5, 3);
  });

  it("surfacesOnly (Eye view screen drag): a surface under the pointer, else null (no floor fallback)", () => {
    // Eye-level camera looking at the middle platform's center.
    const eye = { x: -0.6, y: 1.6, z: 1.2 };
    const aim = { x: -0.6, y: 0.945, z: -0.4 };
    const d = { x: aim.x - eye.x, y: aim.y - eye.y, z: aim.z - eye.z };
    const len = Math.hypot(d.x, d.y, d.z);
    const ray: Ray = { origin: eye, dir: { x: d.x / len, y: d.y / len, z: d.z / len } };
    const t = floorDragTarget(ray, cat, [tower, cat], 0.15, NO_OFFSET, STEP, 1.6, undefined, true)!;
    expect(t.support?.id).toBe("tower");
    expect(t.y).toBeCloseTo(0.945, 3);
    const away: Ray = { origin: eye, dir: { x: 1, y: 0, z: 0 } };
    expect(floorDragTarget(away, cat, [tower, cat], 0.15, NO_OFFSET, STEP, 1.6, undefined, true)).toBeNull();
  });
});
