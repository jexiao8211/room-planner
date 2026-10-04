// Pure math used by item dragging and keyboard nudging. No three.js imports so it is easy to test.
import type { PlacedItem, Room, Units, Vec3, WallSide } from "../shared/types";
import {
  canSupport,
  constrainToRoom,
  findSurfaceAt,
  fitsOnTop,
  fitsSurfaceAt,
  footprintHalfExtents,
  nearestWall,
  pointInFootprint,
  storedSurfaceY,
  supportSurfaces,
  supportToWorld,
  supportTop,
  surfaceClearance,
  surfaceSpot,
  surfacesFor,
  worldToSupport,
  type SupportSurface,
} from "../lib/geometry";
import { M_PER_IN } from "../lib/units";
import { WALL_SIDES, wallFrame } from "./wallPieces";

export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

/** Where a floor drag puts the item: x/z, what it rests on (null = the floor), and on which surface of it. */
export interface FloorDragTarget {
  x: number;
  z: number;
  support: PlacedItem | null;
  /** supportSurfaceY to store (undefined = the support's top). */
  surfaceY?: number;
  /** Room height of the item's bottom. */
  y: number;
}

/**
 * Where a dragged floor item goes for the current pointer ray (CHAT-SPEC "Stacking", ROUND3-SPEC §3 and §7). The
 * surfaces of a support are its parts' tops (desk top, cat tower platforms, a bed's mattress) and the floor under it
 * (between a desk's legs), see supportSurfaces. In order:
 *  1. the raised surface the pointer points at: the first one (along the ray) whose plane the ray crosses inside the
 *     surface's rectangle at an open spot (not inside a part), among surfaces the item fits on;
 *  2. the plain top of the highest valid support when, with the grabbed point kept under the cursor at that height,
 *     the item's center lands inside the support's footprint (the item stays under the cursor);
 *  3. the floor under a support when the ray reaches the floor inside its footprint between its parts and the item
 *     fits under it (its clearance);
 *  4. else, of the valid support whose box the pointer is over (releasing with the pointer on the desk's front edge),
 *     the surface it fits on nearest in height to where the pointer meets the box (pointing at a cat tower's base or
 *     condo box puts a cat on the lowest level it fits on, not the top perch), centered on the hit point;
 *  5. else the floor. A floor spot whose center (after clamping into `room`) ends up inside a valid support's
 *     footprint goes under it when it fits there, else on top of it, so an item never vanishes inside a desk.
 * A valid support: canSupport (visible floor item, no cycles). Items are kept on the surface they land on when they
 * fit, and moved to the nearest free spot of it otherwise (around a cat tower's posts).
 * `grabLocalY` is the grabbed point's height above the item's bottom, `offset` the item center minus the grabbed
 * point (x/z). Planes closer than MIN_PLANE_GAP to the camera's height are skipped. Positions are snapped to `step`.
 * Null when the ray doesn't reach the floor plane (e.g. pointing above the horizon) and no support matched.
 * `surfacesOnly`: only what the pointer itself points at (steps 1, 3 and 4), null otherwise (the Eye view's
 * screen-space drag, which moves the item in depth when the pointer isn't on a surface).
 */
