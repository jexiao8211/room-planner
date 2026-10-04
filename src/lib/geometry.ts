import type { Dims, Mount, PlacedItem, Room, ShapePart, Vec3, WallSide } from "../shared/types";
import type { PlacementHint } from "./queryFilters";

/** Half-extents of an item's footprint on the floor after rotation about Y. */
export function footprintHalfExtents(dims: Dims, rotationY: number): { hx: number; hz: number } {
  const c = Math.abs(Math.cos(rotationY));
  const s = Math.abs(Math.sin(rotationY));
  return {
    hx: (dims.w * c + dims.d * s) / 2,
    hz: (dims.w * s + dims.d * c) / 2,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  if (lo > hi) return (lo + hi) / 2; // item larger than room: center it
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Keep an item fully inside the room and apply its mount's vertical rule. A floor item resting on another item
 * (supportId) keeps its height; settleStacks seats it on its support.
 */
export function constrainToRoom(item: Pick<PlacedItem, "position" | "dims" | "rotationY" | "mount" | "supportId">, room: Room): Vec3 {
  const { hx, hz } = footprintHalfExtents(item.dims, item.rotationY);
  const x = clamp(item.position.x, -room.width / 2 + hx, room.width / 2 - hx);
  const z = clamp(item.position.z, -room.depth / 2 + hz, room.depth / 2 - hz);
  let y = item.position.y;
  if (item.mount === "floor") y = item.supportId ? Math.max(0, y) : 0;
  else if (item.mount === "ceiling") y = Math.max(0, room.height - item.dims.h);
  // Wall mount: keep fully between floor and ceiling; an item taller than the room sits on the floor.
  else y = Math.max(0, Math.min(room.height - item.dims.h, Math.max(0, y)));
  return { x, y, z };
}

/** Which wall is closest to a point on the floor. */
export function nearestWall(p: Pick<Vec3, "x" | "z">, room: Pick<Room, "width" | "depth">): WallSide {
  const dists: Record<WallSide, number> = {
    north: p.z + room.depth / 2,
    south: room.depth / 2 - p.z,
    west: p.x + room.width / 2,
    east: room.width / 2 - p.x,
  };
  return (Object.keys(dists) as WallSide[]).reduce((a, b) => (dists[a] <= dists[b] ? a : b));
}

/** Rotation that makes an item's front (+z face) look away from the given wall, into the room. */
export function rotationFacingAwayFrom(wall: WallSide): number {
  switch (wall) {
    case "north":
      return 0;
    case "south":
      return Math.PI;
    case "west":
      return Math.PI / 2;
    case "east":
      return -Math.PI / 2;
  }
}

/** Push an item flush against its nearest wall, back to the wall, facing into the room. */
export function snapToNearestWall(item: PlacedItem, room: Room): Pick<PlacedItem, "position" | "rotationY"> {
  const wall = nearestWall(item.position, room);
  const rotationY = rotationFacingAwayFrom(wall);
  const { hx, hz } = footprintHalfExtents(item.dims, rotationY);
  const p = { ...item.position };
  if (wall === "north") p.z = -room.depth / 2 + hz;
  if (wall === "south") p.z = room.depth / 2 - hz;
  if (wall === "west") p.x = -room.width / 2 + hx;
  if (wall === "east") p.x = room.width / 2 - hx;
  return { position: constrainToRoom({ ...item, position: p, rotationY }, room), rotationY };
}

export type Corner = "nw" | "ne" | "sw" | "se";

/**
 * The room corner nearest to a point. Ties (an item on a center line) go to the north / west side: the corners
 * whose walls stay visible from the default south-east camera, instead of the cut-away corner right in front of it.
 */
export function nearestCorner(p: Pick<Vec3, "x" | "z">): Corner {
  return `${p.z <= 0 ? "n" : "s"}${p.x <= 0 ? "w" : "e"}` as Corner;
}

/** Push an item into the room corner nearest to it (lamps keep a gap from the walls, see cornerInset). */
export function snapToNearestCorner(item: PlacedItem, room: Room): Pick<PlacedItem, "position"> {
  return snapToCorner(item, room, nearestCorner(item.position));
}

/**
 * Gap (m) kept between an item and both walls when it is snapped into a corner. Lamps don't sit flush in a
 * corner (a pendant shade touching two walls looks wrong); furniture does.
 */
export function cornerInset(item: Pick<PlacedItem, "mount" | "name">): number {
  if (item.mount === "ceiling") return 0.3;
  if (item.mount === "floor" && /\b(lamp|light|lantern|torchiere)\b/i.test(item.name)) return 0.3;
  return 0;
}

/** Put an item into a specific corner (north = back wall), `inset` meters away from both walls. */
export function snapToCorner(item: PlacedItem, room: Room, corner: Corner, inset = cornerInset(item)): Pick<PlacedItem, "position"> {
  const { hx, hz } = footprintHalfExtents(item.dims, item.rotationY);
  const x = corner.endsWith("w") ? -room.width / 2 + hx + inset : room.width / 2 - hx - inset;
  const z = corner.startsWith("n") ? -room.depth / 2 + hz + inset : room.depth / 2 - hz - inset;
  return { position: constrainToRoom({ ...item, position: { ...item.position, x, z } }, room) };
}

/** Position (bottom-center) and rotation for an item hung on a wall, back flush to it, facing the room. */
export function wallMountPlacement(
  wall: WallSide,
  along: number,
  y: number,
  dims: Dims,
  room: Pick<Room, "width" | "depth">,
  rotationY: number = rotationFacingAwayFrom(wall),
): { position: Vec3; rotationY: number } {
  const { hx, hz } = footprintHalfExtents(dims, rotationY);
  switch (wall) {
    case "north":
      return { position: { x: along, y, z: -room.depth / 2 + hz }, rotationY };
    case "south":
      return { position: { x: along, y, z: room.depth / 2 - hz }, rotationY };
    case "west":
      return { position: { x: -room.width / 2 + hx, y, z: along }, rotationY };
    case "east":
      return { position: { x: room.width / 2 - hx, y, z: along }, rotationY };
  }
}

/** The wall a wall-mounted item with this rotation faces away from, or null if it isn't square to a wall. */
export function wallFromRotation(rotationY: number): WallSide | null {
  const near = (a: number) => Math.abs(Math.atan2(Math.sin(rotationY - a), Math.cos(rotationY - a))) < 1e-3;
  if (near(0)) return "north";
  if (near(Math.PI)) return "south";
  if (near(Math.PI / 2)) return "west";
  if (near(-Math.PI / 2)) return "east";
  return null;
}

/** Distance (m) from a floor point to a wall's line. */
export function distanceToWall(p: Pick<Vec3, "x" | "z">, wall: WallSide, room: Pick<Room, "width" | "depth">): number {
  switch (wall) {
    case "north":
      return p.z + room.depth / 2;
    case "south":
      return room.depth / 2 - p.z;
    case "west":
      return p.x + room.width / 2;
    case "east":
      return room.width / 2 - p.x;
  }
}

/** How much farther than the nearest wall a wall item's rotation wall may be and still be trusted (m). */
const ROTATION_WALL_SLACK = 0.25;

/**
 * The wall a wall-mounted item belongs on. Its rotation names a wall, but a rotation is only trusted when it
 * agrees with where the item is: the item's back is (nearly) flush with that wall, or that wall is about as close
 * as the nearest one. Otherwise (e.g. a TV from a photo estimate standing against the east wall with the default
 * rotation 0) the nearest wall wins, instead of moving the item across the room.
 */
export function wallForItem(item: Pick<PlacedItem, "position" | "dims" | "rotationY">, room: Pick<Room, "width" | "depth">): WallSide {
  const nearest = nearestWall(item.position, room);
  const byRotation = wallFromRotation(item.rotationY);
  if (!byRotation || byRotation === nearest) return nearest;
  const dRot = distanceToWall(item.position, byRotation, room);
  const flush = Math.abs(dRot - item.dims.d / 2) < 0.02;
  return flush || dRot <= distanceToWall(item.position, nearest, room) + ROTATION_WALL_SLACK ? byRotation : nearest;
}

/**
 * Keep a wall-mounted item flush against a wall, facing into the room. Its position along the wall and its
 * height are kept (and clamped). `wall` defaults to wallForItem: the wall its rotation faces away from when that
 * agrees with its position, else the nearest one.
 */
export function attachToWall(
  item: Pick<PlacedItem, "position" | "dims" | "rotationY">,
  room: Room,
  wall: WallSide = wallForItem(item, room),
): { position: Vec3; rotationY: number } {
  const along = wall === "north" || wall === "south" ? item.position.x : item.position.z;
  const placed = wallMountPlacement(wall, along, item.position.y, item.dims, room);
  return { position: constrainToRoom({ ...placed, dims: item.dims, mount: "wall" }, room), rotationY: placed.rotationY };
}

/** Height a new wall item hangs at (bottom edge), lowered so it fits under the ceiling. */
function wallItemY(dims: Dims, room: Room): number {
  return Math.min(1.5, Math.max(0, room.height - dims.h));
}

const OPENING_MARGIN = 0.05;

/** True if a wall item centered at `along` (room coordinate) at height y would cover a door or window. */
export function coversOpening(wall: WallSide, along: number, y: number, dims: Dims, room: Room): boolean {
  const len = wall === "north" || wall === "south" ? room.width : room.depth;
  const u = along + len / 2; // openings measure from the wall's min end
  return room.openings.some(
    (o) =>
      o.wall === wall &&
      u - dims.w / 2 < o.offset + o.width / 2 + OPENING_MARGIN &&
      u + dims.w / 2 > o.offset - o.width / 2 - OPENING_MARGIN &&
      y < o.sill + o.height + OPENING_MARGIN &&
      y + dims.h > o.sill - OPENING_MARGIN,
  );
}

/** Walls tried for new wall items: the two that face the default (south-east) camera first. */
const WALL_ORDER: WallSide[] = ["north", "west", "east", "south"];
/** Grid step (m) of the free-spot search for new floor/ceiling items. */
const GRID = 0.1;

/** 0, +step, -step, +2·step, -2·step, ... up to ±half. */
function outward(half: number, step: number): number[] {
  const out = [0];
  for (let k = step; k <= half + 1e-9; k += step) out.push(k, -k);
  return out;
}

function probeItem(position: Vec3, dims: Dims, rotationY: number, mount: Mount): PlacedItem {
  return { id: "__probe", name: "", position, rotationY, dims, mount, color: "#000000", parts: [], origin: "shape" };
}

/**
 * Default position for a newly added (or previewed) item.
 * Floor/ceiling: the room center or, when `items` are given and something is already there, the free spot
 * nearest the center (10 cm grid) whose bounding box doesn't intersect any visible item. A ceiling item only
 * collides with things that reach up to it, so it effectively avoids other ceiling items and tall furniture.
 * Wall: flush against a wall (north, then west, east, south) at ~1.5 m, on a stretch clear of doors, windows
 * and other items. When nothing is free: a floor/ceiling item goes to the spot overlapping the least, a wall item
 * to the middle of the north wall (check the result with footprintsOverlap to warn the user).
 */
export function defaultPlacement(dims: Dims, mount: Mount, room: Room, items: PlacedItem[] = []): { position: Vec3; rotationY: number } {
  const others = items.filter((it) => !it.hidden);
  const blocked = (position: Vec3, rotationY: number) => {
    const p = probeItem(position, dims, rotationY, mount);
    return others.some((o) => footprintsOverlap(p, o));
  };

  if (mount === "wall") {
    const y = wallItemY(dims, room);
    for (const wall of WALL_ORDER) {
      const len = wall === "north" || wall === "south" ? room.width : room.depth;
      for (const along of outward(Math.max(0, len / 2 - dims.w / 2), 0.05)) {
        if (coversOpening(wall, along, y, dims, room)) continue;
        const placed = wallMountPlacement(wall, along, y, dims, room);
        const position = constrainToRoom({ ...placed, dims, mount }, room);
        if (blocked(position, placed.rotationY)) continue;
        return { position, rotationY: placed.rotationY };
      }
    }
    const rotationY = 0;
    const position = { x: 0, y, z: -room.depth / 2 + dims.d / 2 };
    return { position: constrainToRoom({ position, dims, rotationY, mount }, room), rotationY };
  }

  const center = constrainToRoom({ position: { x: 0, y: 0, z: 0 }, dims, rotationY: 0, mount }, room);
  if (!blocked(center, 0)) return { position: center, rotationY: 0 };
  const xs = outward(Math.max(0, room.width / 2 - dims.w / 2), GRID);
  const zs = outward(Math.max(0, room.depth / 2 - dims.d / 2), GRID);
  const spots = xs.flatMap((x) => zs.map((z) => ({ x, z }))).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
  // No free spot: the one that overlaps the least (footprint area shared with others), not the room center.
  let best = { position: center, area: Infinity };
  for (const s of spots) {
    const position = constrainToRoom({ position: { x: s.x, y: 0, z: s.z }, dims, rotationY: 0, mount }, room);
    if (!blocked(position, 0)) return { position, rotationY: 0 };
    const p = probeItem(position, dims, 0, mount);
    const area = others.reduce((sum, o) => sum + overlapArea(p, o), 0);
    if (area < best.area - 1e-9) best = { position, area };
  }
  return { position: best.position, rotationY: 0 };
}

/** Floor area (m²) two items' footprints share, 0 when they don't collide (see footprintsOverlap). */
export function overlapArea(a: PlacedItem, b: PlacedItem): number {
  if (!footprintsOverlap(a, b)) return 0;
  const ea = footprintHalfExtents(a.dims, a.rotationY);
  const eb = footprintHalfExtents(b.dims, b.rotationY);
  const ox = Math.min(a.position.x + ea.hx, b.position.x + eb.hx) - Math.max(a.position.x - ea.hx, b.position.x - eb.hx);
  const oz = Math.min(a.position.z + ea.hz, b.position.z + eb.hz) - Math.max(a.position.z - ea.hz, b.position.z - eb.hz);
  return Math.max(0, ox) * Math.max(0, oz);
}

/** Corners tried for "in the corner": the two at the back first (visible from the default south-east camera). */
const CORNER_ORDER: Corner[] = ["nw", "ne", "sw", "se"];

/**
 * A floor or ceiling item pushed into the first corner (nw, ne, sw, se) where it doesn't collide with any visible
 * item, inset from the walls like snapToCorner does (lamps keep a gap). Null for wall items or when every corner
 * is taken.
 */
export function freeCornerPlacement(
  dims: Dims,
  mount: Mount,
  name: string,
  room: Room,
  items: PlacedItem[] = [],
): { position: Vec3; rotationY: number } | null {
  if (mount === "wall") return null;
  const others = items.filter((it) => !it.hidden);
  const probe = { ...probeItem({ x: 0, y: 0, z: 0 }, dims, 0, mount), name };
  for (const corner of CORNER_ORDER) {
    const { position } = snapToCorner(probe, room, corner);
    if (!others.some((o) => footprintsOverlap({ ...probe, position }, o))) return { position, rotationY: 0 };
  }
  return null;
}

/** Where a new product goes: a free corner when the search asked for one, else defaultPlacement. */
export function placementForNewItem(
  dims: Dims,
  mount: Mount,
  name: string,
  room: Room,
  items: PlacedItem[],
  hint: PlacementHint | null = null,
): { position: Vec3; rotationY: number } {
  return (hint === "corner" ? freeCornerPlacement(dims, mount, name, room, items) : null) ?? defaultPlacement(dims, mount, room, items);
}

/** A hanging item whose bottom would end up lower than this (m) is treated as listing its maximum cord drop. */
export const MIN_HANGING_BOTTOM = 1.2;
/** Where the bottom of such a pendant ends up once its cord is shortened (open-floor clearance). */
export const TARGET_HANGING_BOTTOM = 1.9;

/** A thin vertical rod/cord part: at most ~6 cm across in real size. */
function isCord(p: ShapePart, dims: Dims): boolean {
  return (p.kind === "cylinder" || p.kind === "box") && p.size.x * dims.w <= 0.06 && p.size.z * dims.d <= 0.06;
}

/**
 * Listings often state a pendant's MAXIMUM cord length, which can put the shade on the floor of a normal room.
 * When a hanging item would hang lower than MIN_HANGING_BOTTOM, shorten its cord so the bottom sits at
 * TARGET_HANGING_BOTTOM. Parts below the cord (the shade) keep their real size, cord parts shrink, and parts
 * above it (a ceiling canopy) stay at the top. Items without a recognizable cord are returned unchanged.
 */
export function fitHangingItem(dims: Dims, parts: ShapePart[], roomHeight: number): { dims: Dims; parts: ShapePart[] } {
  const h = dims.h;
  if (roomHeight - h >= MIN_HANGING_BOTTOM) return { dims, parts };
  const span = (p: ShapePart) => ({ y0: (p.center.y - p.size.y / 2) * h, y1: (p.center.y + p.size.y / 2) * h });
  const cords = parts.filter((p) => isCord(p, dims));
  if (!cords.length) return { dims, parts };
  const cordBottom = Math.min(...cords.map((p) => span(p).y0));
  const others = parts.filter((p) => !cords.includes(p));
  const canopy = others.filter((p) => span(p).y0 >= cordBottom - 1e-6);
  const canopyH = canopy.length ? h - Math.min(...canopy.map((p) => span(p).y0)) : 0;
  const minH = cordBottom + canopyH + 0.05;
  const newH = Math.max(minH, roomHeight - TARGET_HANGING_BOTTOM);
  if (newH >= h - 1e-6) return { dims, parts };
  const shift = newH - h;
  // Cord heights in [cordBottom, h] are squeezed linearly into [cordBottom, newH].
  const squeeze = (y: number) => cordBottom + ((y - cordBottom) * (newH - cordBottom)) / (h - cordBottom);
  const next = parts.map((p): ShapePart => {
    let { y0, y1 } = span(p);
    if (cords.includes(p)) {
      y0 = squeeze(y0);
      y1 = squeeze(y1);
    } else if (canopy.includes(p)) {
      y0 += shift;
      y1 += shift;
    }
    return { ...p, center: { ...p.center, y: (y0 + y1) / 2 / newH }, size: { ...p.size, y: Math.min(1, Math.max(1e-3, (y1 - y0) / newH)) } };
  });
  return { dims: { ...dims, h: newH }, parts: next };
}

/** Thinnest cord (m) added to an item hung from the ceiling that has none. */
const ADDED_CORD = 0.012;
/** Lowest a hanging item's bottom may come (m above the floor). */
export const MIN_HANG_BOTTOM = 0.3;

/**
 * Re-shape an item to hang `drop` meters below the ceiling (ceiling → its bottom; for a ceiling item that is its
 * height). Cord parts (thin vertical rods) stretch or shrink while the shade and any canopy keep their real size; an
 * item without a cord gets one, from its top up to the ceiling, when the drop is longer than the item itself.
 * The drop is clamped between the item's body (cords at their shortest) and `maxDrop`; `drop` in the result is
 * what was used.
 */
export function setHangingDrop(dims: Dims, parts: ShapePart[], drop: number, maxDrop = Infinity): { dims: Dims; parts: ShapePart[]; drop: number } {
  const h = dims.h;
  const span = (p: ShapePart) => ({ y0: (p.center.y - p.size.y / 2) * h, y1: (p.center.y + p.size.y / 2) * h });
  const cords = parts.filter((p) => isCord(p, dims));
  const toPart = (p: ShapePart, y0: number, y1: number, newH: number): ShapePart => ({
    ...p,
    center: { ...p.center, y: (y0 + y1) / 2 / newH },
    size: { ...p.size, y: Math.min(1, Math.max(1e-3, (y1 - y0) / newH)) },
  });
  if (!cords.length || !parts.length) {
    // No cord: the body keeps its size at the bottom and a new cord runs from its top to the ceiling.
    const bodyH = h;
    const newH = Math.max(bodyH, Math.min(drop, maxDrop));
    if (newH <= bodyH + 0.02) return { dims, parts, drop: bodyH };
    const body = (parts.length ? parts : [{ kind: "box" as const, center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } }]).map((p) => {
      const { y0, y1 } = span(p);
      return toPart(p, y0, y1, newH);
    });
    const cord: ShapePart = {
      kind: "cylinder",
      center: { x: 0, y: (bodyH + newH) / 2 / newH, z: 0 },
      size: { x: Math.min(1, ADDED_CORD / dims.w), y: (newH - bodyH) / newH, z: Math.min(1, ADDED_CORD / dims.d) },
      color: "#333333",
    };
    return { dims: { ...dims, h: newH }, parts: [...body, cord], drop: newH };
  }
  const cordBottom = Math.min(...cords.map((p) => span(p).y0));
  const others = parts.filter((p) => !cords.includes(p));
  const canopy = others.filter((p) => span(p).y0 >= cordBottom - 1e-6);
  const canopyH = canopy.length ? h - Math.min(...canopy.map((p) => span(p).y0)) : 0;
  const minH = cordBottom + canopyH + 0.02;
  const newH = Math.max(minH, Math.min(drop, Math.max(minH, maxDrop)));
  if (Math.abs(newH - h) < 1e-6) return { dims, parts, drop: h };
  const shift = newH - h;
  // Cord heights in [cordBottom, h] map linearly onto [cordBottom, newH] (as in fitHangingItem); the canopy moves
  // with the top.
  const scale = (y: number) => cordBottom + ((y - cordBottom) * (newH - cordBottom)) / Math.max(1e-6, h - cordBottom);
  const next = parts.map((p): ShapePart => {
    let { y0, y1 } = span(p);
    if (canopy.includes(p)) {
      y0 += shift;
      y1 += shift;
    } else if (cords.includes(p)) {
      y0 = scale(y0);
      y1 = scale(y1);
    }
    return toPart(p, y0, y1, newH);
  });
  return { dims: { ...dims, h: newH }, parts: next, drop: newH };
}

/**
 * How far below the ceiling an item hangs when it is hung up without a drop given: a ceiling item keeps its drop; a
 * lamp-like item (`lampLike`) gets the usual pendant drop (bottom ~1.9 m above the floor, see fitHangingItem) when
 * it is shorter than that; anything else hangs flush under the ceiling (its own height).
 */
export function defaultHangDrop(item: Pick<PlacedItem, "dims" | "mount">, roomHeight: number, lampLike: boolean): number {
  if (item.mount === "ceiling") return item.dims.h;
  if (lampLike) return Math.max(item.dims.h, roomHeight - TARGET_HANGING_BOTTOM);
  return item.dims.h;
}

/**
 * A standing lamp taken up to the ceiling keeps only its shade (the non-cord parts in its upper half; its base and
 * stem go) so it hangs as a pendant with a cord instead of an upright floor lamp floating in the air. Null when there
 * is no such shade (a single part, or nothing up top).
 */
export function lampShade(dims: Dims, parts: ShapePart[]): { dims: Dims; parts: ShapePart[] } | null {
  const h = dims.h;
  if (parts.length < 2) return null;
  const span = (p: ShapePart) => ({ y0: (p.center.y - p.size.y / 2) * h, y1: (p.center.y + p.size.y / 2) * h });
  const top = parts.filter((p) => !isCord(p, dims) && span(p).y0 >= 0.5 * h - 1e-6);
  if (!top.length || top.length === parts.length) return null;
  const y0 = Math.min(...top.map((p) => span(p).y0));
  const newH = Math.max(0.02, h - y0);
  const next = top.map((p): ShapePart => {
    const sp = span(p);
    return { ...p, center: { ...p.center, y: (sp.y0 + sp.y1 - 2 * y0) / 2 / newH }, size: { ...p.size, y: Math.min(1, Math.max(1e-3, (sp.y1 - sp.y0) / newH)) } };
  });
  return { dims: { ...dims, h: newH }, parts: next };
}

/** Axis-aligned footprint overlap test (uses rotated footprint extents). */
export function footprintsOverlap(a: PlacedItem, b: PlacedItem): boolean {
  const ea = footprintHalfExtents(a.dims, a.rotationY);
  const eb = footprintHalfExtents(b.dims, b.rotationY);
  const overlapXZ =
    Math.abs(a.position.x - b.position.x) < ea.hx + eb.hx - 1e-6 &&
    Math.abs(a.position.z - b.position.z) < ea.hz + eb.hz - 1e-6;
  const overlapY = a.position.y < b.position.y + b.dims.h - 1e-6 && b.position.y < a.position.y + a.dims.h - 1e-6;
  return overlapXZ && overlapY;
}

const WALL_NAMES: Record<WallSide, string> = { north: "back (north)", south: "front (south)", west: "left (west)", east: "right (east)" };
const CORNER_NAMES: Record<Corner, string> = { nw: "back-left (north-west)", ne: "back-right (north-east)", sw: "front-left (south-west)", se: "front-right (south-east)" };

/** Short words for where an item stands, e.g. "in the back-left (north-west) corner" (used in search prompts). */
export function describePlacement(item: Pick<PlacedItem, "position" | "dims" | "rotationY" | "mount">, room: Room): string {
  const { hx, hz } = footprintHalfExtents(item.dims, item.rotationY);
  const gapX = room.width / 2 - (Math.abs(item.position.x) + hx);
  const gapZ = room.depth / 2 - (Math.abs(item.position.z) + hz);
  const near = 0.6; // m from a wall that still reads as "against" / "in the corner"
  if (item.mount === "wall") return `on the ${WALL_NAMES[nearestWall(item.position, room)]} wall`;
  if (gapX < near && gapZ < near) return `in the ${CORNER_NAMES[nearestCorner(item.position)]} corner`;
  if (gapX < near || gapZ < near) return `against the ${WALL_NAMES[nearestWall(item.position, room)]} wall`;
  return item.mount === "ceiling" ? "hanging over the middle of the room" : "in the middle of the room";
}

// ---------- Stacking (items resting on other items) ----------

/** How much larger than a support's top an item's footprint may be (per axis) and still rest on it. */
export const STACK_SIZE_RATIO = 1.5;
const EPS = 1e-6;

/** Height of the top of an item's bounding box (where things rest on it unless they sit on a lower surface). */
export function supportTop(s: Pick<PlacedItem, "position" | "dims">): number {
  return s.position.y + s.dims.h;
}

// ---------- Surfaces of a support (part-aware stacking) ----------

/**
 * A flat surface something can rest on, in its support's own frame: a part's upward-facing top (a desk top, a cat
 * tower's platforms, a bed's mattress) or the floor underneath it ("under", between a desk's legs).
 */
export interface SupportSurface {
  /** Height above the support's base (m), as PlacedItem.supportSurfaceY stores it. 0 = the floor under it. */
  y: number;
  kind: "top" | "level" | "under";
  /** Rectangle the surface covers, in the support's frame (x along its width, z along its depth), meters. */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Parts narrower than this (m) in either direction (legs, posts, a headboard's top edge) are not surfaces. */
const MIN_SURFACE = 0.15;
/** Least free height (m) above a spot for it to count as open (not inside or right under another part). */
const MIN_OPEN = 0.05;
/** Surfaces within this (m) of each other are the same surface. */
const SAME_SURFACE = 0.01;

interface PartBox {
  flat: boolean;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

/** Each part's bounding box in meters, in the item's frame. An item without parts is one solid box. */
function partBoxes(s: Pick<PlacedItem, "dims" | "parts">): PartBox[] {
  const { w, h, d } = s.dims;
  const parts = s.parts?.length ? s.parts : [{ kind: "box" as const, center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } }];
  return parts.map((p) => ({
    flat: p.kind === "box" || p.kind === "cylinder",
    x0: (p.center.x - p.size.x / 2) * w,
    x1: (p.center.x + p.size.x / 2) * w,
    y0: Math.max(0, (p.center.y - p.size.y / 2) * h),
    y1: Math.min(h, (p.center.y + p.size.y / 2) * h),
    z0: (p.center.z - p.size.z / 2) * d,
    z1: (p.center.z + p.size.z / 2) * d,
  }));
}

function clearanceIn(boxes: PartBox[], y: number, lx: number, lz: number): number {
  let c = Infinity;
  for (const b of boxes) {
    if (b.y1 <= y + 1e-3) continue; // below (or the surface itself)
    if (lx <= b.x0 + EPS || lx >= b.x1 - EPS || lz <= b.z0 + EPS || lz >= b.z1 - EPS) continue;
    c = Math.min(c, Math.max(0, b.y0 - y));
  }
  return c;
}

/** Free height (m) above a point (support frame) of the surface at height y: up to the next part above it. */
export function surfaceClearance(s: Pick<PlacedItem, "dims" | "parts">, y: number, lx: number, lz: number): number {
  return clearanceIn(partBoxes(s), y, lx, lz);
}

/** Sample points across a rectangle (5 × 5 grid, edges inset by 1 mm). */
function gridIn(x0: number, x1: number, z0: number, z1: number, n = 5): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) out.push({ x: x0 + 1e-3 + ((x1 - x0 - 2e-3) * i) / (n - 1), z: z0 + 1e-3 + ((z1 - z0 - 2e-3) * j) / (n - 1) });
  return out;
}

/**
 * Every surface of a support, highest first, with the floor underneath it ("under") last when there is room under
 * it. Surfaces are the tops of its box / cylinder parts that are at least MIN_SURFACE across and not entirely covered
 * by another part (a desk's legs end under its top, so they are not surfaces). The highest one is the "top"; an item
 * whose flat parts all sit low (a lamp's base disc, a monitor's foot) or that has none (spheres, cones) keeps its
 * bounding-box top as the "top", as before parts were looked at.
 */
export function supportSurfaces(s: Pick<PlacedItem, "dims" | "parts">): SupportSurface[] {
  const boxes = partBoxes(s);
  const { w, d, h } = s.dims;
  const tops: SupportSurface[] = [];
  for (const b of boxes) {
    if (!b.flat || b.x1 - b.x0 < MIN_SURFACE || b.z1 - b.z0 < MIN_SURFACE || b.y1 <= 1e-3) continue;
    const same = tops.find((t) => Math.abs(t.y - b.y1) < SAME_SURFACE);
    if (same) {
      same.x0 = Math.min(same.x0, b.x0);
      same.x1 = Math.max(same.x1, b.x1);
      same.z0 = Math.min(same.z0, b.z0);
      same.z1 = Math.max(same.z1, b.z1);
    } else tops.push({ y: b.y1, kind: "level", x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1 });
  }
  const open = tops.filter((t) => gridIn(t.x0, t.x1, t.z0, t.z1).some((p) => clearanceIn(boxes, t.y, p.x, p.z) >= MIN_OPEN));
  open.sort((a, b) => b.y - a.y);
  if (!open.length || open[0].y < 0.4 * h) open.unshift({ y: h, kind: "level", x0: -w / 2, x1: w / 2, z0: -d / 2, z1: d / 2 });
  open[0] = { ...open[0], kind: "top" };
  // The top always spans at least the item's footprint (things may overhang a perch the way they overhang a desk).
  const under: SupportSurface = { y: 0, kind: "under", x0: -w / 2, x1: w / 2, z0: -d / 2, z1: d / 2 };
  // Room under it: something covers its middle, high enough off the floor (a desk top on legs; not a bed's base).
  const middle = clearanceIn(boxes, 0, 0, 0);
  const hasUnder = Number.isFinite(middle) && middle >= 0.1;
  return hasUnder ? [...open, under] : open;
}

/** Height above its support's base of the surface a stacked item rests on (its supportSurfaceY, else the top). */
export function surfaceHeight(dep: Pick<PlacedItem, "supportSurfaceY">, support: Pick<PlacedItem, "dims">): number {
  const y = dep.supportSurfaceY;
  return typeof y === "number" && Number.isFinite(y) ? Math.max(0, Math.min(support.dims.h, y)) : support.dims.h;
}

/** Room height (y) where a stacked item's bottom sits on its support. */
export function seatHeight(dep: Pick<PlacedItem, "supportSurfaceY">, support: Pick<PlacedItem, "position" | "dims">): number {
  return support.position.y + surfaceHeight(dep, support);
}

/** A local point of the support (x along its width, z along its depth) in room coordinates, and back. */
export function supportToWorld(s: Pick<PlacedItem, "position" | "rotationY">, l: { x: number; z: number }): { x: number; z: number } {
  return fromLocal(l, s);
}
export function worldToSupport(s: Pick<PlacedItem, "position" | "rotationY">, p: Pick<Vec3, "x" | "z">): { x: number; z: number } {
  return toLocal(p, s);
}

/** True when a point (support frame) lies on a surface's rectangle. */
function onRect(sf: SupportSurface, l: { x: number; z: number }, margin = 0): boolean {
  return l.x >= sf.x0 - margin - EPS && l.x <= sf.x1 + margin + EPS && l.z >= sf.z0 - margin - EPS && l.z <= sf.z1 + margin + EPS;
}

/**
 * Whether an item (turned to `rotationY` in the room) can stand on surface `sf` of `support` with its center at the
 * local point `l`: the center is on the surface, and every part of its footprint over the support has at least the
 * item's height free above it (no leg, post or shelf in the way).
 */
export function fitsAtSpot(
  item: Pick<PlacedItem, "dims">,
  support: Pick<PlacedItem, "dims" | "parts" | "rotationY">,
  sf: SupportSurface,
  l: { x: number; z: number },
  rotationY: number,
): boolean {
  if (!onRect(sf, l)) return false;
  const boxes = partBoxes(support);
  const { hx, hz } = footprintHalfExtents(item.dims, rotationY - support.rotationY);
  const need = item.dims.h - 1e-3;
  // Every part above the surface that reaches over the footprint (not just sample points: a thin leg between them
  // counts too) must leave the item's height free.
  const x0 = l.x - Math.max(0, hx - 2e-3);
  const x1 = l.x + Math.max(0, hx - 2e-3);
  const z0 = l.z - Math.max(0, hz - 2e-3);
  const z1 = l.z + Math.max(0, hz - 2e-3);
  for (const b of boxes) {
    if (b.y1 <= sf.y + 1e-3) continue; // below (or the surface itself)
    if (x1 <= b.x0 + EPS || x0 >= b.x1 - EPS || z1 <= b.z0 + EPS || z0 >= b.z1 - EPS) continue;
    if (b.y0 - sf.y < need) return false;
  }
  return true;
}

/**
 * Where (support frame) an item can stand on a surface, nearest to `prefer` (default: the surface's middle), or null
 * when it doesn't fit anywhere on it. On an open top the item's size follows the stacking rule (STACK_SIZE_RATIO);
 * its footprint is kept on the surface when it fits.
 */
export function surfaceSpot(
  item: Pick<PlacedItem, "dims">,
  support: Pick<PlacedItem, "dims" | "parts" | "rotationY">,
  sf: SupportSurface,
  rotationY: number = support.rotationY,
  prefer?: { x: number; z: number },
): { x: number; z: number } | null {
  const { hx, hz } = footprintHalfExtents(item.dims, rotationY - support.rotationY);
  const sw = sf.x1 - sf.x0;
  const sd = sf.z1 - sf.z0;
  if (sf.kind !== "under" && (hx * 2 > sw * STACK_SIZE_RATIO + EPS || hz * 2 > sd * STACK_SIZE_RATIO + EPS)) return null;
  const cx = (sf.x0 + sf.x1) / 2;
  const cz = (sf.z0 + sf.z1) / 2;
  // Centers that keep the footprint on the surface (the middle when it is wider than the surface).
  const mx = Math.max(0, sw / 2 - hx);
  const mz = Math.max(0, sd / 2 - hz);
  const want = prefer ? { x: clamp(prefer.x, cx - mx, cx + mx), z: clamp(prefer.z, cz - mz, cz + mz) } : { x: cx, z: cz };
  if (fitsAtSpot(item, support, sf, want, rotationY)) return want;
  const step = 0.025;
  const spots: { x: number; z: number }[] = [];
  for (let x = cx - mx; x <= cx + mx + 1e-9; x += step) for (let z = cz - mz; z <= cz + mz + 1e-9; z += step) spots.push({ x, z });
  spots.sort((a, b) => Math.hypot(a.x - want.x, a.z - want.z) - Math.hypot(b.x - want.x, b.z - want.z));
  return spots.find((p) => fitsAtSpot(item, support, sf, p, rotationY)) ?? null;
}

/** The surfaces of `support` an item fits on (see surfaceSpot), highest first; the "under" one last. */
export function surfacesFor(
  item: Pick<PlacedItem, "dims">,
  support: Pick<PlacedItem, "dims" | "parts" | "rotationY">,
  rotationY: number = support.rotationY,
): SupportSurface[] {
  return supportSurfaces(support).filter((sf) => surfaceSpot(item, support, sf, rotationY) !== null);
}

/** The surface of a support at a stored height (supportSurfaceY; absent = the top), if it still has one there. */
export function surfaceAt(support: Pick<PlacedItem, "dims" | "parts">, y: number | undefined): SupportSurface | undefined {
  const all = supportSurfaces(support);
  if (y === undefined || Math.abs(y - support.dims.h) < SAME_SURFACE) return all.find((sf) => sf.kind === "top");
  return all.find((sf) => Math.abs(sf.y - y) < SAME_SURFACE);
}

/** supportSurfaceY to store for a surface: absent for a surface at the support's full height (the default). */
export function storedSurfaceY(support: Pick<PlacedItem, "dims">, sf: Pick<SupportSurface, "y">): number | undefined {
  return Math.abs(sf.y - support.dims.h) < SAME_SURFACE ? undefined : Math.round(sf.y * 10000) / 10000;
}

export type SurfaceLevel = "top" | "middle" | "bottom";

/** Raised surfaces at least this high (m) count as levels; lower ones are a base plate. */
const LEVEL_MIN_Y = 0.1;

/** Which of a support's surfaces (all of them, see supportSurfaces) is its top / middle / bottom level. */
function levelTargets(all: SupportSurface[]): { top?: SupportSurface; middle?: SupportSurface; bottom?: SupportSurface } {
  const raised = all.filter((sf) => sf.kind !== "under");
  if (!raised.length) return {};
  const top = raised[0];
  const up = raised.filter((sf) => sf !== top && sf.y >= LEVEL_MIN_Y);
  if (!up.length) return { top };
  if (up.length === 1) return { top, middle: up[0] };
  const bottom = up[up.length - 1];
  const mid = (top.y + bottom.y) / 2;
  const middle = up.slice(0, -1).reduce((a, b) => (Math.abs(b.y - mid) < Math.abs(a.y - mid) ? b : a));
  return { top, middle, bottom };
}

/**
 * Names of a support's surfaces (pass all of them, see supportSurfaces), as the Inspector and the chat use them:
 * "top"; "middle level" (with one raised level below the top, that one: a cat tower's platform); "bottom level" (the
 * lowest raised one when there are more); "level" for any other in between; "base" for a base plate under 10 cm;
 * "under" for the floor underneath.
 */
export function surfaceNames(all: SupportSurface[]): string[] {
  const t = levelTargets(all);
  return all.map((sf) => {
    if (sf.kind === "under") return "under";
    if (sf === t.top) return "top";
    if (sf === t.middle) return "middle level";
    if (sf === t.bottom) return "bottom level";
    return sf.y < LEVEL_MIN_Y ? "base" : "level";
  });
}

/** The name (see surfaceNames) of the surface of `support` at height y (support frame). */
export function surfaceName(support: Pick<PlacedItem, "dims" | "parts">, y: number): string {
  const all = supportSurfaces(support);
  const k = all.findIndex((sf) => Math.abs(sf.y - y) < SAME_SURFACE);
  return k < 0 ? "top" : surfaceNames(all)[k];
}

/**
 * The surface a chat "level" asks for: the support's top / middle / bottom level (see surfaceNames) when the item
 * fits on it (`fits`, see surfacesFor), else the one it fits on nearest to that height (`exact` false; also when the
 * support has no such level). Null when it fits on no raised surface.
 */
export function pickLevel(
  all: SupportSurface[],
  fits: SupportSurface[],
  level: SurfaceLevel | undefined,
): { surface: SupportSurface; exact: boolean } | null {
  const ok = fits.filter((sf) => sf.kind !== "under");
  if (!ok.length) return null;
  const t = levelTargets(all);
  const want = t[level ?? "top"];
  const same = want && ok.find((sf) => Math.abs(sf.y - want.y) < SAME_SURFACE);
  if (same) return { surface: same, exact: true };
  const y = want?.y ?? (level === "bottom" ? 0 : level === "middle" ? (all[0]?.y ?? 0) / 2 : Infinity);
  return { surface: ok.reduce((a, b) => (Math.abs(b.y - y) < Math.abs(a.y - y) ? b : a)), exact: false };
}

/**
 * The highest surface (no "under") of a valid support whose rectangle contains `center` and where the item fits with
 * its center there, at most `maxY` high in the room. For dropping an item onto what is below it, and for a floor spot
 * that ends up inside a support while dragging. Null = the floor.
 */
export function findSurfaceAt(
  item: PlacedItem,
  center: Pick<Vec3, "x" | "z">,
  items: PlacedItem[],
  maxY = Infinity,
): { support: PlacedItem; surface: SupportSurface } | null {
  if (item.mount !== "floor") return null;
  const blocked = stackDescendants(items, item.id);
  let best: { support: PlacedItem; surface: SupportSurface; y: number } | null = null;
  for (const s of items) {
    if (s.id === item.id || s.hidden || s.mount !== "floor" || blocked.has(s.id)) continue;
    if (!pointInFootprint(center, s)) continue;
    const l = toLocal(center, s);
    for (const sf of supportSurfaces(s)) {
      if (sf.kind === "under") continue;
      const y = s.position.y + sf.y;
      if (y > maxY + 1e-4 || (best && y <= best.y)) continue;
      if (fitsSurfaceAt(item, s, sf, l, item.rotationY)) best = { support: s, surface: sf, y };
    }
  }
  return best ? { support: best.support, surface: best.surface } : null;
}

/**
 * Whether a surface is a real flat face of the support (a box / cylinder part's top at least MIN_SURFACE across, or
 * the floor under it), not the bounding-box top kept for a shape without one (a lamp's cone shade, a sphere).
 */
export function isFlatSurface(s: Pick<PlacedItem, "dims" | "parts">, sf: SupportSurface): boolean {
  if (sf.kind === "under") return true;
  return partBoxes(s).some((b) => b.flat && Math.abs(b.y1 - sf.y) < SAME_SURFACE && b.x1 - b.x0 >= MIN_SURFACE && b.z1 - b.z0 >= MIN_SURFACE);
}

/** The plain top of the first stacking rules: the bounding-box top (nothing can be above it). */
function isOpenTop(s: Pick<PlacedItem, "dims">, sf: SupportSurface): boolean {
  return sf.kind === "top" && Math.abs(sf.y - s.dims.h) < SAME_SURFACE;
}

/**
 * Whether an item may stand with its center at local point `l` on surface `sf`. The bounding-box top keeps the plain
 * size rule (fitsOnTop: it may overhang, as on a desk); lower surfaces also need the item's height free above its
 * footprint, and raised ones the size rule against their own rectangle.
 */
export function fitsSurfaceAt(
  item: Pick<PlacedItem, "dims" | "rotationY">,
  s: Pick<PlacedItem, "dims" | "parts" | "rotationY">,
  sf: SupportSurface,
  l: { x: number; z: number },
  rotationY: number = item.rotationY,
): boolean {
  if (isOpenTop(s, sf)) return fitsOnTop({ dims: item.dims, rotationY }, s);
  if (sf.kind !== "under") {
    const { hx, hz } = footprintHalfExtents(item.dims, rotationY - s.rotationY);
    if (hx * 2 > (sf.x1 - sf.x0) * STACK_SIZE_RATIO + EPS || hz * 2 > (sf.z1 - sf.z0) * STACK_SIZE_RATIO + EPS) return false;
  }
  return fitsAtSpot(item, s, sf, l, rotationY);
}

/** Wrap an angle to (-π, π]. */
function wrapAngle(a: number): number {
  const r = Math.atan2(Math.sin(a), Math.cos(a));
  return r <= -Math.PI + 1e-12 ? Math.PI : r;
}

/** A floor point in an item's local frame (x along its width, z along its depth). */
function toLocal(p: Pick<Vec3, "x" | "z">, item: Pick<PlacedItem, "position" | "rotationY">): { x: number; z: number } {
  const dx = p.x - item.position.x;
  const dz = p.z - item.position.z;
  const c = Math.cos(item.rotationY);
  const s = Math.sin(item.rotationY);
  // three.js rotation about +Y maps local (x, z) to world (x·c + z·s, −x·s + z·c); this is its inverse.
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

/** A local offset (in an item's frame) back to room coordinates. */
function fromLocal(l: { x: number; z: number }, item: Pick<PlacedItem, "position" | "rotationY">): { x: number; z: number } {
  const c = Math.cos(item.rotationY);
  const s = Math.sin(item.rotationY);
  return { x: item.position.x + l.x * c + l.z * s, z: item.position.z - l.x * s + l.z * c };
}

/** True when a floor point lies inside an item's rotated footprint (w × d rectangle), grown by `margin`. */
export function pointInFootprint(p: Pick<Vec3, "x" | "z">, item: Pick<PlacedItem, "position" | "rotationY" | "dims">, margin = 0): boolean {
  const l = toLocal(p, item);
  return Math.abs(l.x) <= item.dims.w / 2 + margin + EPS && Math.abs(l.z) <= item.dims.d / 2 + margin + EPS;
}

/**
 * Whether an item is small enough to rest on a support: its footprint, seen in the support's frame, is at most
 * STACK_SIZE_RATIO × the support's top in each axis. `rotationY` is the item's rotation to test with.
 */
export function fitsOnTop(
  item: Pick<PlacedItem, "dims" | "rotationY">,
  support: Pick<PlacedItem, "dims" | "rotationY">,
  rotationY: number = item.rotationY,
): boolean {
  const { hx, hz } = footprintHalfExtents(item.dims, rotationY - support.rotationY);
  return hx * 2 <= support.dims.w * STACK_SIZE_RATIO + EPS && hz * 2 <= support.dims.d * STACK_SIZE_RATIO + EPS;
}

/** Ids of everything resting on `id`, directly or through other items (cycle-safe). */
export function stackDescendants(items: Pick<PlacedItem, "id" | "supportId">[], id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const it of items) {
    if (!it.supportId) continue;
    const list = children.get(it.supportId) ?? [];
    list.push(it.id);
    children.set(it.supportId, list);
  }
  const out = new Set<string>();
  const todo = [...(children.get(id) ?? [])];
  while (todo.length) {
    const cur = todo.pop()!;
    if (cur === id || out.has(cur)) continue;
    out.add(cur);
    todo.push(...(children.get(cur) ?? []));
  }
  return out;
}

/**
 * Structural rule for "item `itemId` may rest on `support`": the support is a visible floor item, not the item
 * itself and not anything resting on it (no cycles). Size is checked separately (fitsOnTop).
 */
export function canSupport(itemId: string, support: PlacedItem, items: PlacedItem[]): boolean {
  if (support.id === itemId || support.hidden || support.mount !== "floor") return false;
  return !stackDescendants(items, itemId).has(support.id);
}

/**
 * Supports an item may be put on (structurally valid, and big enough once the item is turned to match the
 * support, as placeOnTop does), highest top first. Wall / ceiling items have none.
 */
export function validSupports(item: PlacedItem, items: PlacedItem[]): PlacedItem[] {
  return items
    .filter((s) => canSupport(item.id, s, items) && fitsOnTop(item, s, s.rotationY))
    .sort((a, b) => supportTop(b) - supportTop(a));
}

/** One "Put on…" choice: a support and one of its surfaces the item fits on. */
export interface SurfaceOption {
  support: PlacedItem;
  surface: SupportSurface;
  /** "top", "middle level", "bottom level", "base" or "under" (see surfaceNames). */
  name: string;
}

/**
 * Every surface an item may be put on (Inspector "Put on…"): structurally valid supports (canSupport) and their
 * surfaces the item fits on once turned to match the support (as placeOnTop does), highest first per support,
 * supports by their top height. Wall / ceiling items have none.
 */
export function surfaceOptions(item: PlacedItem, items: PlacedItem[]): SurfaceOption[] {
  if (item.mount !== "floor") return [];
  const out: SurfaceOption[] = [];
  const supports = items.filter((s) => canSupport(item.id, s, items)).sort((a, b) => supportTop(b) - supportTop(a));
  for (const s of supports) {
    for (const surface of surfacesFor(item, s, s.rotationY)) out.push({ support: s, surface, name: surfaceName(s, surface.y) });
  }
  return out;
}

/**
 * The highest valid support whose footprint contains `center` and that the item fits on (with its current
 * rotation), part-aware (see findSurfaceAt). `maxTop` limits the search to surfaces at most that high (for dropping
 * an item onto whatever is below it). Null = the floor. Wall / ceiling items never rest on anything.
 */
export function findSupportAt(item: PlacedItem, center: Pick<Vec3, "x" | "z">, items: PlacedItem[], maxTop = Infinity): PlacedItem | null {
  return findSurfaceAt(item, center, items, maxTop)?.support ?? null;
}

/**
 * Where an item resting on a support ends up when that support moves / turns from `before` to `after`: it keeps
 * its offset in the support's frame, turns with it, and sits on the same surface of it (see seatHeight).
 */
export function carryWithSupport(
  dep: Pick<PlacedItem, "position" | "rotationY" | "supportSurfaceY">,
  before: Pick<PlacedItem, "position" | "rotationY" | "dims">,
  after: Pick<PlacedItem, "position" | "rotationY" | "dims">,
): { position: Vec3; rotationY: number } {
  const p = fromLocal(toLocal(dep.position, before), after);
  return { position: { x: p.x, y: seatHeight(dep, after), z: p.z }, rotationY: wrapAngle(dep.rotationY + after.rotationY - before.rotationY) };
}

function samePos(a: Vec3, b: Vec3): boolean {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.z - b.z) < 1e-9;
}

