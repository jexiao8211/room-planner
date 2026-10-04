// Lighting helpers shared by the store, the scene, the inspector and the chat executor (pure, no three.js).
import type { LightSettings, LightingMode, Mount, Opening, PlacedItem, ShapePart } from "../shared/types";

export const LIGHTING_MODES: { key: LightingMode; label: string; title: string }[] = [
  { key: "day", label: "Day", title: "Daylight: bright room, sunlight through open windows" },
  { key: "evening", label: "Evening", title: "Evening: warm low sun, lamps noticeably on" },
  { key: "night", label: "Night", title: "Night: dark outside, only lamps light the room" },
];

export const WARM_LIGHT = "#ffd8a8";
export const DEFAULT_LIGHT: LightSettings = { on: true, color: WARM_LIGHT, intensity: 0.7 };

export function lightingMode(v: unknown): LightingMode {
  return v === "evening" || v === "night" ? v : "day";
}

export function windowCovering(o: Pick<Opening, "kind" | "covering">): "open" | "closed" {
  return o.kind === "window" && o.covering === "closed" ? "closed" : "open";
}

/** Color words that make "light" an adjective ("light oak desk", "light gray sofa"), not a lamp. */
const LIGHT_ADJECTIVE_NEXT =
  /^(?:gr[ae]y|blue|green|pink|brown|beige|oak|wood(?:en)?|ash|maple|pine|walnut|tan|cream|yellow|purple|lavender|teal|sage|olive|taupe|natural|weight|wash|duty|colou?red|toned?|blush|mint|sand|stone|linen|birch)\b/;

/**
 * Whether an item name (or product name) is something that gives light: lamp, light, lantern, pendant, sconce,
 * chandelier... "Light oak desk" / "lightweight chair" are not.
 */
export function isLampLike(name: string): boolean {
  const s = name.toLowerCase();
  if (/\b(?:lamps?|lanterns?|pendants?|sconces?|chandeliers?|luminaires?|torch[iè]re?s?|nightlights?|bulbs?|light\s*fixtures?|downlights?|spotlights?|uplights?|string\s+lights|fairy\s+lights)\b/.test(s)) return true;
  // "light" / "lights" as the noun: not followed by a color/material word, and not "light-weight".
  for (const m of s.matchAll(/\blights?\b/g)) {
    const rest = s.slice(m.index + m[0].length).replace(/^[\s-]+/, "");
    if (!LIGHT_ADJECTIVE_NEXT.test(rest)) return true;
  }
  return false;
}

/** Default light for a new item when it is lamp-like (by preset key or name), else undefined. */
export function autoLight(input: { name: string; presetKey?: string; light?: LightSettings }): LightSettings | undefined {
  if (input.light) return input.light;
  if (input.presetKey === "pendant" || isLampLike(input.name)) return { ...DEFAULT_LIGHT };
  return undefined;
}

/** A clean LightSettings from untrusted data, or undefined. */
export function normalizeLight(v: unknown): LightSettings | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const color = typeof o.color === "string" && /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color.toLowerCase() : WARM_LIGHT;
  const intensity = typeof o.intensity === "number" && Number.isFinite(o.intensity) ? clamp01(o.intensity) : DEFAULT_LIGHT.intensity;
  return { on: o.on !== false, color, intensity };
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ---------- warm <-> cool ----------

/** Color stops from cool daylight (0) through neutral white to warm candle-ish (1). */
const WARMTH_STOPS: [number, [number, number, number]][] = [
  [0, [0xc8, 0xdc, 0xff]],
  [0.4, [0xff, 0xf4, 0xe6]],
  [0.7, [0xff, 0xd8, 0xa8]],
  [1, [0xff, 0xb0, 0x62]],
];

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, "0");

/** Light color for a warmth in 0 (cool) .. 1 (warm). warmthColor(0.7) is the default warm white. */
export function warmthColor(warmth: number): string {
  const w = clamp01(warmth);
  for (let i = 1; i < WARMTH_STOPS.length; i++) {
    const [t1, c1] = WARMTH_STOPS[i];
    const [t0, c0] = WARMTH_STOPS[i - 1];
    if (w <= t1 + 1e-9) {
      const k = (w - t0) / (t1 - t0);
      return `#${c0.map((c, j) => hex2(c + (c1[j] - c) * k)).join("")}`;
    }
  }
  return "#ffb062";
}