export function floorDragTarget(
  ray: Ray,
  item: PlacedItem,
  items: PlacedItem[],
  grabLocalY: number,
  offset: { x: number; z: number },
  step: number,
  cameraY: number,
  room?: Room,
  surfacesOnly = false,
): FloorDragTarget | null {
  const at = (h: number) => {
    const hit = intersectHorizontalPlane(ray, h);
    return hit ? { x: snapValue(hit.x + offset.x, step), z: snapValue(hit.z + offset.z, step) } : null;
  };
  const onSurface = (s: PlacedItem, sf: SupportSurface, p: { x: number; z: number }): FloorDragTarget => ({
    ...p,
    support: s,
    surfaceY: storedSurfaceY(s, sf),
    y: s.position.y + sf.y,
  });
  /** The item centered near world point `p` on a surface: kept fully on it when it can, else the nearest free spot. */
  const settleOn = (s: PlacedItem, sf: SupportSurface, p: { x: number; z: number }): FloorDragTarget | null => {
    const c = clampOntoSurface(p, item, s, sf);
    if (fitsSurfaceAt(item, s, sf, worldToSupport(s, c))) return onSurface(s, sf, c);
    const spot = surfaceSpot(item, s, sf, item.rotationY, worldToSupport(s, p));
    return spot ? onSurface(s, sf, supportToWorld(s, spot)) : null;
  };

  if (item.mount === "floor") {
    const supports = items.filter((s) => canSupport(item.id, s, items));
    // What the pointer points at: surface planes crossed inside their rectangle at an open spot, nearest first.
    const hits: { t: number; s: PlacedItem; sf: SupportSurface; p: { x: number; z: number } }[] = [];
    for (const s of supports) {
      for (const sf of supportSurfaces(s)) {
        const y = s.position.y + sf.y;
        const hit = intersectHorizontalPlane(ray, y);
        if (!hit) continue;
        const l = worldToSupport(s, hit);
        if (l.x < sf.x0 || l.x > sf.x1 || l.z < sf.z0 || l.z > sf.z1) continue;
        if (surfaceClearance(s, sf.y, l.x, l.z) < 0.05) continue; // inside a part (a leg, the condo box)
        const t = (y - ray.origin.y) / ray.dir.y;
        hits.push({ t, s, sf, p: { x: hit.x, z: hit.z } });
      }
    }
    hits.sort((a, b) => a.t - b.t);
    /** Where the item goes for a hit: its grabbed point kept under the cursor when that is over the support. */
    const near = (h: (typeof hits)[number]) => {
      const kept = at(h.s.position.y + h.sf.y + grabLocalY);
      return kept && pointInFootprint(kept, h.s) ? kept : { x: snapValue(h.p.x + offset.x, step), z: snapValue(h.p.z + offset.z, step) };
    };
    // 1. A raised surface under the pointer.
    for (const h of hits) {
      if (h.sf.kind === "under") continue;
      const t = settleOn(h.s, h.sf, near(h));
      if (t) return t;
    }
    // 2. The grabbed point kept under the cursor over a support's plain (bounding-box) top.
    const tops = surfacesOnly ? [] : supports.filter((s) => fitsOnTop(item, s)).sort((a, b) => supportTop(b) - supportTop(a));
    for (const s of tops) {
      if (Math.abs(supportSurfaces(s)[0].y - s.dims.h) > 0.01) continue; // a part-aware top: pointing (1) decides
      const h = supportTop(s) + grabLocalY;
      if (Math.abs(h - cameraY) < MIN_PLANE_GAP) continue;
      const p = at(h);
      if (p && pointInFootprint(p, s)) return { ...clampOntoSupport(p, item, s), support: s, y: supportTop(s) };
    }
    // 3. The floor under a support, between its legs.
    for (const h of hits) {
      if (h.sf.kind !== "under") continue;
      const t = settleOn(h.s, h.sf, near(h));
      if (t) return t;
    }
    // 4. The support box the pointer is over (nearest along the ray): the surface it fits on nearest in height to
    //    the point the pointer meets the box at.
    let best: { t: number; s: PlacedItem; x: number; y: number; z: number } | null = null;
    for (const s of supports) {
      const hit = rayHitsItemBox(ray, s);
      if (hit && (!best || hit.t < best.t)) best = { t: hit.t, s, ...hit.point };
    }
    if (best) {
      const b = best;
      const p = { x: snapValue(b.x + offset.x, step), z: snapValue(b.z + offset.z, step) };
      const at = b.y - b.s.position.y;
      const order = surfacesFor(item, b.s, item.rotationY)
        .filter((sf) => sf.kind !== "under")
        .sort((x, y) => Math.abs(x.y - at) - Math.abs(y.y - at) || y.y - x.y);
      for (const sf of order) {
        const t = settleOn(b.s, sf, p);
        if (t) return t;
      }
    }
  }
  if (surfacesOnly) return null;
  const p = at(Math.max(0, grabLocalY));
  if (!p) return null;
  if (item.mount === "floor") {
    // Clamped like the store will (against the walls), then: inside a support's footprint = under it or on it.
    const xz = room ? constrainToRoom({ position: { x: p.x, y: 0, z: p.z }, dims: item.dims, rotationY: item.rotationY, mount: "floor" }, room) : p;
    for (const s of items) {
      if (!canSupport(item.id, s, items) || !pointInFootprint(xz, s)) continue;
      const under = supportSurfaces(s).find((sf) => sf.kind === "under");
      if (under && fitsSurfaceAt(item, s, under, worldToSupport(s, xz))) return onSurface(s, under, xz);
    }
    const found = findSurfaceAt(item, xz, items);
    if (found) {
      const t = settleOn(found.support, found.surface, xz);
      if (t) return t;
    }
  }
  return { ...p, support: null, y: 0 };
}

