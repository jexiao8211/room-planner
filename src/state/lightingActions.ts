// Store actions for lighting: the room's mode and a window's blinds. Both are undoable plan changes.
import type { LightingMode } from "../shared/types";
import { lightingMode, windowCovering } from "../lib/lighting";
import { usePlanner } from "./store";

/** Switch the lighting mode (saved with the plan; one undo step). No-op when it already is that mode. */
export function setLightingMode(mode: LightingMode): void {
  const s = usePlanner.getState();
  if (lightingMode(s.room.lighting) === mode) return;
  s.updateRoom({ lighting: mode });
}

/** Open or close a window's blinds (one undo step). No-op for doors, unknown ids or no change. */
export function setWindowCovering(openingId: string, covering: "open" | "closed"): void {
  const { room, updateRoom } = usePlanner.getState();
  const o = room.openings.find((x) => x.id === openingId);
  if (!o || o.kind !== "window" || windowCovering(o) === covering) return;
  updateRoom({ openings: room.openings.map((x) => (x.id === openingId ? { ...x, covering } : x)) });
}
