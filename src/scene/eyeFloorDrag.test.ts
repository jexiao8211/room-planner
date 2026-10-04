// Eye view: dragging an item down off a support onto the floor in front of it (review round 5). The pointer on the
// floor in front of the cat tower / desk puts the item on the floor there; it never jumps back up onto the top.
import { describe, expect, it } from "vitest";
import type { PlacedItem } from "../shared/types";
import { SHAPE_PRESETS } from "../lib/presets";
import { pointInFootprint } from "../lib/geometry";
import { floorDragTarget, floorSpotTarget, screenDragMinDepth, screenDragStart, screenFloorDragStep, type Ray } from "./dragMath";

function preset(key: string, id = key, over: Partial<PlacedItem> = {}): PlacedItem {
  const p = SHAPE_PRESETS.find((x) => x.key === key)!;
  return { id, name: p.label, position: { x: 0, y: 0, z: 0 }, rotationY: 0, dims: { ...p.dims }, color: p.color, mount: p.mount, parts: p.parts, origin: "shape", ...over };
}

// Rays recorded from the Eye view of the default room (camera at the door, 1.6 m up), 1280 × 800 window: the start of
// the drag on the cat on the tower's top perch, and the pointer on the floor right in front of the tower.
const EYE = { x: -1.23, y: 1.6, z: 1.175 };
const ray = (dir: { x: number; y: number; z: number }): Ray => ({ origin: EYE, dir });
const START = ray({ x: 0.7209366004854433, y: -0.028433995389755006, z: -0.6924174506659029 });
const FLOOR_IN_FRONT = ray({ x: 0.542331287352542, y: -0.6587751867302535, z: -0.5214326688145408 });
// The ray through the bottom-center of the view.
const BOTTOM = ray({ x: 0.5193, y: -0.6957, z: -0.4963 });
const FORWARD = { x: 1.23, z: -1.175 };
const STEP = 0.0254;

const tower = preset("cattower", "tower", { position: { x: 0.5, y: 0, z: -0.5 } });
const cat = preset("cat", "cat", { position: { x: 0.41, y: 1.5, z: -0.41 }, supportId: "tower" });

function drag() {
  const grabbed = { x: EYE.x + START.dir.x * 2.3, z: EYE.z + START.dir.z * 2.3 };
  const s = screenDragStart(START, grabbed, cat.position, FORWARD, 338, 0.0061)!;
  s.minDepth = screenDragMinDepth(BOTTOM, FORWARD, Math.max(cat.dims.w, cat.dims.d) / 2);
  return s;
}

describe("Eye view: pointing at the floor in front of a support", () => {
  it("the pointer on the floor in front of the tower: the cat goes to the floor at the pointer, not onto the top", () => {
    const s = drag();
    // Nothing of the tower is under the pointer.
    expect(floorDragTarget(FLOOR_IN_FRONT, cat, [tower, cat], 0.1, s.offset, STEP, EYE.y, undefined, true)).toBeNull();
    const p = screenFloorDragStep(s, FLOOR_IN_FRONT, 760)!;
    expect(p.floor).toBe(true);
    const t = FLOOR_IN_FRONT;
    const k = -t.origin.y / t.dir.y;
    expect(p.x).toBeCloseTo(t.origin.x + t.dir.x * k, 6);
    expect(p.z).toBeCloseTo(t.origin.z + t.dir.z * k, 6);
    const target = floorSpotTarget(cat, p, [tower, cat], p.aim!, s.forward, STEP);
    expect(target.support).toBeNull();
    expect(target.y).toBe(0);
    expect(pointInFootprint(target, tower)).toBe(false);
  });

  it("a spot inside the tower's footprint (the grab offset, a depth-only step) is moved out toward the pointer", () => {
    const s = drag();
    const aim = { x: 0.087, z: -0.091 };
    const target = floorSpotTarget(cat, { x: 0.25, z: -0.25 }, [tower, cat], aim, s.forward, STEP);
    expect(target.support).toBeNull();
    expect(target.y).toBe(0);
    expect(pointInFootprint(target, tower)).toBe(false);
    // Just outside the tower's near corner, on the way to the pointer.
    expect(Math.hypot(target.x - 0.2, target.z + 0.2)).toBeLessThan(0.12);
  });

  it("the floor between a desk's legs still puts a bin under it; a rug there is stood on", () => {
    const desk = preset("desk", "desk", { position: { x: 0.3, y: 0, z: -0.3 }, rotationY: -Math.PI / 4 });
    const bin: PlacedItem = { ...preset("cylinder", "bin"), name: "Bin", dims: { w: 0.25, h: 0.3, d: 0.25 }, position: { x: 1, y: 0, z: 1 } };
    const under = floorSpotTarget(bin, { x: 0.3, z: -0.3 }, [desk, bin], { x: 0.3, z: -0.3 }, FORWARD, STEP);
    expect(under.support?.id).toBe("desk");
    expect(under.surfaceY).toBe(0);
    const rug: PlacedItem = { ...preset("box", "rug"), name: "Rug", dims: { w: 2, h: 0.01, d: 1.4 }, position: { x: -1, y: 0, z: 0.5 } };
    const onRug = floorSpotTarget(bin, { x: -1, z: 0.5 }, [rug, bin], { x: -1, z: 0.5 }, FORWARD, STEP);
    expect(onRug.support?.id).toBe("rug");
    expect(onRug.y).toBeCloseTo(0.01, 6);
  });

  it("pointing at the floor farther away than the item's screen-drag depth keeps the depth-only drag (no jump away)", () => {
    const s = drag();
    // The pointer barely moved down: the floor it points at is far beyond the tower.
    const far = ray({ x: 0.72, y: -0.12, z: -0.69 });
    const p = screenFloorDragStep(s, far, 345)!;
    expect(p.floor).toBe(false);
    expect(p.aim).toBeDefined();
  });

  it("never under the camera: floor points closer than 0.3 m in front of it are not used", () => {
    const s = drag();
    const down = ray({ x: 0.05, y: -0.99, z: -0.05 });
    const p = screenFloorDragStep(s, down, 790);
    expect(p?.floor ?? false).toBe(false);
  });
});
