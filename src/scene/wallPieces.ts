// Pure helpers for building walls out of rectangles around door/window openings (no CSG).
// Wall-local coordinates: u runs along the wall from its MIN end (0) to its length,
// v runs up from the floor (0) to the ceiling (room height).
import type { Opening, Room, WallSide } from "../shared/types";

export interface Rect {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

export const WALL_SIDES: WallSide[] = ["north", "east", "south", "west"];

const EPS = 1e-6;

export function wallLength(side: WallSide, room: Pick<Room, "width" | "depth">): number {
  return side === "north" || side === "south" ? room.width : room.depth;
}

/**
 * Placement of a wall's interior face in room coordinates (x/z on the floor).
 * origin = the point where u = 0; axis = direction of increasing u; normal = outward (away from the room).
 */
export interface WallFrame {
  origin: { x: number; z: number };
  axis: { x: number; z: number };
  normal: { x: number; z: number };
  length: number;
}

export function wallFrame(side: WallSide, room: Pick<Room, "width" | "depth">): WallFrame {
  const hw = room.width / 2;
  const hd = room.depth / 2;
  switch (side) {
    case "north":
      return { origin: { x: -hw, z: -hd }, axis: { x: 1, z: 0 }, normal: { x: 0, z: -1 }, length: room.width };
    case "south":
      return { origin: { x: -hw, z: hd }, axis: { x: 1, z: 0 }, normal: { x: 0, z: 1 }, length: room.width };
    case "west":
      return { origin: { x: -hw, z: -hd }, axis: { x: 0, z: 1 }, normal: { x: -1, z: 0 }, length: room.depth };
    case "east":
      return { origin: { x: hw, z: -hd }, axis: { x: 0, z: 1 }, normal: { x: 1, z: 0 }, length: room.depth };
  }
}

/** An opening's rectangle clamped to the wall [0,length]×[0,height]; null if nothing of it remains. */
export function clampOpening(
  o: Pick<Opening, "offset" | "width" | "height" | "sill">,
  length: number,
  height: number,
): Rect | null {
  const u0 = Math.max(0, o.offset - o.width / 2);
  const u1 = Math.min(length, o.offset + o.width / 2);
  const v0 = Math.max(0, o.sill);
  const v1 = Math.min(height, o.sill + o.height);
  if (!(u1 - u0 > EPS) || !(v1 - v0 > EPS)) return null;
  return { u0, u1, v0, v1 };
}

/** Clamped opening rectangles on one wall, paired with their source opening. */
export function openingsOnWall(room: Room, side: WallSide): { opening: Opening; rect: Rect }[] {
  const length = wallLength(side, room);
  const out: { opening: Opening; rect: Rect }[] = [];
  for (const opening of room.openings) {
    if (opening.wall !== side) continue;
    const rect = clampOpening(opening, length, room.height);
    if (rect) out.push({ opening, rect });
  }
  return out;
}

/** Merge overlapping/touching [a,b] intervals (input need not be sorted). */
function mergeIntervals(intervals: [number, number][]): [number, number][] {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + EPS) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function sameIntervals(a: [number, number][], b: [number, number][]): boolean {
  return a.length === b.length && a.every((x, i) => Math.abs(x[0] - b[i][0]) < EPS && Math.abs(x[1] - b[i][1]) < EPS);
}

/**
 * Solid rectangles that make up a wall of the given size with the holes removed.
 * Works with any number of (possibly overlapping) holes: the wall is cut into vertical strips at every
 * hole edge, each strip keeps the complement of the holes covering it, and neighbouring strips with the
 * same solid spans are merged back together.
 */
export function wallPieces(length: number, height: number, holes: Rect[]): Rect[] {
  if (!(length > EPS) || !(height > EPS)) return [];
  const cuts = new Set<number>([0, length]);
  for (const h of holes) {
    if (h.u0 > 0 && h.u0 < length) cuts.add(h.u0);
    if (h.u1 > 0 && h.u1 < length) cuts.add(h.u1);
  }
  const xs = [...cuts].sort((a, b) => a - b);

  const strips: { u0: number; u1: number; solids: [number, number][] }[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i];
    const b = xs[i + 1];
    if (b - a <= EPS) continue;
    const mid = (a + b) / 2;
    const covered = mergeIntervals(
      holes
        .filter((h) => h.u0 < mid && h.u1 > mid)
        .map((h): [number, number] => [Math.max(0, h.v0), Math.min(height, h.v1)])
        .filter(([v0, v1]) => v1 - v0 > EPS),
    );
    const solids: [number, number][] = [];
    let v = 0;
    for (const [c0, c1] of covered) {
      if (c0 - v > EPS) solids.push([v, c0]);
      v = Math.max(v, c1);
    }
    if (height - v > EPS) solids.push([v, height]);

    const prev = strips[strips.length - 1];
    if (prev && Math.abs(prev.u1 - a) < EPS && sameIntervals(prev.solids, solids)) prev.u1 = b;
    else strips.push({ u0: a, u1: b, solids });
  }

