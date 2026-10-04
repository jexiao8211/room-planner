// Small mutable state shared between scene components and the window.__plannerDebug hook (E2E tests).
import type { WallSide } from "../shared/types";
import type { CameraPreset } from "./cameraBus";

/** Current (animated) opacity of each wall; 1 = solid, low = cut away. */
export const wallOpacities: Record<WallSide, number> = { north: 1, east: 1, south: 1, west: 1 };

export const cameraState: { preset: CameraPreset | "custom"; animating: boolean } = { preset: "iso", animating: false };

/**
 * active: an item press is in progress (used to suppress hover effects).
 * moved: the latest press on the 3D view turned into an item drag (reset on every canvas pointer-down).
 * id: (additive) the item being dragged once the press turned into a drag, else null (its label says where it lands).
 */
export const dragState: { active: boolean; moved: boolean; id: string | null } = { active: false, moved: false, id: null };

/** Pointer state of the 3D view: whether a press that started on it is still down, and when it was released. */
export const pointerState = { down: false, lastCanvasPointerUp: -Infinity };
