import { useEffect, useLayoutEffect, useRef } from "react";
import { Scene, setViewportInsetRight, setViewportInsetTop } from "./scene";
import { usePlanner } from "./state/store";
import { Toolbar } from "./ui/Toolbar";
import { Sidebar } from "./ui/Sidebar";
import { Inspector } from "./ui/Inspector";
import { ModeBanner } from "./ui/ModeBanner";
import { UpdateBar } from "./ui/UpdateBar";
import { PreviewChip } from "./ui/PreviewChip";
import { SceneErrorBoundary } from "./ui/SceneErrorBoundary";
import { formatLength } from "./lib/units";

export default function App() {
  const hasSelection = usePlanner((s) => s.selectedId != null && s.items.some((it) => it.id === s.selectedId));
  const workspaceRef = useRef<HTMLDivElement>(null);

  // The inspector floats over the right edge of the 3D view instead of narrowing it, so selecting an item never
  // moves the scene under the pointer. The scene still needs to know how much of the view it covers (camera
  // presets frame the room in the visible part; labels keep out from under it).
  useLayoutEffect(() => {
    const update = () => {
      const el = workspaceRef.current?.querySelector<HTMLElement>(".inspector");
      setViewportInsetRight(el ? el.getBoundingClientRect().width : 0);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [hasSelection]);

  return (
    <div className="app">
      <Toolbar />
      <ModeBanner />
      <UpdateBar />
      <div ref={workspaceRef} className={`workspace${hasSelection ? " with-inspector" : ""}`}>
        <Sidebar />
        <main className="viewport" aria-label="3D room view">
          <SceneErrorBoundary>
            <Scene />
          </SceneErrorBoundary>
          <ViewportOverlay />
        </main>
        {hasSelection ? <Inspector /> : null}
      </div>
    </div>
  );
}

/** Room size, the preview chip and quick hints floating over the 3D view. */
function ViewportOverlay() {
  const room = usePlanner((s) => s.room);
  const units = usePlanner((s) => s.units);
  const topRef = useRef<HTMLDivElement>(null);

  // Tell the scene how far down the chips reach, so 3D labels slide below them instead of under them.
  useEffect(() => {
    const el = topRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => setViewportInsetTop(el.offsetTop + el.offsetHeight + 6);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, []);

  return (
    <>
      {/* One wrapping row: the chips stack instead of overlapping when the view is narrow. */}
      <div className="vp-top" ref={topRef}>
        <div className="vp-chip vp-room-chip" data-testid="room-size-chip">
          <span className="vp-chip-title">{room.name}</span>
          <span>
            {formatLength(room.width, units)} × {formatLength(room.depth, units)} · {formatLength(room.height, units)} ceiling
          </span>
        </div>
        <PreviewChip />
      </div>
      <div className="vp-hint" aria-hidden="true">
        Drag to orbit · Scroll to zoom · Click an item to select · R rotates · Click a window for its blinds
      </div>
    </>
  );
}