/**
 * Copy of an item with a new placement / support (the same object when nothing changes). `surfaceY` is the
 * supportSurfaceY to keep; by default the item's own while it stays on the same support, none otherwise.
 */
function withPlacement(
  it: PlacedItem,
  position: Vec3,
  rotationY: number,
  supportId: string | undefined,
  surfaceY: number | undefined = supportId && supportId === it.supportId ? it.supportSurfaceY : undefined,
): PlacedItem {
  if (samePos(it.position, position) && Math.abs(it.rotationY - rotationY) < 1e-12 && it.supportId === supportId && it.supportSurfaceY === surfaceY) return it;
  const next: PlacedItem = { ...it, position, rotationY };
  if (supportId) next.supportId = supportId;
  else delete next.supportId;
  if (supportId && surfaceY !== undefined) next.supportSurfaceY = surfaceY;
  else delete next.supportSurfaceY;
  return next;
}

export interface SettleOptions {
  /**
   * Items whose position / rotation this change set explicitly: they are not carried, and stay stacked only while
   * their center is still over their support (otherwise they drop to whatever is below them).
   */
  moved?: Iterable<string>;
  /** Items whose supportId this change set explicitly: seated on that support wherever they are. */
  assigned?: Iterable<string>;
}

/**
 * Re-establish the stacking rules after a change from `prev` to `next` items:
 *  - an item whose support moved / turned (and that wasn't moved itself) is carried along (see carryWithSupport);
 *  - every stacked item sits exactly on its support's top (so resizing a support re-seats what's on it);
 *  - an item whose support is gone, hidden, not a floor item, or on a cycle with it — or which is no longer a floor
 *    item itself — loses supportId and drops to whatever is below it (another support, else the floor);
 *  - a moved item whose center left its support drops the same way.
 * Order and untouched items (same objects) are preserved.
 */