/** A center point moved (in the support's frame) so the item's footprint stays on a surface's rectangle when it can. */
export function clampOntoSurface(
  p: { x: number; z: number },
  item: Pick<PlacedItem, "dims" | "rotationY">,
  s: Pick<PlacedItem, "position" | "rotationY" | "dims">,
  sf: Pick<SupportSurface, "x0" | "x1" | "z0" | "z1">,
): { x: number; z: number } {
  const l = worldToSupport(s, p);
  const { hx, hz } = footprintHalfExtents(item.dims, item.rotationY - s.rotationY);
  const cx = (sf.x0 + sf.x1) / 2;
  const cz = (sf.z0 + sf.z1) / 2;
  const mx = Math.max(0, (sf.x1 - sf.x0) / 2 - hx);
  const mz = Math.max(0, (sf.z1 - sf.z0) / 2 - hz);
  return supportToWorld(s, { x: Math.min(cx + mx, Math.max(cx - mx, l.x)), z: Math.min(cz + mz, Math.max(cz - mz, l.z)) });
}

/**
 * Where a ray first enters an item's (rotated) bounding box, or null if it misses it (or starts inside it).
 * `t` is the distance along the ray (in units of ray.dir).
 */
export function rayHitsItemBox(ray: Ray, it: Pick<PlacedItem, "position" | "rotationY" | "dims">): { t: number; point: Vec3 } | null {
  const c = Math.cos(it.rotationY);
  const sn = Math.sin(it.rotationY);
  // Into the item's frame (the inverse of three.js' rotation about +Y), origin at its bottom-center.
  const loc = (x: number, z: number) => ({ x: x * c - z * sn, z: x * sn + z * c });
  const o = loc(ray.origin.x - it.position.x, ray.origin.z - it.position.z);
  const d = loc(ray.dir.x, ray.dir.z);
  const origin = [o.x, ray.origin.y - it.position.y, o.z];
  const dir = [d.x, ray.dir.y, d.z];
  const lo = [-it.dims.w / 2, 0, -it.dims.d / 2];
  const hi = [it.dims.w / 2, it.dims.h, it.dims.d / 2];
  let tmin = -Infinity;
  let tmax = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(dir[k]) < 1e-12) {
      if (origin[k] < lo[k] || origin[k] > hi[k]) return null;
      continue;
    }
    let t1 = (lo[k] - origin[k]) / dir[k];
    let t2 = (hi[k] - origin[k]) / dir[k];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmin <= 0) return null;
  return { t: tmin, point: { x: ray.origin.x + ray.dir.x * tmin, y: ray.origin.y + ray.dir.y * tmin, z: ray.origin.z + ray.dir.z * tmin } };
}

/** A center point moved (in the support's frame) so the item's footprint stays on the support's top when it can. */
export function clampOntoSupport(
  p: { x: number; z: number },
  item: Pick<PlacedItem, "dims" | "rotationY">,
  s: Pick<PlacedItem, "position" | "rotationY" | "dims">,
): { x: number; z: number } {
  const c = Math.cos(s.rotationY);
  const sn = Math.sin(s.rotationY);
  const dx = p.x - s.position.x;
  const dz = p.z - s.position.z;
  const { hx, hz } = footprintHalfExtents(item.dims, item.rotationY - s.rotationY);
  const mx = Math.max(0, s.dims.w / 2 - hx);
  const mz = Math.max(0, s.dims.d / 2 - hz);
  const lx = Math.min(mx, Math.max(-mx, dx * c - dz * sn));
  const lz = Math.min(mz, Math.max(-mz, dx * sn + dz * c));
  return { x: s.position.x + lx * c + lz * sn, z: s.position.z - lx * sn + lz * c };
}

