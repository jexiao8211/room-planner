import { describe, expect, it } from "vitest";
import type { Room, Vec3 } from "../shared/types";
import { defaultRoom } from "../lib/presets";
import { constrainToRoom } from "../lib/geometry";
import { PRESET_FOV, presetView } from "./cameraViews";
import {
  dragPlaneY,
  intersectHorizontalPlane,
  normalizeAngle,
  nudgeAxes,
  screenDragMetersPerPx,
  screenDragStart,
  screenDragStep,
  snapValue,
  wallDragStep,
  wallDragTarget,
  wallMountPlacement,
  type Ray,
} from "./dragMath";

const room: Room = { name: "t", width: 4, depth: 3, height: 2.5, wallColor: "#ffffff", floorColor: "#888888", openings: [] };

function rayFromTo(from: [number, number, number], to: [number, number, number]) {
  const d = { x: to[0] - from[0], y: to[1] - from[1], z: to[2] - from[2] };
  const len = Math.hypot(d.x, d.y, d.z);
  return { origin: { x: from[0], y: from[1], z: from[2] }, dir: { x: d.x / len, y: d.y / len, z: d.z / len } };
}

describe("intersectHorizontalPlane", () => {
  it("hits the floor below a downward ray", () => {
    const p = intersectHorizontalPlane(rayFromTo([0, 5, 5], [1, 0, 0]), 0);
    expect(p?.x).toBeCloseTo(1);
    expect(p?.z).toBeCloseTo(0);
  });
  it("misses when the plane is behind the ray", () => {
    expect(intersectHorizontalPlane(rayFromTo([0, 5, 5], [0, 6, 0]), 0)).toBeNull();
  });
});

describe("wallDragTarget", () => {
  it("lands on the far (north) wall when looking from the south, ignoring the near wall", () => {
    const hit = wallDragTarget(rayFromTo([0.5, 3, 8], [0.5, 1.5, -1.5]), room);
    expect(hit?.wall).toBe("north");
    expect(hit?.along).toBeCloseTo(0.5);
    expect(hit?.y).toBeCloseTo(1.5);
  });

  it("lands on the east wall when the ray exits through it", () => {
    const hit = wallDragTarget(rayFromTo([-6, 3, 0.2], [2, 1, 0.2]), room);
    expect(hit?.wall).toBe("east");
    expect(hit?.along).toBeCloseTo(0.2);
    expect(hit?.y).toBeCloseTo(1);
  });

  it("falls back to the nearest wall of the floor point, keeping height", () => {
    const hit = wallDragTarget(rayFromTo([0, 6, 0], [1.8, 0, 0.3]), room);
    expect(hit).toEqual({ wall: "east", along: expect.closeTo(0.3, 5), y: null });
  });

  it("clamps heights above the ceiling", () => {
    const hit = wallDragTarget(rayFromTo([0, 2, 8], [0, 4, -1.5]), room);
    expect(hit?.wall).toBe("north");
    expect(hit?.y).toBe(2.5);
  });
});

describe("wallDragStep", () => {
  it("keeps an item on a cut-away near wall while the pointer is over that wall", () => {
    // Camera south of the room looking through the (faded) south wall: the ray exits through the north wall.
    const ray = rayFromTo([0.3, 1.5, 6], [0.3, 1.2, 1.5]);
    expect(wallDragTarget(ray, room)?.wall).toBe("north");
    const step = wallDragStep(ray, room, "south");
    expect(step?.wall).toBe("south");
    expect(step?.along).toBeCloseTo(0.3);
    expect(step?.y).toBeCloseTo(1.2);
  });

  it("moves to the wall under the pointer once the pointer leaves the current wall", () => {
    // Pointer over the east wall while the item is on the north wall (the ray crosses the north plane past its end).
    const ray = rayFromTo([-6, 3, 0.2], [2, 1, 0.2]);
    expect(wallDragStep(ray, room, "north")?.wall).toBe("east");
  });
});

describe("wallMountPlacement", () => {
  const dims = { w: 0.8, h: 0.6, d: 0.04 };
  it("puts the item's back against the wall facing the room", () => {
    const n = wallMountPlacement("north", 0.3, 1.2, dims, room);
    expect(n.position).toEqual({ x: 0.3, y: 1.2, z: -1.5 + 0.02 });
    expect(n.rotationY).toBe(0);
    const e = wallMountPlacement("east", -0.4, 1, dims, room);
    expect(e.position.x).toBeCloseTo(2 - 0.02);
    expect(e.position.z).toBe(-0.4);
    expect(e.rotationY).toBeCloseTo(-Math.PI / 2);
  });
  it("keeps a custom rotation when given one", () => {
    expect(wallMountPlacement("north", 0, 1, dims, room, 0.2).rotationY).toBe(0.2);
  });
});

describe("small helpers", () => {
  it("snaps values", () => {
    expect(snapValue(0.0381, 0.0254)).toBeCloseTo(0.0508);
    expect(snapValue(1.234, 0.01)).toBeCloseTo(1.23);
  });
  it("normalizes angles", () => {
    expect(normalizeAngle(Math.PI * 3)).toBeCloseTo(Math.PI);
    expect(normalizeAngle(-Math.PI / 2 - 2 * Math.PI)).toBeCloseTo(-Math.PI / 2);
    let a = 0;
    for (let i = 0; i < 24; i++) a = normalizeAngle(a + Math.PI / 12);
    expect(a).toBe(0);
  });
  it("snaps nudge axes to the room axes", () => {
    expect(nudgeAxes({ x: 0.1, z: -1 })).toEqual({ forward: { x: 0, z: -1 }, right: { x: 1, z: 0 } });
    expect(nudgeAxes({ x: -1, z: 0.3 })).toEqual({ forward: { x: -1, z: 0 }, right: { x: 0, z: -1 } });
  });
});

