import type { Units } from "../shared/types";

export const M_PER_IN = 0.0254;
export const M_PER_FT = 0.3048;

/** Format a length in meters for display, e.g. 2.44 → `8' 0"` (imperial) or `244 cm` (metric). */
export function formatLength(meters: number, units: Units): string {
  if (!Number.isFinite(meters)) return "—";
  // Format the magnitude, then prefix a sign (so -0.3 m is -1' 0", not -1' 8").
  const abs = Math.abs(meters);
  if (units === "metric") {
    const cm = Math.round(abs * 100);
    if (cm >= 100) return `${meters < 0 ? "-" : ""}${abs.toFixed(2)} m`;
    return `${meters < 0 && cm > 0 ? "-" : ""}${cm} cm`;
  }
  const totalIn = Math.round(abs / M_PER_IN);
  const sign = meters < 0 && totalIn > 0 ? "-" : "";
  const ft = Math.floor(totalIn / 12);
  const inches = totalIn - ft * 12;
  if (ft === 0) return `${sign}${inches}"`;
  return `${sign}${ft}' ${inches}"`;
}

/** Format w × d × h for an item. */
export function formatDims(d: { w: number; h: number; d: number }, units: Units): string {
  return `${formatLength(d.w, units)} W × ${formatLength(d.d, units)} D × ${formatLength(d.h, units)} H`;
}

/** The number shown in a numeric input for this unit system (inches or centimeters). */
export function toInputValue(meters: number, units: Units): number {
  return units === "imperial" ? Math.round((meters / M_PER_IN) * 10) / 10 : Math.round(meters * 1000) / 10;
}

export function fromInputValue(value: number, units: Units): number {
  return units === "imperial" ? value * M_PER_IN : value / 100;
}

export function inputUnitLabel(units: Units): string {
  return units === "imperial" ? "in" : "cm";
}

/**
 * Meters for a bare number (no unit) typed in metric.
 * With `displayedMeters` (the value the field currently shows), the number is read in the unit the field
 * displays: a field showing "1.22 m" reads "1.25" as meters (but "120" as cm, since nobody means 120 m), a
 * field showing "45 cm" reads "45" as cm (but a decimal like "1.2" or "0.6" as meters).
 * Without context, numbers under 10 are meters ("2.4") and larger ones centimeters ("240").
 */
function bareMetric(v: number, raw: string, displayedMeters?: number): number {
  if (displayedMeters === undefined || !Number.isFinite(displayedMeters)) return v < 10 ? v : v / 100;
  const showsMeters = Math.round(Math.abs(displayedMeters) * 100) >= 100;
  if (showsMeters) return v >= 20 ? v / 100 : v;
  return raw.includes(".") && v < 10 ? v : v / 100;
}

/**
 * Parse free-form lengths like `8'`, `8 ft 2 in`, `96"`, `96 in`, `2.4m`, `240 cm`, `2400mm`.
 * A bare number is inches in imperial; in metric it is read as described in bareMetric (pass the value the
 * input currently shows as `displayedMeters` so "1.25" in a field showing "1.22 m" means meters).
 * Returns meters, or null if unparseable.
 */
export function parseLength(text: string, defaultUnits: Units, displayedMeters?: number): number | null {
  const s = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  const ftIn = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)?)?$/);
  if (ftIn) return Number(ftIn[1]) * M_PER_FT + (ftIn[2] ? Number(ftIn[2]) * M_PER_IN : 0);
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(mm|cm|m|meters?|metres?|"|in|inch|inches)?$/);
  if (!m) return null;
  const v = Number(m[1]);
  switch (m[2]) {
    case "mm":
      return v / 1000;
    case "cm":
      return v / 100;
    case "m":
    case "meter":
    case "meters":
    case "metre":
    case "metres":
      return v;
    case '"':
    case "in":
    case "inch":
    case "inches":
      return v * M_PER_IN;
    default:
      return defaultUnits === "imperial" ? v * M_PER_IN : bareMetric(v, m[1], displayedMeters);
  }
}