/** Grid step used for drag/nudge snapping: 1 inch (imperial) or 1 cm (metric). */
export function snapStep(units: Units): number {
  return units === "imperial" ? M_PER_IN : 0.01;
}

export function snapValue(v: number, step: number): number {
  return Math.round(v / step) * step;
}

/** Normalize an angle to (-π, π] and clean up float drift near multiples of 15°. */
export function normalizeAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  if (r > Math.PI) r -= 2 * Math.PI;
  const step = Math.PI / 12;
  const snapped = Math.round(r / step) * step;
  if (Math.abs(r - snapped) < 1e-9) r = snapped;
  return r === -Math.PI ? Math.PI : r;
}

/** Point where a ray crosses the horizontal plane y = planeY (only in front of the origin). */
export function intersectHorizontalPlane(ray: Ray, planeY: number): Vec3 | null {
  if (Math.abs(ray.dir.y) < 1e-9) return null;
  const t = (planeY - ray.origin.y) / ray.dir.y;
  if (t <= 0) return null;
  return { x: ray.origin.x + ray.dir.x * t, y: planeY, z: ray.origin.z + ray.dir.z * t };
}

/** The coordinate that runs along a wall: x for north/south, z for east/west. */
export function alongOf(wall: WallSide, p: Pick<Vec3, "x" | "z">): number {
  return wall === "north" || wall === "south" ? p.x : p.z;
}

export interface WallHit {
  wall: WallSide;
  /** Room coordinate along the wall (x or z). */
  along: number;
  /** Height on the wall, or null when the pointer is over the floor (caller keeps the current height). */
  y: number | null;
}

/**
 * Where a pointer ray lands on the room's walls, for dragging wall-mounted items.
 * The ray leaves the room through exactly one wall (the one you see behind the room's interior) —
 * walls the ray enters through (the cut-away ones nearest the camera) are ignored.
 * If the ray hits the floor first, the floor point's nearest wall is used and the height is left alone.
 */
export function wallDragTarget(ray: Ray, room: Room): WallHit | null {
  let best: { t: number; hit: WallHit } | null = null;
  for (const wall of WALL_SIDES) {
    const f = wallFrame(wall, room);
    const dn = ray.dir.x * f.normal.x + ray.dir.z * f.normal.z;
    if (dn <= 1e-9) continue; // travelling into the room (or parallel)
    // Signed distance of the origin from the wall plane, measured along the outward normal.
    const dist = (f.origin.x - ray.origin.x) * f.normal.x + (f.origin.z - ray.origin.z) * f.normal.z;
    const t = dist / dn;
    if (t <= 0) continue;
    const p = { x: ray.origin.x + ray.dir.x * t, y: ray.origin.y + ray.dir.y * t, z: ray.origin.z + ray.dir.z * t };
    const along = alongOf(wall, p);
    const half = f.length / 2;
    if (Math.abs(along) > half + 1e-6) continue;
    if (p.y < 0) continue; // hits the floor before this wall
    if (!best || t < best.t) best = { t, hit: { wall, along, y: Math.min(p.y, room.height) } };
  }
  if (best) return best.hit;

  const onFloor = intersectHorizontalPlane(ray, 0);
  if (!onFloor) return null;
  const wall = nearestWall(onFloor, room);
  const half = (wall === "north" || wall === "south" ? room.width : room.depth) / 2;
  return { wall, along: Math.max(-half, Math.min(half, alongOf(wall, onFloor))), y: null };
}