  const rects: Rect[] = [];
  for (const s of strips) for (const [v0, v1] of s.solids) rects.push({ u0: s.u0, u1: s.u1, v0, v1 });
  return rects;
}

/**
 * Grow each piece by `eps` on every side that meets another piece (not on sides that border a hole), so
 * neighbouring rectangles overlap slightly. Exactly abutting boxes leave hairline seams (T-junction cracks)
 * when rasterized; an overlap of the same material is invisible. Hole edges stay exact.
 */
export function overlapPieces(pieces: Rect[], holes: Rect[], eps = 0.002): Rect[] {
  const touches = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 - EPS && b0 < a1 - EPS;
  const bordersHole = (side: "u0" | "u1" | "v0" | "v1", r: Rect) =>
    holes.some((h) => {
      if (side === "u0") return Math.abs(h.u1 - r.u0) < EPS && touches(h.v0, h.v1, r.v0, r.v1);
      if (side === "u1") return Math.abs(h.u0 - r.u1) < EPS && touches(h.v0, h.v1, r.v0, r.v1);
      if (side === "v0") return Math.abs(h.v1 - r.v0) < EPS && touches(h.u0, h.u1, r.u0, r.u1);
      return Math.abs(h.v0 - r.v1) < EPS && touches(h.u0, h.u1, r.u0, r.u1);
    });
  const meetsPiece = (side: "u0" | "u1" | "v0" | "v1", r: Rect) =>
    pieces.some((o) => {
      if (o === r) return false;
      if (side === "u0") return Math.abs(o.u1 - r.u0) < EPS && touches(o.v0, o.v1, r.v0, r.v1);
      if (side === "u1") return Math.abs(o.u0 - r.u1) < EPS && touches(o.v0, o.v1, r.v0, r.v1);
      if (side === "v0") return Math.abs(o.v1 - r.v0) < EPS && touches(o.u0, o.u1, r.u0, r.u1);
      return Math.abs(o.v0 - r.v1) < EPS && touches(o.u0, o.u1, r.u0, r.u1);
    });
  const grow = (side: "u0" | "u1" | "v0" | "v1", r: Rect) => meetsPiece(side, r) && !bordersHole(side, r);
  return pieces.map((r) => ({
    u0: grow("u0", r) ? r.u0 - eps : r.u0,
    u1: grow("u1", r) ? r.u1 + eps : r.u1,
    v0: grow("v0", r) ? r.v0 - eps : r.v0,
    v1: grow("v1", r) ? r.v1 + eps : r.v1,
  }));
}

/** Total solid area — handy for tests and sanity checks. */
export function piecesArea(rects: Rect[]): number {
  return rects.reduce((sum, r) => sum + (r.u1 - r.u0) * (r.v1 - r.v0), 0);
}
