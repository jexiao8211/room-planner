// Pure geometry of the window sun beams (no three.js): where each window's sun spot light sits and the light shaft.
import type { Opening, Room } from "../shared/types";
import { wallFrame } from "./wallPieces";

/** Distance of a window's sun spot light outside the window (m). */
export const SUN_DISTANCE = 6;
/** Sideways skew of the sun beam (degrees) so the patch on the floor isn't a straight-on rectangle. */
export const SUN_AZIMUTH = 22;

export interface SunInfo {
  opening: Opening;
  position: [number, number, number];
  target: [number, number, number];
  angle: number;
  /** Unit direction the sunlight travels (into the room and down). */
  dir: { x: number; y: number; z: number };
}

/** Spot light outside an open window, aimed in and down through it (the wall's shadow shapes the beam). */
export function sunBeamFor(o: Opening, room: Pick<Room, "width" | "depth">, elevationDeg: number): SunInfo {
  const f = wallFrame(o.wall, room);
  const cx = f.origin.x + f.axis.x * o.offset;
  const cz = f.origin.z + f.axis.z * o.offset;
  const cy = o.sill + o.height / 2;
  const e = (elevationDeg * Math.PI) / 180;
  const az = (SUN_AZIMUTH * Math.PI) / 180;
  // Direction the light travels: into the room (-normal), turned a bit along the wall, and down.
  const inX = -f.normal.x * Math.cos(az) + f.axis.x * Math.sin(az);
  const inZ = -f.normal.z * Math.cos(az) + f.axis.z * Math.sin(az);
  const dir = { x: inX * Math.cos(e), y: -Math.sin(e), z: inZ * Math.cos(e) };
  const position: [number, number, number] = [cx - dir.x * SUN_DISTANCE, cy - dir.y * SUN_DISTANCE, cz - dir.z * SUN_DISTANCE];
  const target: [number, number, number] = [cx + dir.x, cy + dir.y, cz + dir.z];
  const r = Math.hypot(o.width, o.height) / 2;
  const angle = Math.min(Math.PI / 3, Math.atan((r * 1.25) / SUN_DISTANCE));
  return { opening: o, position, target, angle, dir };
}

/**
 * The visible light shaft of a window's sun beam: the window's four inner corners (bottom-left, bottom-right,
 * top-right, top-left along the wall) and where each corner's ray lands on the floor or the far walls.
 */
export function sunShaft(o: Opening, room: Pick<Room, "width" | "depth" | "height">, dir: { x: number; y: number; z: number }): {
  start: [number, number, number][];
  end: [number, number, number][];
} {
  const f = wallFrame(o.wall, room);
  const len = f.length;
  const u0 = Math.max(0, o.offset - o.width / 2);
  const u1 = Math.min(len, o.offset + o.width / 2);
  const v0 = Math.max(0, o.sill);
  const v1 = Math.min(room.height, o.sill + o.height);
  const corner = (u: number, v: number): [number, number, number] => [f.origin.x + f.axis.x * u, v, f.origin.z + f.axis.z * u];
  const start = [corner(u0, v0), corner(u1, v0), corner(u1, v1), corner(u0, v1)];
  const hw = room.width / 2;
  const hd = room.depth / 2;
  const end = start.map(([x, y, z]): [number, number, number] => {
    let t = dir.y < -1e-6 ? y / -dir.y : Infinity;
    if (dir.x > 1e-6) t = Math.min(t, (hw - x) / dir.x);
    if (dir.x < -1e-6) t = Math.min(t, (-hw - x) / dir.x);
    if (dir.z > 1e-6) t = Math.min(t, (hd - z) / dir.z);
    if (dir.z < -1e-6) t = Math.min(t, (-hd - z) / dir.z);
    if (!Number.isFinite(t) || t < 0) t = 0;
    return [x + dir.x * t, Math.max(0, y + dir.y * t), z + dir.z * t];
  });
  return { start, end };
}