/** Where a ray crosses a wall's (infinite) plane, in wall terms; null if the plane is behind the ray. */
export function intersectWallPlane(ray: Ray, room: Room, wall: WallSide): { along: number; y: number } | null {
  const f = wallFrame(wall, room);
  const dn = ray.dir.x * f.normal.x + ray.dir.z * f.normal.z;
  if (Math.abs(dn) < 1e-9) return null;
  const dist = (f.origin.x - ray.origin.x) * f.normal.x + (f.origin.z - ray.origin.z) * f.normal.z;
  const t = dist / dn;
  if (t <= 0) return null;
  const p = { x: ray.origin.x + ray.dir.x * t, y: ray.origin.y + ray.dir.y * t, z: ray.origin.z + ray.dir.z * t };
  return { along: alongOf(wall, p), y: p.y };
}

/**
 * One drag step for a wall-mounted item currently on `currentWall`.
 * Stays on the current wall while the pointer is over it (even when that wall is cut away and the ray
 * exits the room elsewhere); once the pointer leaves the wall's rectangle, moves to the wall under the pointer.
 */
export function wallDragStep(ray: Ray, room: Room, currentWall: WallSide): WallHit | null {
  const exit = wallDragTarget(ray, room);
  if (exit && exit.wall === currentWall) return exit;
  const p = intersectWallPlane(ray, room, currentWall);
  const half = (currentWall === "north" || currentWall === "south" ? room.width : room.depth) / 2;
  if (p && p.y >= 0 && Math.abs(p.along) <= half + 1e-6) return { wall: currentWall, along: p.along, y: Math.min(p.y, room.height) };
  return exit;
}

// Wall placement lives in lib/geometry (the store uses it too); re-exported for the drag code and tests.
export { wallMountPlacement } from "../lib/geometry";

/**
 * Smallest vertical gap (m) between the camera and a horizontal drag plane. Closer than this, pointer rays meet
 * the plane so flat that a few pixels of mouse movement throw the item metres away (a pendant lamp seen from eye
 * height, the top of a tall wardrobe): those drags use screen-space movement instead (see screenDragStart).
 */
export const MIN_PLANE_GAP = 0.5;

/**
 * Height of the horizontal plane a floor/ceiling item is dragged on: through the grabbed point, so the item stays
 * exactly under the cursor. null when that plane is within MIN_PLANE_GAP of the camera's height (use screen-space
 * dragging then).
 */
export function dragPlaneY(grabY: number, cameraY: number): number | null {
  const y = Math.max(0, grabY);
  return Math.abs(y - cameraY) >= MIN_PLANE_GAP ? y : null;
}

/** State of a screen-space drag, fixed when the drag starts. */
export interface ScreenDrag {
  eye: Vec3;
  /** Camera's viewing direction flattened onto the floor (unit vector). */
  forward: { x: number; z: number };
  /** Horizontal distance of the grabbed point in front of the camera when the drag started. */
  depth0: number;
  /** Item position minus the grabbed point (x/z), so the item doesn't jump. */
  offset: { x: number; z: number };
  startClientY: number;
  /** Depth change (m) per pixel of vertical pointer movement. */
  metersPerPx: number;
  /**
   * (Optional) Closest the grabbed point may come (m in front of the camera, horizontally): a floor item is never
   * pulled in under the camera, out of view (see screenDragMinDepth).
   */
  minDepth?: number;
}

/** Closest the grabbed point is ever pulled toward the camera (m, horizontally). */
const MIN_SCREEN_DEPTH = 0.3;

/** Horizontal unit vector of a direction, or null when it points (almost) straight up or down. */
function flatUnit(v: { x: number; z: number }): { x: number; z: number } | null {
  const len = Math.hypot(v.x, v.z);
  return len < 0.3 ? null : { x: v.x / len, z: v.z / len };
}

/** Floor point where a ray crosses the vertical plane `depth` in front of the camera (facing it). */
function pointAtDepth(s: Pick<ScreenDrag, "eye" | "forward">, ray: Ray, depth: number): { x: number; z: number } | null {
  const along = ray.dir.x * s.forward.x + ray.dir.z * s.forward.z;
  if (along < 1e-3) return null;
  const o = { x: ray.origin.x - s.eye.x, z: ray.origin.z - s.eye.z };
  const t = (depth - (o.x * s.forward.x + o.z * s.forward.z)) / along;
  if (t <= 0) return null;
  return { x: ray.origin.x + ray.dir.x * t, z: ray.origin.z + ray.dir.z * t };
}

