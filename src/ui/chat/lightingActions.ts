// Chat actions for lighting (setLighting / setLight / setWindow), applied through the planner store. Used by
// executeActions.ts; kept here so the executor only dispatches to it.
import type { ChatAction, LightSettings, LightingMode, Opening, WallSide } from "../../shared/types";
import type { PlannerState } from "../../state/store";
import { DEFAULT_LIGHT, colorWarmth, lightingMode, windowCovering } from "../../lib/lighting";

export type LightingAction = Extract<ChatAction, { type: "setLighting" | "setLight" | "setWindow" }>;

export interface LightingResult {
  ok: boolean;
  label: string;
  error?: string;
  /** Done, but with a caveat (an "adjusted" chip). */
  note?: string;
  swatch?: string;
  /** Item the action changed (selected at the end of the turn, so "it" means the lamp next). */
  touched?: string;
}

const MODE_LABEL: Record<LightingMode, string> = { day: "Day", evening: "Evening", night: "Night" };
const WALL_LABEL: Record<WallSide, string> = { north: "north wall", south: "south wall", east: "east wall", west: "west wall" };
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const hex = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return null;
};

export function isLightingAction(a: ChatAction): a is LightingAction {
  return a?.type === "setLighting" || a?.type === "setLight" || a?.type === "setWindow";
}

/**
 * Apply one lighting action. `resolve` turns an item id / ref / name into an item id (the executor's lookup).
 * Never throws: failures come back as ok false with a reason.
 */
export function runLightingAction(a: LightingAction, S: () => PlannerState, resolve: (key: unknown) => string | null): LightingResult {
  switch (a.type) {
    case "setLighting": {
      const mode = a.mode === "day" || a.mode === "evening" || a.mode === "night" ? a.mode : null;
      if (!mode) return { ok: false, label: "Change lighting", error: `unknown lighting "${String(a.mode)}"` };
      if (lightingMode(S().room.lighting) === mode) return { ok: true, label: `Lighting is already ${MODE_LABEL[mode]}` };
      S().updateRoom({ lighting: mode });
      return { ok: true, label: `Lighting → ${MODE_LABEL[mode]}` };
    }
    case "setLight": {
      const id = resolve(a.itemId);
      const it = id ? S().items.find((x) => x.id === id) : undefined;
      if (!it) return { ok: false, label: "Change light", error: `couldn't find "${String(a.itemId ?? "")}"` };
      const before: LightSettings = it.light ?? { ...DEFAULT_LIGHT };
      const next: LightSettings = { ...before };
      const parts: string[] = [];
      if (typeof a.on === "boolean") next.on = a.on;
      if (finite(a.intensity)) {
        next.intensity = Math.min(1, Math.max(0, a.intensity));
        // Asking for brightness means it should be on (unless the same answer turns it off).
        if (a.on === undefined && next.intensity > 0) next.on = true;
      }
      const color = hex(a.color);
      if (color) next.color = color;
      if (!it.light) parts.push("now a light");
      if (next.on !== before.on || (!it.light && a.on !== undefined)) parts.push(next.on ? "on" : "off");
      if (Math.abs(next.intensity - before.intensity) > 1e-3) {
        parts.push(`${next.intensity > before.intensity ? "brighter" : "dimmer"} (${Math.round(next.intensity * 100)}%)`);
      }
      if (color && color !== before.color.toLowerCase()) {
        const dw = colorWarmth(color) - colorWarmth(before.color);
        parts.push(Math.abs(dw) < 0.03 ? "new light color" : dw > 0 ? "warmer light" : "cooler light");
      }
      if (!parts.length && it.light) return { ok: true, label: `${it.name} light unchanged`, swatch: before.color, touched: it.id };
      S().updateItem(it.id, { light: next });
      const caveat = it.hidden ? "it is hidden, so it doesn't light the room" : undefined;
      const verb = parts.length === 1 && (parts[0] === "on" || parts[0] === "off") ? `Turned ${parts[0]} ${it.name}` : `${it.name}: ${parts.join(", ")}`;
      return { ok: true, label: verb, swatch: next.color, touched: it.id, ...(caveat ? { note: caveat } : {}) };
    }
    case "setWindow": {
      const covering = a.covering === "closed" ? "closed" : a.covering === "open" ? "open" : null;
      if (!covering) return { ok: false, label: "Blinds", error: `unknown setting "${String(a.covering)}"` };
      const { room } = S();
      const windows = room.openings.filter((o) => o.kind === "window");
      const targets: Opening[] = a.openingId === "*" ? windows : windows.filter((o) => o.id === a.openingId);
      if (!targets.length) {
        const door = room.openings.find((o) => o.id === a.openingId && o.kind === "door");
        return { ok: false, label: covering === "closed" ? "Close blinds" : "Open blinds", error: door ? "that is a door, not a window" : windows.length ? "couldn't find that window" : "the room has no windows" };
      }
      const change = new Set(targets.filter((o) => windowCovering(o) !== covering).map((o) => o.id));
      const what = targets.length === 1 ? `window · ${WALL_LABEL[targets[0].wall]}` : `${targets.length} windows`;
      if (!change.size) return { ok: true, label: `Blinds already ${covering} (${what})` };
      S().updateRoom({ openings: room.openings.map((o) => (change.has(o.id) ? { ...o, covering } : o)) });
      return { ok: true, label: `${covering === "closed" ? "Closed" : "Opened"} the blinds (${what})` };
    }
  }
}
