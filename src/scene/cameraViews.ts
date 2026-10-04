// Pure camera framing for the preset views.
import type { Room, Vec3 } from "../shared/types";
import { wallFrame } from "./wallPieces";

export interface CameraView {
  position: Vec3;
  target: Vec3;
}

const WALL_T = 0.1;
const EYE_HEIGHT = 1.6;
/** Walls are cut to this height in top view (see RoomMesh). */
const TOP_CUT_HEIGHT = 0.3;
/** Extra floor margin (m) framed around the walls in top view. */
const TOP_LABEL_MARGIN = 0.4;

/**
 * Vertical field of view used by each preset. Eye level uses a wider lens; top view uses a long lens from
 * further away so tall furniture near the walls doesn't splay outward past them (closer to a true plan).
 */
export const PRESET_FOV: Record<"iso" | "top" | "eye", number> = { iso: 45, top: 3, eye: 62 };

function horizontalFov(vfovRad: number, aspect: number): number {
  return 2 * Math.atan(Math.tan(vfovRad / 2) * aspect);
}

/**
 * Camera position + orbit target for a preset.
 *   iso — above the south-east corner looking diagonally into the room
 *   top — straight down, whole floor plan in view (north at the top of the screen)
 *   eye — standing at 1.6 m just inside the first door (or the south wall's middle), looking into the room
 */
export function presetView(preset: "iso" | "top" | "eye", room: Room, aspect: number, fovDeg: number): CameraView {
  const vfov = (fovDeg * Math.PI) / 180;
  const hfov = horizontalFov(vfov, Math.max(aspect, 0.1));
  const fitFov = Math.min(vfov, hfov);

  if (preset === "top") {
    // Leave room around the walls for the floor dimension labels (and the hint bar under the view).
    const margin = WALL_T + TOP_LABEL_MARGIN;
    const fitD = (room.depth / 2 + margin) / Math.tan(vfov / 2);
    const fitW = (room.width / 2 + margin) / Math.tan(hfov / 2);
    const dist = Math.max(fitD, fitW) * 1.05 + Math.min(room.height, TOP_CUT_HEIGHT);
    // Tiny z offset keeps OrbitControls away from the pole singularity and north up on screen.
    return { position: { x: 0, y: dist, z: 0.001 }, target: { x: 0, y: 0, z: 0 } };
  }

  if (preset === "eye") {
    const eyeY = Math.min(EYE_HEIGHT, Math.max(0.5, room.height - 0.15));
    const target = { x: 0, y: Math.min(1.2, room.height * 0.5), z: 0 };
    const door = room.openings.find((o) => o.kind === "door");
    if (door) {
      const f = wallFrame(door.wall, room);
      const offset = Math.min(Math.max(door.offset, 0), f.length);
      const inset = Math.min(0.5, Math.min(room.width, room.depth) / 4);
      const x = f.origin.x + f.axis.x * offset - f.normal.x * inset;
      const z = f.origin.z + f.axis.z * offset - f.normal.z * inset;
      return { position: { x, y: eyeY, z }, target };
    }
    const inset = Math.min(0.5, room.depth / 4);
    return { position: { x: 0, y: eyeY, z: room.depth / 2 - inset }, target: { ...target, z: -room.depth / 4 } };
  }

  // iso
  const target = { x: 0, y: room.height / 3, z: 0 };
  const radius = 0.5 * Math.hypot(room.width + 2 * WALL_T, room.depth + 2 * WALL_T, room.height);
  const dist = (radius / Math.sin(fitFov / 2)) * 0.88;
  const az = (38 * Math.PI) / 180; // from +z (south) toward +x (east)
  const el = (36 * Math.PI) / 180;
  return {
    position: {
      x: target.x + dist * Math.cos(el) * Math.sin(az),
      y: target.y + dist * Math.sin(el),
      z: target.z + dist * Math.cos(el) * Math.cos(az),
    },
    target,
  };
}

/** True when the room changed enough (>15% on any axis) that the camera should re-frame it. */
export function roomSizeChangedSignificantly(a: Pick<Room, "width" | "depth" | "height">, b: Pick<Room, "width" | "depth" | "height">): boolean {
  const rel = (x: number, y: number) => Math.abs(x - y) / Math.max(Math.abs(y), 1e-6);
  return rel(a.width, b.width) > 0.15 || rel(a.depth, b.depth) > 0.15 || rel(a.height, b.height) > 0.15;
}

/**
 * Near/far clip planes for a camera `distance` meters from what it looks at. The near plane grows with the
 * distance (depth precision depends on near/far, and the top view's long lens sits ~80 m away); the far plane
 * always reaches past the whole room.
 */
export function clipPlanes(distance: number, roomMaxDim: number): { near: number; far: number } {
  const d = Math.max(0, distance);
  return { near: Math.min(Math.max(d * 0.02, 0.02), Math.max(0.02, d - roomMaxDim * 2)), far: d + roomMaxDim * 3 + 20 };
}