/**
 * Start a screen-space drag for an item seen almost edge-on to its drag plane (a pendant lamp from the Eye view).
 * Moving the pointer sideways keeps the grabbed point under the cursor; moving it up / down pushes the item away /
 * pulls it closer at a steady `metersPerPx` (an item at eye level barely moves on screen when it moves in depth,
 * so following the cursor exactly there is impossible, and trying is what made it fly across the room).
 * Null if the camera looks (almost) straight down.
 */
export function screenDragStart(
  ray: Ray,
  grabbed: Pick<Vec3, "x" | "z">,
  item: Pick<Vec3, "x" | "z">,
  cameraForward: { x: number; z: number },
  startClientY: number,
  metersPerPx: number,
): ScreenDrag | null {
  const forward = flatUnit(cameraForward);
  if (!forward) return null;
  const eye = ray.origin;
  const depth0 = Math.max(MIN_SCREEN_DEPTH, (grabbed.x - eye.x) * forward.x + (grabbed.z - eye.z) * forward.z);
  return {
    eye,
    forward,
    depth0,
    offset: { x: item.x - grabbed.x, z: item.z - grabbed.z },
    startClientY,
    metersPerPx,
  };
}

/** Item x/z for the pointer's current ray and client y, or null if the ray doesn't point into the view. */
export function screenDragStep(s: ScreenDrag, ray: Ray, clientY: number): { x: number; z: number } | null {
  const depth = Math.max(s.minDepth ?? MIN_SCREEN_DEPTH, s.depth0 + (s.startClientY - clientY) * s.metersPerPx);
  const p = pointAtDepth(s, ray, depth);
  return p ? { x: p.x + s.offset.x, z: p.z + s.offset.z } : null;
}

/**
 * Screen-space drag step for a FLOOR item (the Eye view): as screenDragStep, but never farther from the camera than
 * where the pointer's ray meets the floor. Pointing at the floor nearer than the item's screen-drag depth (the floor in
 * front of the cat tower the cat was on) puts the item at that floor spot (`floor` true). Both rules meet at the same
 * point (up to the small grab offset), so the item doesn't jump when one takes over from the other. `aim` is where the pointer's ray
 * meets the floor (absent when it points above the horizon). Null as screenDragStep.
 */
export function screenFloorDragStep(
  s: ScreenDrag,
  ray: Ray,
  clientY: number,
): { x: number; z: number; floor: boolean; aim?: { x: number; z: number } } | null {
  const depth = Math.max(s.minDepth ?? MIN_SCREEN_DEPTH, s.depth0 + (s.startClientY - clientY) * s.metersPerPx);
  const hit = intersectHorizontalPlane(ray, 0);
  const aim = hit ? { x: hit.x, z: hit.z } : undefined;
  if (hit) {
    const floorDepth = (hit.x - s.eye.x) * s.forward.x + (hit.z - s.eye.z) * s.forward.z;
    // The item goes right where the pointer is (no grab offset: that could put it inside the support it is being
    // dragged off). The pointer is on screen, so the item stays in view (minDepth only keeps the depth-only drag in view).
    if (floorDepth < depth && floorDepth >= MIN_SCREEN_DEPTH) return { x: hit.x, z: hit.z, floor: true, aim };
  }
  const p = pointAtDepth(s, ray, depth);
  return p ? { x: p.x + s.offset.x, z: p.z + s.offset.z, floor: false, aim } : null;
}

/** Items this low (m: a rug, a mat) are still "the floor" for a floor spot: things stand on them. */
const FLOOR_LEVEL = 0.1;

/**
 * Where a floor item goes at `xz` while the pointer points at the floor at `aim` without pointing at any surface (the
 * Eye view's screen-space drag): the floor there — under a support whose footprint the spot is inside when it fits
 * under it, on a rug there — and otherwise moved toward `aim` (or toward the camera, against `forward`, when there is
 * no usable aim) until its center is clear of every support. It never vanishes inside a support and never jumps up
 * onto the top of one the pointer isn't pointing at (such as the one the drag started on).
 */
