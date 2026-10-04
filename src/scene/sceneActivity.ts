// What the 3D view is doing right now, for code outside the scene that must not interrupt it (auto-update).
import { dragState, pointerState } from "./debugState";

/** An item drag or an orbit / pan (a press that started in the 3D view) is in progress. */
export function isSceneInteracting(): boolean {
  return dragState.active || pointerState.down;
}