/** Minimal pinhole camera: pixel ↔ ray / world point, like three's PerspectiveCamera without a view offset. */
function pinhole(eye: Vec3, target: Vec3, fovDeg: number, width: number, height: number) {
  const sub = (a: Vec3, b: Vec3) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
  const norm = (a: Vec3) => {
    const l = Math.hypot(a.x, a.y, a.z);
    return { x: a.x / l, y: a.y / l, z: a.z / l };
  };
  const cross = (a: Vec3, b: Vec3) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
  const f = norm(sub(target, eye));
  const r = norm(cross(f, { x: 0, y: 1, z: 0 }));
  const u = cross(r, f);
  const focal = height / 2 / Math.tan((fovDeg * Math.PI) / 360);
  return {
    forward: f,
    rayAt(px: number, py: number): Ray {
      const a = (px - width / 2) / focal;
      const b = -(py - height / 2) / focal;
      return { origin: eye, dir: norm({ x: f.x + r.x * a + u.x * b, y: f.y + r.y * a + u.y * b, z: f.z + r.z * a + u.z * b }) };
    },
    project(p: Vec3): { x: number; y: number } {
      const d = sub(p, eye);
      const z = dot(d, f);
      return { x: width / 2 + (focal * dot(d, r)) / z, y: height / 2 - (focal * dot(d, u)) / z };
    },
  };
}

describe("dragPlaneY", () => {
  it("drags through the grabbed point when the plane is well clear of eye level", () => {
    expect(dragPlaneY(0.4, 3)).toBeCloseTo(0.4, 9);
    expect(dragPlaneY(0.75, 1.6)).toBeCloseTo(0.75, 9);
    expect(dragPlaneY(-0.2, 1.6)).toBe(0);
  });
  it("gives up (screen-space drag) when the plane would be close to eye level", () => {
    expect(dragPlaneY(1.74, 1.6)).toBeNull();
    expect(dragPlaneY(1.3, 1.6)).toBeNull();
  });
});

describe("dragging a hanging lamp in the Eye preset (screen-space drag)", () => {
  const room = defaultRoom();
  const W = 960;
  const H = 714;
  const view = presetView("eye", room, W / H, PRESET_FOV.eye);
  const cam = pinhole(view.position, view.target, PRESET_FOV.eye, W, H);
  const lampDims = { w: 0.4, h: 0.9, d: 0.4 };
  const lamp = constrainToRoom({ position: { x: 0, y: 0, z: 0 }, dims: lampDims, rotationY: 0, mount: "ceiling" }, room);
  // Pressed on the front of the shade, about 1.74 m up: just above the 1.6 m eye height.
  const grab = { x: lamp.x, y: lamp.y + 0.2, z: lamp.z + 0.15 };
  const start = cam.project(grab);

  function dragTo(dx: number, dy: number) {
    expect(dragPlaneY(grab.y, view.position.y)).toBeNull();
    const s = screenDragStart(cam.rayAt(start.x, start.y), grab, lamp, { x: cam.forward.x, z: cam.forward.z }, start.y, screenDragMetersPerPx(room, H))!;
    expect(s).not.toBeNull();
    const p = screenDragStep(s, cam.rayAt(start.x + dx, start.y + dy), start.y + dy)!;
    const moved = { x: p.x, y: lamp.y, z: p.z };
    const grabNow = { x: grab.x + p.x - lamp.x, y: grab.y, z: grab.z + p.z - lamp.z };
    return { moved, screen: cam.project(grabNow), dist: Math.hypot(p.x - lamp.x, p.z - lamp.z) };
  }

  it("stays under the cursor when dragged sideways (150 px left)", () => {
    const r = dragTo(-150, 0);
    expect(Math.abs(r.screen.x - (start.x - 150))).toBeLessThan(3);
    expect(r.dist).toBeLessThan(1);
  });

  it("small vertical moves give small, predictable steps: down = closer, up = farther", () => {
    const depthOf = (p: Vec3) => (p.x - view.position.x) * cam.forward.x + (p.z - view.position.z) * cam.forward.z;
    const down = dragTo(0, 20);
    expect(down.dist).toBeGreaterThan(0.02);
    expect(down.dist).toBeLessThan(0.5);
    expect(depthOf(down.moved)).toBeLessThan(depthOf(lamp));
    const up = dragTo(0, -32);
    expect(up.dist).toBeLessThan(0.5);
    expect(depthOf(up.moved)).toBeGreaterThan(depthOf(lamp));
    // Still in front of the camera and on screen, not pulled over the viewer's head.
    expect(up.screen.y).toBeGreaterThan(0);
    expect(up.screen.y).toBeLessThan(H);
  });

  it("a floor item in the Iso view keeps the exact plane drag (under the cursor)", () => {
    const iso = presetView("iso", room, W / H, PRESET_FOV.iso);
    const isoCam = pinhole(iso.position, iso.target, PRESET_FOV.iso, W, H);
    const top = { x: 0.2, y: 0.75, z: -0.3 };
    const planeY = dragPlaneY(top.y, iso.position.y)!;
    expect(planeY).toBeCloseTo(0.75, 9);
    const px = isoCam.project(top);
    const hit = intersectHorizontalPlane(isoCam.rayAt(px.x - 100, px.y + 40), planeY)!;
    const back = isoCam.project(hit);
    expect(Math.hypot(back.x - (px.x - 100), back.y - (px.y + 40))).toBeLessThan(0.5);
  });
});
