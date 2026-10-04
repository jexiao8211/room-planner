// Toolbar segmented control: Day / Evening / Night lighting.
import type { LightingMode } from "../shared/types";
import { usePlanner } from "../state/store";
import { setLightingMode } from "../state/lightingActions";
import { LIGHTING_MODES, lightingMode } from "../lib/lighting";

const ICON: Record<LightingMode, string> = { day: "☀", evening: "◐", night: "☾" };

export function LightingControl() {
  const mode = usePlanner((s) => lightingMode(s.room.lighting));
  return (
    <div className="tb-group" role="group" aria-label="Lighting">
      <span className="tb-label">Light</span>
      <div className="segmented" data-testid="lighting-control">
        {LIGHTING_MODES.map((m) => (
          <button
            key={m.key}
            className={`seg-btn${mode === m.key ? " active" : ""}`}
            data-testid={`lighting-${m.key}`}
            aria-pressed={mode === m.key}
            title={m.title}
            onClick={() => setLightingMode(m.key)}
          >
            <span aria-hidden="true" className="seg-icon">
              {ICON[m.key]}
            </span>{" "}
            <span className="seg-text">{m.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