function rgb(hex: string): [number, number, number] | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The warmth (0..1) whose color is closest to `hex` (for the slider position of any light color). */
export function colorWarmth(hex: string): number {
  const c = rgb(hex);
  if (!c) return 0.7;
  let best = 0.7;
  let bestD = Infinity;
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    const s = rgb(warmthColor(t))!;
    const d = (s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2 + (s[2] - c[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/** One step warmer / cooler / brighter / dimmer, as chat and quick buttons use it. */
export const LIGHT_STEP = 0.25;

// ---------- where the bulb is ----------

const partVolume = (p: ShapePart) => p.size.x * p.size.y * p.size.z;
const isThin = (p: ShapePart) => p.size.x < 0.2 && p.size.z < 0.2;

/**
 * Index of the part that glows (the shade): for a hanging item its lowest big part (the cord is thin and on top),
 * for a standing / wall item its highest big part (a lamp's shade sits on a thin stem). Single-part items glow whole.
 */
export function shadePartIndex(parts: ShapePart[], mount: Mount): number {
  if (parts.length <= 1) return 0;
  const candidates = parts.map((p, i) => ({ p, i })).filter(({ p }) => !isThin(p));
  const pool = candidates.length ? candidates : parts.map((p, i) => ({ p, i }));
  if (mount === "ceiling") {
    return pool.reduce((best, c) => (c.p.center.y - c.p.size.y / 2 < best.p.center.y - best.p.size.y / 2 - 1e-6 ? c : best)).i;
  }
  return pool.reduce((best, c) => {
    const top = c.p.center.y + c.p.size.y / 2;
    const bestTop = best.p.center.y + best.p.size.y / 2;
    if (top > bestTop + 1e-6) return c;
    if (Math.abs(top - bestTop) <= 1e-6 && partVolume(c.p) > partVolume(best.p)) return c;
    return best;
  }).i;
}

/** Where the bulb sits, in the item's local frame (origin = bottom-center of its bbox): the shade's center. */
export function lightAnchorLocal(item: Pick<PlacedItem, "parts" | "dims" | "mount">): { x: number; y: number; z: number } {
  const part = item.parts[shadePartIndex(item.parts, item.mount)];
  if (!part) return { x: 0, y: item.dims.h * (item.mount === "ceiling" ? 0.2 : 0.8), z: 0 };
  // A standing lamp's bulb is a little below the shade's center (the shade opens downward).
  const dy = item.mount === "ceiling" ? -0.1 : -0.15;
  return {
    x: part.center.x * item.dims.w,
    y: Math.max(0.02, (part.center.y + dy * part.size.y) * item.dims.h),
    z: part.center.z * item.dims.d,
  };
}

/** The bulb position in room coordinates. */
export function lightAnchorWorld(item: Pick<PlacedItem, "parts" | "dims" | "mount" | "position" | "rotationY">): { x: number; y: number; z: number } {
  const l = lightAnchorLocal(item);
  const c = Math.cos(item.rotationY);
  const s = Math.sin(item.rotationY);
  // Rotation about +y: x' = x cos + z sin, z' = -x sin + z cos.
  return { x: item.position.x + l.x * c + l.z * s, y: item.position.y + l.y, z: item.position.z - l.x * s + l.z * c };
}

/**
 * Which lights get real-time shadows: at most `budget`, lights that are on first, brightest first, then nearest the
 * room center (ties stay in plan order). Returns ids.
 */
export function shadowCasters(
  lights: Array<{ id: string; on: boolean; intensity: number; x: number; z: number }>,
  budget: number,
): Set<string> {
  const ranked = lights
    .map((l, i) => ({ ...l, i }))
    .sort((a, b) => Number(b.on) - Number(a.on) || b.intensity - a.intensity || Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z) || a.i - b.i);
  return new Set(ranked.slice(0, Math.max(0, budget)).map((l) => l.id));
}

/**
 * Point-light intensity (three.js units) for a UI brightness 0..1. Lamps use a gentle falloff (LAMP_DECAY) so a lamp
 * fills its corner of the room instead of burning a white spot onto the wall next to it.
 */
export function lampCandela(intensity: number): number {
  return 0.3 + 3.2 * clamp01(intensity);
}
export const LAMP_DECAY = 1.1;

// ---------- modes ----------

export interface ModeParams {
  background: string;
  ambient: { color: string; intensity: number };
  hemi: { sky: string; ground: string; intensity: number };
  key: { color: string; intensity: number; position: [number, number, number] };
  fill: { intensity: number };
  /** Multiplier on every lamp's point light. */
  lamp: number;
  /** Multiplier on a lamp shade's glow (emissive). */
  glow: number;
  /** Window sun beam: color, strength, and how steeply it comes in (elevation, degrees above horizontal). */
  sun: { color: string; intensity: number; elevation: number };
  /** Window glass: day sky vs. night sky tint. */
  glass: { color: string; opacity: number; emissive: number };
  contactShadow: number;
}

export const MODE_PARAMS: Record<LightingMode, ModeParams> = {
  day: {
    background: "#f3f1ec",
    ambient: { color: "#ffffff", intensity: 0.85 },
    hemi: { sky: "#ffffff", ground: "#d8cfc0", intensity: 0.7 },
    key: { color: "#ffffff", intensity: 1.9, position: [3, 7, 4] },
    fill: { intensity: 0.6 },
    lamp: 0.35,
    glow: 0.35,
    sun: { color: "#fff1d6", intensity: 120, elevation: 42 },
    glass: { color: "#a9cfe6", opacity: 0.28, emissive: 0 },
    contactShadow: 0.35,
  },
  evening: {
    background: "#e9dccd",
    ambient: { color: "#ffd7b0", intensity: 0.36 },
    hemi: { sky: "#ffc9a0", ground: "#6b5646", intensity: 0.26 },
    key: { color: "#ffb070", intensity: 0.45, position: [5, 2.5, 3] },
    fill: { intensity: 0.08 },
    lamp: 1.2,
    glow: 0.9,
    sun: { color: "#ff9a4a", intensity: 150, elevation: 16 },
    glass: { color: "#f2a46a", opacity: 0.38, emissive: 0.25 },
    contactShadow: 0.3,
  },
  night: {
    background: "#272c3a",
    // A faint cool fill keeps the walls readable; the lamps do the rest (a clear pool of light around each one).
    ambient: { color: "#8fa3d6", intensity: 0.2 },
    hemi: { sky: "#7a8cc0", ground: "#2a2622", intensity: 0.15 },
    key: { color: "#9db0e0", intensity: 0.1, position: [3, 7, 4] },
    fill: { intensity: 0.04 },
    lamp: 1.5,
    glow: 1,
    sun: { color: "#9db0e0", intensity: 0, elevation: 40 },
    glass: { color: "#14213d", opacity: 0.82, emissive: 0.15 },
    contactShadow: 0.18,
  },
};
