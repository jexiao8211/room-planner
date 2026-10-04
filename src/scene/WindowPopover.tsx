// Small popover that opens when a window is clicked in the 3D view: open / close its blinds.
import { useContext, useEffect, type RefObject } from "react";
import { Html } from "@react-three/drei";
import { create } from "zustand";
import type { Opening, WallSide } from "../shared/types";
import { usePlanner } from "../state/store";
import { windowCovering } from "../lib/lighting";
import { setWindowCovering } from "../state/lightingActions";
import { LabelPortalContext } from "./shared3d";
import { wallFrame } from "./wallPieces";

interface PopoverState {
  openingId: string | null;
  open: (id: string) => void;
  close: () => void;
}

export const useWindowPopover = create<PopoverState>()((set) => ({
  openingId: null,
  open: (id) => set({ openingId: id }),
  close: () => set({ openingId: null }),
}));

const WALL_NAME: Record<WallSide, string> = { north: "back (north)", south: "front (south)", east: "right (east)", west: "left (west)" };

/** Room-space point just inside the room in front of a window's center. */
function windowAnchor(o: Opening, room: { width: number; depth: number }): [number, number, number] {
  const f = wallFrame(o.wall, room);
  return [f.origin.x + f.axis.x * o.offset - f.normal.x * 0.15, o.sill + o.height / 2, f.origin.z + f.axis.z * o.offset - f.normal.z * 0.15];
}

export function WindowPopover() {
  const id = useWindowPopover((s) => s.openingId);
  const close = useWindowPopover((s) => s.close);
  const room = usePlanner((s) => s.room);
  const portal = useContext(LabelPortalContext);
  const opening = id ? room.openings.find((o) => o.id === id && o.kind === "window") : undefined;

  useEffect(() => {
    if (!opening) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opening, close]);
  // A different selection (or a deleted window) closes it.
  useEffect(() => usePlanner.subscribe((s, prev) => {
    if (s.selectedId !== prev.selectedId && s.selectedId) close();
  }), [close]);
  useEffect(() => {
    if (id && !opening) close();
  }, [id, opening, close]);

  if (!opening) return null;
  const covering = windowCovering(opening);
  const index = room.openings.filter((o) => o.kind === "window").findIndex((o) => o.id === opening.id) + 1;
  return (
    <Html position={windowAnchor(opening, room)} center portal={(portal ?? undefined) as RefObject<HTMLElement> | undefined} zIndexRange={[40, 30]}>
      <div className="window-popover" data-testid="window-popover" role="dialog" aria-label="Window blinds" onPointerDown={(e) => e.stopPropagation()}>
        <div className="window-popover-head">
          <span>
            <strong>Window {index}</strong> · {WALL_NAME[opening.wall]} wall
          </span>
          <button className="btn btn-icon btn-sm btn-quiet" aria-label="Close" data-testid="window-popover-close" onClick={close}>
            ×
          </button>
        </div>
        <div className="segmented" role="group" aria-label="Blinds">
          <button
            className={`seg-btn${covering === "open" ? " active" : ""}`}
            aria-pressed={covering === "open"}
            data-testid="window-open-btn"
            onClick={() => setWindowCovering(opening.id, "open")}
          >
            Open
          </button>
          <button
            className={`seg-btn${covering === "closed" ? " active" : ""}`}
            aria-pressed={covering === "closed"}
            data-testid="window-close-btn"
            onClick={() => setWindowCovering(opening.id, "closed")}
          >
            Blinds closed
          </button>
        </div>
      </div>
    </Html>
  );
}
