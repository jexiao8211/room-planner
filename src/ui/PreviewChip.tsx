// "Previewing <product>" chip over the 3D view: cycle through the search results in the same spot
// (Prev / Next, or the [ and ] keys) and commit the one you like.
import { useEffect } from "react";
import { usePlanner } from "../state/store";
import { useUI } from "./uiStore";

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
}

export function PreviewChip() {
  const preview = usePlanner((s) => s.preview);
  const target = usePlanner((s) => s.items.find((it) => it.id === s.previewTargetId));
  const results = useUI((s) => s.results);
  const index = preview ? results.findIndex((r) => r.id === preview.id) : -1;
  const canCycle = index >= 0 && results.length > 1;

  const step = (delta: number) => {
    if (!canCycle) return;
    usePlanner.getState().setPreview(results[(index + delta + results.length) % results.length]);
  };

  const commit = () => {
    if (!preview) return;
    const s = usePlanner.getState();
    if (target) s.replaceItemWithProduct(target.id, preview);
    else {
      const id = s.addProduct(preview);
      s.select(id);
    }
    s.setPreview(null);
  };

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        step(e.key === "]" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!preview) return null;
  return (
    <div className="vp-chip vp-preview" data-testid="preview-chip">
      <span className="vp-preview-name" title={preview.name}>
        Previewing <strong>{preview.name}</strong>
        {target ? <> in place of {target.name}</> : null}
      </span>
      <span className="vp-preview-actions">
        {canCycle ? (
          <>
            <button className="vp-chip-btn" data-testid="preview-prev-btn" title="Previous result ([)" aria-label="Previous result" onClick={() => step(-1)}>
              ‹
            </button>
            <span className="small" data-testid="preview-position">
              {index + 1}/{results.length}
            </span>
            <button className="vp-chip-btn" data-testid="preview-next-btn" title="Next result (])" aria-label="Next result" onClick={() => step(1)}>
              ›
            </button>
          </>
        ) : null}
        <button className="vp-chip-btn primary" data-testid="preview-commit-btn" onClick={commit}>
          {target ? "Use here" : "Add here"}
        </button>
        <button className="vp-chip-btn" data-testid="clear-preview-btn" onClick={() => usePlanner.getState().setPreview(null)}>
          Clear
        </button>
      </span>
    </div>
  );
}
