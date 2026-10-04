// Inspector section for light-emitting items: on/off, brightness, warm <-> cool. Items without a light get a
// "Make it a light" button (a product lamp whose name doesn't say "lamp", say).
import { useRef } from "react";
import type { LightSettings, PlacedItem } from "../shared/types";
import { usePlanner } from "../state/store";
import { DEFAULT_LIGHT, colorWarmth, isLampLike, warmthColor } from "../lib/lighting";

export function LightControls({ item }: { item: PlacedItem }) {
  const sliding = useRef(false);
  const light = item.light;
  const set = (patch: Partial<LightSettings>, transient = false) => {
    const base = usePlanner.getState().items.find((it) => it.id === item.id)?.light ?? DEFAULT_LIGHT;
    usePlanner.getState().updateItem(item.id, { light: { ...base, ...patch } }, { transient });
  };
  const startSlide = () => {
    sliding.current = true;
    usePlanner.getState().checkpoint();
  };
  const endSlide = () => {
    sliding.current = false;
  };

  if (!light) {
    return (
      <section className="section light-section" data-testid="inspector-light">
        <button className="btn btn-ghost btn-sm light-add" data-testid="light-add-btn" onClick={() => set({ ...DEFAULT_LIGHT })} title="Give this item a light source">
          + Make it a light source
        </button>
      </section>
    );
  }

  const warmth = colorWarmth(light.color);
  return (
    <section className="section light-section" data-testid="inspector-light">
      <div className="light-head">
        <h3 className="section-sub">Light</h3>
        <button
          className={`light-switch${light.on ? " on" : ""}`}
          role="switch"
          aria-checked={light.on}
          aria-label="Light on"
          data-testid="light-toggle"
          onClick={() => set({ on: !light.on })}
        >
          <span className="light-switch-knob" />
          <span className="light-switch-text">{light.on ? "On" : "Off"}</span>
        </button>
      </div>
      <label className="field light-field">
        <span className="field-label">Brightness</span>
        <input
          type="range"
          className="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(light.intensity * 100)}
          data-testid="light-brightness"
          aria-label="Brightness"
          onPointerDown={startSlide}
          onPointerUp={endSlide}
          onChange={(e) => set({ intensity: Number(e.target.value) / 100, on: true }, sliding.current)}
        />
      </label>
      <label className="field light-field">
        <span className="field-label light-warmth-label">
          <span>Cool</span>
          <span className="light-swatch" style={{ background: light.color }} aria-hidden="true" />
          <span>Warm</span>
        </span>
        <input
          type="range"
          className="range light-warmth"
          min={0}
          max={100}
          step={1}
          value={Math.round(warmth * 100)}
          data-testid="light-warmth"
          aria-label="Light color, cool to warm"
          onPointerDown={startSlide}
          onPointerUp={endSlide}
          onChange={(e) => set({ color: warmthColor(Number(e.target.value) / 100) }, sliding.current)}
        />
      </label>
      {/* A light added by hand to something that isn't a lamp can be taken away again (lamps keep theirs). */}
      {!isLampLike(item.name) ? (
        <button className="btn btn-ghost btn-sm light-add" data-testid="light-remove-btn" onClick={() => usePlanner.getState().updateItem(item.id, { light: undefined })}>
          Not a light source
        </button>
      ) : null}
    </section>
  );
}