export function settleStacks(prev: PlacedItem[], next: PlacedItem[], room: Room, opts: SettleOptions = {}): PlacedItem[] {
  const prevById = new Map(prev.map((it) => [it.id, it]));
  const unhidden = next.some((it) => !it.hidden && prevById.get(it.id)?.hidden);
  const moved = new Set(opts.moved ?? []);
  const assigned = new Set(opts.assigned ?? []);
  // An item put somewhere on purpose no longer goes back onto the support it once fell off.
  const forget = next.some((it) => it.droppedFromId && (moved.has(it.id) || assigned.has(it.id)));
  if (!unhidden && !forget && !next.some((it) => it.supportId)) return next;
  const out = new Map(
    next.map((it) => {
      if (!it.droppedFromId || !(moved.has(it.id) || assigned.has(it.id))) return [it.id, it];
      const copy = { ...it };
      delete copy.droppedFromId;
      delete copy.droppedSurfaceY;
      return [it.id, copy];
    }),
  );

  // Break cycles first: an item that is itself ON a loop (walking down its supports leads back to it) loses its
  // support and drops below. Items that merely rest on a loop keep their support (it is fixed by then).
  for (const it of next) {
    const seen = new Set<string>([it.id]);
    let cur = out.get(it.id)!;
    while (cur.supportId) {
      if (cur.supportId === it.id) {
        const copy = { ...out.get(it.id)! };
        delete copy.supportId;
        delete copy.supportSurfaceY;
        out.set(it.id, copy);
        break;
      }
      if (seen.has(cur.supportId)) break; // a loop further down: broken when its own members are visited
      seen.add(cur.supportId);
      const up = out.get(cur.supportId);
      if (!up) break;
      cur = up;
    }
  }

  // An item that was hidden and is visible again takes back what fell off it when it was hidden (droppedFromId), as
  // long as that is still standing on the same surface under it (e.g. a lamp that fell from a hidden box onto the
  // desk goes back on the box), on the surface it was on (droppedSurfaceY: a bin that stood under a desk goes back
  // under it, a cat on a tower's middle level back to that level). Nothing else is picked up: a rug under a bed stays
  // on the floor.
  for (const u of next) {
    const before = prevById.get(u.id);
    if (!before?.hidden || u.hidden || u.mount !== "floor") continue;
    const cur = out.get(u.id)!;
    for (const d of [...out.values()]) {
      if (d.droppedFromId !== u.id || d.hidden || d.mount !== "floor" || d.supportId !== cur.supportId) continue;
      if (Math.abs(d.position.y - cur.position.y) > 1e-4 || !pointInFootprint(d.position, cur)) continue;
      const sf = surfaceAt(cur, d.droppedSurfaceY);
      if (!sf || !fitsSurfaceAt(d, cur, sf, toLocal(d.position, cur))) continue;
      if (stackDescendants([...out.values()], d.id).has(u.id)) continue;
      const back: PlacedItem = { ...d, supportId: u.id };
      delete back.droppedFromId;
      delete back.droppedSurfaceY;
      const stored = storedSurfaceY(cur, sf);
      if (stored === undefined) delete back.supportSurfaceY;
      else back.supportSurfaceY = stored;
      out.set(d.id, back);
    }
  }

  const depthOf = (id: string): number => {
    let d = 0;
    let cur = out.get(id);
    while (cur?.supportId && d <= out.size) {
      cur = out.get(cur.supportId);
      d++;
    }
    return d;
  };
  const order = next.map((it) => it.id).sort((a, b) => depthOf(a) - depthOf(b));

  const drop = (it: PlacedItem): PlacedItem => {
    if (it.mount !== "floor") return withPlacement(it, it.position, it.rotationY, undefined);
    const probe = { ...it };
    delete probe.supportId;
    const others = [...out.values()].filter((o) => o.id !== it.id);
    const below = findSurfaceAt(probe, it.position, [probe, ...others], it.position.y);
    if (below) {
      const { support: b, surface } = below;
      return withPlacement(it, { ...it.position, y: b.position.y + surface.y }, it.rotationY, b.id, storedSurfaceY(b, surface));
    }
    return withPlacement(it, { ...it.position, y: 0 }, it.rotationY, undefined);
  };

  for (const id of order) {
    const it = out.get(id)!;
    if (!it.supportId) {
      // Cycle-broken items still float at their old height.
      if (it.mount === "floor" && it.position.y !== 0 && next.find((n) => n.id === id)?.supportId) out.set(id, drop(it));
      continue;
    }
    const s = out.get(it.supportId);
    if (!s || s.hidden || s.mount !== "floor" || it.mount !== "floor") {
      const dropped = drop(it);
      // Remember the hidden support and the surface it was on, so showing it again puts this item back there.
      if (s?.hidden && it.mount === "floor") {
        const fell: PlacedItem = { ...dropped, droppedFromId: s.id };
        if (it.supportSurfaceY !== undefined) fell.droppedSurfaceY = it.supportSurfaceY;
        else delete fell.droppedSurfaceY;
        out.set(id, fell);
      } else out.set(id, dropped);
      continue;
    }
    if (assigned.has(id) || (moved.has(id) && pointInFootprint(it.position, s))) {
      out.set(id, withPlacement(it, { ...it.position, y: seatHeight(it, s) }, it.rotationY, s.id));
      continue;
    }
    if (moved.has(id)) {
      out.set(id, drop(it));
      continue;
    }
    const ps = prevById.get(s.id);
    // A resized support keeps what is on a lower surface (a cat tower's platform) on that surface: it scales with it.
    const surfaceY =
      it.supportSurfaceY !== undefined && ps && ps.dims.h > 0 && Math.abs(ps.dims.h - s.dims.h) > 1e-9
        ? Math.round(((it.supportSurfaceY * s.dims.h) / ps.dims.h) * 10000) / 10000
        : it.supportSurfaceY;
    const seat = s.position.y + surfaceHeight({ supportSurfaceY: surfaceY }, s);
    const self = prevById.get(id);
    const supportMoved =
      ps && (Math.abs(ps.position.x - s.position.x) > 1e-9 || Math.abs(ps.position.z - s.position.z) > 1e-9 || Math.abs(ps.rotationY - s.rotationY) > 1e-12);
    let placed: PlacedItem;
    if (ps && self && supportMoved) {
      const carried = carryWithSupport(self, ps, s);
      const xz = constrainToRoom({ ...it, position: carried.position, rotationY: carried.rotationY }, room);
      placed = withPlacement(it, { x: xz.x, y: seat, z: xz.z }, carried.rotationY, s.id, surfaceY);
    } else {
      placed = withPlacement(it, { ...it.position, y: seat }, it.rotationY, s.id, surfaceY);
    }
    // On a lower surface (under a desk, a cat tower's platform) of a support whose shape changed (resized, swapped for
    // a product), or after a change of the item itself / of what it rests on: check that surface is still there and
    // the item still fits on it (a desk lowered onto the bin under it, a product desk that is one solid box).
    const reshaped =
      !ps || !self || self.supportId !== s.id || !sameDims(ps.dims, s.dims) || ps.parts !== s.parts || !sameDims(self.dims, it.dims);
    if (reshaped && surfaceY !== undefined) {
      const sf = surfaceAt(s, surfaceY);
      if (!sf || !fitsSurfaceAt(placed, s, sf, toLocal(placed.position, s))) placed = reseat(placed, s, surfaceY);
    }
    out.set(id, placed);
  }
  return next.map((it) => out.get(it.id)!);

  /**
   * An item that no longer fits where it is on its surface: to the nearest free spot of the same kind of surface (still
   * under a narrowed desk, between its legs; a raised one nearest in height, e.g. a solid product tower's top for a cat
   * from a placeholder tower's middle level), else to the floor just in front of the stack the support stands in (as
   * taking it off does), never left inside the support.
   */
  function reseat(it: PlacedItem, s: PlacedItem, surfaceY: number): PlacedItem {
    const l = toLocal(it.position, s);
    const wasUnder = surfaceY < SAME_SURFACE;
    const same = supportSurfaces(s)
      .filter((sf) => (wasUnder ? sf.kind === "under" : sf.kind !== "under"))
      .sort((x, y) => Math.abs(x.y - surfaceY) - Math.abs(y.y - surfaceY));
    for (const sf of same) {
      const spot = surfaceSpot(it, s, sf, it.rotationY, l);
      if (!spot) continue;
      const w = fromLocal(spot, s);
      const next = { ...withPlacement(it, { x: w.x, y: s.position.y + sf.y, z: w.z }, it.rotationY, s.id) };
      // (withPlacement keeps the old surface when given none: the top is stored as no supportSurfaceY.)
      const stored = storedSurfaceY(s, sf);
      if (stored === undefined) delete next.supportSurfaceY;
      else next.supportSurfaceY = stored;
      return next;
    }
    let base = s;
    for (const seen = new Set([it.id, s.id]); base.supportId && !seen.has(base.supportId); ) {
      const below = out.get(base.supportId);
      if (!below) break;
      seen.add(below.id);
      base = below;
    }
    const dist = base.dims.d / 2 + it.dims.d / 2 + 0.05;
    const front = { x: base.position.x + Math.sin(base.rotationY) * dist, y: 0, z: base.position.z + Math.cos(base.rotationY) * dist };
    const xz = constrainToRoom({ ...it, position: front, supportId: undefined }, room);
    return withPlacement(it, { x: xz.x, y: 0, z: xz.z }, it.rotationY, undefined);
  }
}

function sameDims(a: Dims, b: Dims): boolean {
  return Math.abs(a.w - b.w) < 1e-9 && Math.abs(a.h - b.h) < 1e-9 && Math.abs(a.d - b.d) < 1e-9;
}

/** Items in display order, each stacked item right after its support, with its stack depth (0 = not stacked). */
export function stackOrder<T extends Pick<PlacedItem, "id" | "supportId">>(items: T[]): { item: T; depth: number }[] {
  const ids = new Set(items.map((it) => it.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const it of items) {
    if (it.supportId && it.supportId !== it.id && ids.has(it.supportId)) {
      const list = children.get(it.supportId) ?? [];
      list.push(it);
      children.set(it.supportId, list);
    } else roots.push(it);
  }
  const out: { item: T; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (it: T, depth: number) => {
    if (seen.has(it.id)) return;
    seen.add(it.id);
    out.push({ item: it, depth });
    for (const c of children.get(it.id) ?? []) visit(c, depth + 1);
  };
  roots.forEach((r) => visit(r, 0));
  for (const it of items) visit(it, 0); // anything on a cycle (shouldn't happen) is listed flat
  return out;
}