export function floorSpotTarget(
  item: PlacedItem,
  xz: { x: number; z: number },
  items: PlacedItem[],
  aim: { x: number; z: number },
  forward: { x: number; z: number },
  step: number,
): FloorDragTarget {
  const supports = items.filter((s) => canSupport(item.id, s, items));
  const snap = (p: { x: number; z: number }) => ({ x: snapValue(p.x, step), z: snapValue(p.z, step) });
  const p = snap(xz);
  for (const s of supports) {
    if (!pointInFootprint(p, s)) continue;
    const under = supportSurfaces(s).find((sf) => sf.kind === "under");
    if (under && fitsSurfaceAt(item, s, under, worldToSupport(s, p))) return { ...p, support: s, surfaceY: storedSurfaceY(s, under), y: s.position.y };
  }
  const isLow = (s: PlacedItem) => s.position.y + s.dims.h <= FLOOR_LEVEL;
  const low = findSurfaceAt(item, p, [item, ...supports.filter(isLow)]);
  if (low) return { ...p, support: low.support, surfaceY: storedSurfaceY(low.support, low.surface), y: low.support.position.y + low.surface.y };
  const inside = (q: { x: number; z: number }) => supports.some((s) => !isLow(s) && pointInFootprint(q, s));
  if (!inside(p)) return { ...p, support: null, y: 0 };
  // Toward where the pointer is (the floor in front of the support), else toward the camera.
  let dir = { x: aim.x - p.x, z: aim.z - p.z };
  if (Math.hypot(dir.x, dir.z) < 0.01 || inside(aim)) dir = { x: -forward.x, z: -forward.z };
  const len = Math.hypot(dir.x, dir.z) || 1;
  let q = p;
  for (let k = 1; k <= 400 && inside(q); k++) q = snap({ x: p.x + (dir.x / len) * 0.01 * k, z: p.z + (dir.z / len) * 0.01 * k });
  return { ...q, support: null, y: 0 };
}

/**
 * Least depth (m in front of the camera) for a screen-space drag of a floor item: where the bottom of the view meets
 * the floor (`bottomRay`: the ray through the bottom-center of the view), plus half the item's depth, so it never goes
 * under the camera and out of view. MIN_SCREEN_DEPTH when the bottom of the view doesn't reach the floor.
 */
export function screenDragMinDepth(bottomRay: Ray, forward: { x: number; z: number }, itemHalfDepth: number): number {
  const f = flatUnit(forward);
  const hit = intersectHorizontalPlane(bottomRay, 0);
  if (!f || !hit) return MIN_SCREEN_DEPTH;
  const d = (hit.x - bottomRay.origin.x) * f.x + (hit.z - bottomRay.origin.z) * f.z;
  return Math.max(MIN_SCREEN_DEPTH, d + itemHalfDepth);
}

/** Depth per pixel for screen-space drags: crossing the room's longer side takes about 3/4 of the view's height. */
export function screenDragMetersPerPx(room: Pick<Room, "width" | "depth">, viewHeightPx: number): number {
  return Math.max(room.width, room.depth) / Math.max(1, viewHeightPx * 0.75);
}

/**
 * Screen-aligned nudge axes on the floor, snapped to the room axes.
 * `forward` is the camera's viewing direction projected on the floor (any length).
 * Returns unit vectors for "up arrow" (forward) and "right arrow" (right).
 */
export function nudgeAxes(forward: { x: number; z: number }): { forward: { x: number; z: number }; right: { x: number; z: number } } {
  const f =
    Math.abs(forward.x) > Math.abs(forward.z)
      ? { x: Math.sign(forward.x) || 1, z: 0 }
      : { x: 0, z: Math.sign(forward.z) || -1 };
  // Rotate forward 90° clockwise seen from above: looking north (0,-1) → right is east (1,0).
  return { forward: f, right: { x: -f.z || 0, z: f.x || 0 } };
}
