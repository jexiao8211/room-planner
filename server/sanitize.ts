// Server-side cleanup of model (and fixture) output so the client always gets sane, renderable data.
import type {
  ColorSwatch,
  Dims,
  Mount,
  Opening,
  PlacedItem,
  ProductCandidate,
  Room,
  ShapeKind,
  ShapePart,
  Vec3,
  WallSide,
} from "../src/shared/types";
import { attachToWall, constrainToRoom } from "../src/lib/geometry";
import { httpUrl } from "../src/lib/urls";

export const LIMITS = {
  itemMin: 0.02,
  itemMax: 5,
  roomSizeMin: 1.5,
  roomSizeMax: 15,
  roomHeightMin: 1.8,
  roomHeightMax: 6,
  openingMin: 0.2,
  maxParts: 16,
  maxItems: 40,
  maxOpenings: 16,
} as const;

const WALLS: WallSide[] = ["north", "south", "east", "west"];
const MOUNTS: Mount[] = ["floor", "wall", "ceiling"];
const SHAPES: ShapeKind[] = ["box", "cylinder", "sphere", "cone"];

// ---------- primitives ----------

export function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/** Finite number or the fallback. */
export function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function round(v: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Normalize to lowercase "#rrggbb"; accepts "#rgb", "rgb", "#rrggbb", "rrggbb". Returns null if invalid. */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.trim().toLowerCase();
  if (s.startsWith("#")) s = s.slice(1);
  if (/^[0-9a-f]{3}$/.test(s)) s = s.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/.test(s)) return null;
  return `#${s}`;
}

export function hexOr(v: unknown, fallback: string): string {
  return normalizeHex(v) ?? fallback;
}

function cleanText(v: unknown, maxLen: number): string {
  if (typeof v !== "string") return "";
  return v.replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function optText(v: unknown, maxLen: number): string | undefined {
  const s = cleanText(v, maxLen);
  return s ? s : undefined;
}

function cleanList(v: unknown, maxItems: number, maxLen = 60): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of v) {
    const s = cleanText(raw, maxLen);
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** One of `allowed` (case- and whitespace-insensitive, since model output isn't enum-checked), else the fallback. */
export function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof v !== "string") return fallback;
  const s = v.trim().toLowerCase();
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

/** Only http(s) URLs survive. */
export function cleanUrl(v: unknown): string | undefined {
  return httpUrl(v);
}

// ---------- ids ----------

/** Per-response id generator: deterministic, readable, never collides within one response. */
export class IdGen {
  private used = new Set<string>();
  private counters = new Map<string, number>();

  /** Keep `wanted` if it's a valid, unused id; otherwise mint `${prefix}_${n}`. */
  take(prefix: string, wanted?: unknown): string {
    if (typeof wanted === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(wanted) && !this.used.has(wanted)) {
      this.used.add(wanted);
      return wanted;
    }
    let n = this.counters.get(prefix) ?? 0;
    let id: string;
    do {
      n += 1;
      id = `${prefix}_${n}`;
    } while (this.used.has(id));
    this.counters.set(prefix, n);
    this.used.add(id);
    return id;
  }
}

// ---------- shapes ----------

export function sanitizeDims(d: Partial<Dims> | undefined, fallback: Dims = { w: 0.5, h: 0.5, d: 0.5 }): Dims {
  return {
    w: round(clamp(num(d?.w, fallback.w), LIMITS.itemMin, LIMITS.itemMax)),
    h: round(clamp(num(d?.h, fallback.h), LIMITS.itemMin, LIMITS.itemMax)),
    d: round(clamp(num(d?.d, fallback.d), LIMITS.itemMin, LIMITS.itemMax)),
  };
}

export function fullBoxPart(): ShapePart {
  return { kind: "box", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } };
}

/**
 * Parts are fractions of the bbox. Sizes clamp to (0, 1]; centers clamp so the part stays inside
 * the bbox (x/z ∈ [-0.5, 0.5], y ∈ [0, 1]). Empty / all-invalid → one full box.
 */
export function sanitizeParts(parts: unknown): ShapePart[] {
  const out: ShapePart[] = [];
  if (Array.isArray(parts)) {
    for (const raw of parts as Array<Partial<ShapePart> | null | undefined>) {
      if (!raw || typeof raw !== "object") continue;
      const kind = pick(raw.kind, SHAPES, "box");
      const sx = clamp(num(raw.size?.x, 1), 0.005, 1);
      const sy = clamp(num(raw.size?.y, 1), 0.005, 1);
      const sz = clamp(num(raw.size?.z, 1), 0.005, 1);
      const cx = clamp(num(raw.center?.x, 0), -0.5 + sx / 2, 0.5 - sx / 2);
      const cy = clamp(num(raw.center?.y, 0.5), sy / 2, 1 - sy / 2);
      const cz = clamp(num(raw.center?.z, 0), -0.5 + sz / 2, 0.5 - sz / 2);
      const part: ShapePart = {
        kind,
        center: { x: round(cx), y: round(cy), z: round(cz) },
        size: { x: round(sx), y: round(sy), z: round(sz) },
      };
      const color = normalizeHex(raw.color);
      if (color) part.color = color;
      out.push(part);
      if (out.length >= LIMITS.maxParts) break;
    }
  }
  return out.length ? out : [fullBoxPart()];
}

// ---------- room ----------

export const DEFAULT_WALL = "#e9e4dc";
export const DEFAULT_FLOOR = "#b89874";

export function wallLength(room: Pick<Room, "width" | "depth">, wall: WallSide): number {
  return wall === "north" || wall === "south" ? room.width : room.depth;
}

export function sanitizeOpening(raw: Partial<Opening>, room: Pick<Room, "width" | "depth" | "height">, ids: IdGen): Opening {
  const kind = pick(raw.kind, ["door", "window"] as const, "door");
  const wall = pick(raw.wall, WALLS, kind === "door" ? "south" : "north");
  const len = wallLength(room, wall);
  const width = clamp(num(raw.width, kind === "door" ? 0.81 : 1.0), LIMITS.openingMin, Math.max(LIMITS.openingMin, len - 0.1));
  const maxH = room.height - 0.05;
  const height = clamp(num(raw.height, kind === "door" ? 2.03 : 1.2), LIMITS.openingMin, maxH);
  const sill = kind === "door" ? 0 : clamp(num(raw.sill, 0.9), 0, Math.max(0, room.height - height - 0.05));
  const offset = clamp(num(raw.offset, len / 2), width / 2, len - width / 2);
  return {
    id: ids.take(kind === "door" ? "door" : "win", raw.id),
    kind,
    wall,
    offset: round(offset),
    width: round(width),
    height: round(height),
    sill: round(sill),
  };
}

export function sanitizeRoom(raw: Partial<Room> | undefined, ids: IdGen = new IdGen()): Room {
  const width = round(clamp(num(raw?.width, 3.66), LIMITS.roomSizeMin, LIMITS.roomSizeMax));
  const depth = round(clamp(num(raw?.depth, 3.35), LIMITS.roomSizeMin, LIMITS.roomSizeMax));
  const height = round(clamp(num(raw?.height, 2.44), LIMITS.roomHeightMin, LIMITS.roomHeightMax));
  const dims = { width, depth, height };
  const openings = (Array.isArray(raw?.openings) ? raw.openings : [])
    .slice(0, LIMITS.maxOpenings)
    .map((o) => sanitizeOpening(o ?? {}, dims, ids));
  return {
    name: cleanText(raw?.name, 80) || "My room",
    width,
    depth,
    height,
    wallColor: hexOr(raw?.wallColor, DEFAULT_WALL),
    floorColor: hexOr(raw?.floorColor, DEFAULT_FLOOR),
    openings,
  };
}

// ---------- items ----------

/** Things that hang from a ceiling, by name: a pendant listed as "floor" (or with no usable mount) is a ceiling item. */
const HANGING_NAME = /\b(?:pendants?|chandeliers?|ceiling\s+(?:lamps?|lights?|fans?|fixtures?)|hanging\s+(?:lamps?|lights?|lanterns?|planters?))\b/i;
const MOUNT_WORDS: Array<[RegExp, Mount]> = [
  [/\b(?:ceiling|hanging|hung|pendant|suspend(?:ed)?|chandelier|flush|semi[\s-]?flush|overhead)\b/i, "ceiling"],
  [/\b(?:wall|sconce|mounted\s+on\s+(?:the\s+)?wall)\b/i, "wall"],
  [/\b(?:floor|standing|freestanding|free[\s-]standing|table(?:top)?|desk(?:top)?|countertop)\b/i, "floor"],
];

/**
 * A mount from a model's free-text field: "ceiling" / "wall" / "floor", or a description of one ("Ceiling (hanging)",
 * "pendant", "wall-mounted", "hanging"). Unreadable → by the item's name (a pendant hangs), else `fallback`. A product
 * named like a pendant / chandelier hangs from the ceiling even when the model said "floor" (a swag pendant that plugs
 * into the wall still hangs). This is how a pendant lamp used to end up as Mount = Floor.
 */
export function mountFrom(v: unknown, name: unknown, fallback: Mount = "floor"): Mount {
  const label = typeof name === "string" ? name : "";
  let mount: Mount | null = null;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    mount = (MOUNTS as string[]).includes(s) ? (s as Mount) : (MOUNT_WORDS.find(([re]) => re.test(s))?.[1] ?? null);
  }
  if (HANGING_NAME.test(label) && mount !== "wall") return "ceiling";
  return mount ?? fallback;
}

export function sanitizeItem(raw: Partial<PlacedItem>, room: Room, ids: IdGen): PlacedItem {
  const mount = mountFrom(raw.mount, raw.name);
  const dims = sanitizeDims(raw.dims);
  // Items can't be larger than the room itself.
  dims.w = Math.min(dims.w, room.width);
  dims.d = Math.min(dims.d, room.depth);
  dims.h = Math.min(dims.h, room.height);
  let rotationY = num(raw.rotationY, 0);
  const position: Vec3 = {
    x: num(raw.position?.x, 0),
    y: num(raw.position?.y, 0),
    z: num(raw.position?.z, 0),
  };
  let constrained: Vec3;
  if (mount === "wall") {
    // Hang it flush on the wall it stands against. The model's rotation is only trusted when it agrees with that
    // wall (wallForItem): a TV against the east wall with the default rotation 0 must not move to the north wall.
    const attached = attachToWall({ position, dims, rotationY }, room);
    rotationY = attached.rotationY;
    constrained = attached.position;
  } else {
    constrained = constrainToRoom({ position, dims, rotationY, mount }, room);
  }
  const item: PlacedItem = {
    id: ids.take("item", raw.id),
    name: cleanText(raw.name, 80) || "Item",
    position: { x: round(constrained.x), y: round(constrained.y), z: round(constrained.z) },
    rotationY: round(Math.atan2(Math.sin(rotationY), Math.cos(rotationY)), 5),
    dims,
    color: hexOr(raw.color, "#9a9a9a"),
    mount,
    parts: sanitizeParts(raw.parts),
    origin: pick(raw.origin, ["existing", "shape", "product"] as const, "existing"),
  };
  if (raw.product) item.product = raw.product;
  if (raw.hidden) item.hidden = true;
  if (raw.locked) item.locked = true;
  return item;
}

export function sanitizeItems(raw: Array<Partial<PlacedItem>>, room: Room, ids: IdGen): PlacedItem[] {
  return raw.slice(0, LIMITS.maxItems).map((it) => sanitizeItem(it, room, ids));
}

// ---------- products ----------

function sanitizeColors(v: unknown): ColorSwatch[] {
  const out: ColorSwatch[] = [];
  if (Array.isArray(v)) {
    for (const c of v as Array<Partial<ColorSwatch> | null>) {
      const hex = normalizeHex(c?.hex);
      if (!hex) continue;
      if (out.some((o) => o.hex === hex)) continue;
      out.push({ name: cleanText(c?.name, 40) || hex, hex });
      if (out.length >= 8) break;
    }
  }
  return out;
}

/** Returns null when the candidate is unusable (no valid product URL). */
export function sanitizeCandidate(raw: Partial<ProductCandidate>, ids: IdGen): ProductCandidate | null {
  const url = cleanUrl(raw.url);
  if (!url) return null;
  const colors = sanitizeColors(raw.colors);
  const parts = sanitizeParts(raw.parts);
  const c: ProductCandidate = {
    // Ids derive from the URL so they stay unique across searches (the UI keys cards and the preview by id).
    id: ids.take("prod", raw.id ?? `prod_${hashString(url)}`),
    name: cleanText(raw.name, 120) || "Product",
    retailer: cleanText(raw.retailer, 60) || hostOf(url),
    url,
    dims: sanitizeDims(raw.dims),
    dimsSource: pick(raw.dimsSource, ["listed", "estimated"] as const, "estimated"),
    colors: colors.length ? colors : [{ name: "Default", hex: "#999999" }],
    style: cleanList(raw.style, 8, 40),
    materials: cleanList(raw.materials, 8, 40),
    mount: mountFrom(raw.mount, raw.name),
    parts,
  };
  const price = num(raw.price, NaN);
  if (Number.isFinite(price) && price >= 0 && price < 1_000_000) {
    c.price = Math.round(price * 100) / 100;
    const cur = typeof raw.currency === "string" ? raw.currency.trim().toUpperCase() : "";
    c.currency = /^[A-Z]{3}$/.test(cur) ? cur : "USD";
  }
  const imageUrl = cleanUrl(raw.imageUrl);
  if (imageUrl) c.imageUrl = imageUrl;
  const dimsText = optText(raw.dimsText, 120);
  if (dimsText) c.dimsText = dimsText;
  const origin = optText(raw.origin, 120);
  if (origin) c.origin = origin;
  const summary = optText(raw.summary, 400);
  if (summary) c.summary = summary;
  return c;
}

/** Short, stable base-36 hash (FNV-1a, 32-bit) — for ids, not security. */
export function hashString(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ---------- scale fix ----------

/** Raw (pre-sanitize) room estimate shape the scaler works on. */
export interface DraftRoomEstimate {
  room: Partial<Room> & { width: number; depth: number; height: number };
  openings: Array<Partial<Opening>>;
  items: Array<Partial<PlacedItem>>;
}

export interface ScaleDecision {
  factor: number;
  /** What the known measurement was compared against. */
  basis: "ceiling height" | "door height" | "door width" | "model estimate" | "none";
  estimate?: number;
}

/**
 * Decide the uniform scale factor that makes the estimate match the user's known measurement.
 * Label mentions a door → compare to the tallest door's height (or width if the label says width).
 * Label mentions the ceiling (or is just "height" / "room height") → compare to room height. Otherwise use what the model says it
 * estimated that object to be. Factors within ±3% are ignored.
 */
export function decideScale(
  known: { label: string; meters: number } | undefined,
  draft: DraftRoomEstimate,
  modelEstimateMeters: number | null | undefined,
): ScaleDecision {
  if (!known || !(known.meters > 0)) return { factor: 1, basis: "none" };
  const label = known.label.toLowerCase();
  let basis: ScaleDecision["basis"] = "none";
  let estimate: number | undefined;

  const doors = draft.openings.filter((o) => o.kind === "door");
  if (/\bdoor/.test(label) && doors.length) {
    if (/\bwid(th|e)\b/.test(label)) {
      estimate = Math.max(...doors.map((d) => num(d.width, 0)));
      basis = "door width";
    } else {
      estimate = Math.max(...doors.map((d) => num(d.height, 0)));
      basis = "door height";
    }
  } else if (/ceiling/.test(label) || /^\s*(room|wall)?\s*(height|tall)\s*$/.test(label)) {
    estimate = draft.room.height;
    basis = "ceiling height";
  } else if (modelEstimateMeters && modelEstimateMeters > 0) {
    estimate = modelEstimateMeters;
    basis = "model estimate";
  }
  if (!estimate || !(estimate > 0)) return { factor: 1, basis: "none" };
  const factor = known.meters / estimate;
  if (Math.abs(factor - 1) <= 0.03) return { factor: 1, basis, estimate };
  // Refuse absurd corrections (likely a mislabeled measurement); sanitize clamps the rest.
  if (factor < 0.2 || factor > 5) return { factor: 1, basis: "none", estimate };
  return { factor, basis, estimate };
}

/** Uniformly scale room, openings and items (parts are fractions, so they need no change). */
export function rescaleDraft(draft: DraftRoomEstimate, factor: number): DraftRoomEstimate {
  if (factor === 1) return draft;
  const s = (v: number | undefined) => (typeof v === "number" ? v * factor : v);
  return {
    room: { ...draft.room, width: draft.room.width * factor, depth: draft.room.depth * factor, height: draft.room.height * factor },
    openings: draft.openings.map((o) => ({ ...o, offset: s(o.offset), width: s(o.width), height: s(o.height), sill: s(o.sill) })),
    items: draft.items.map((it) => ({
      ...it,
      dims: it.dims ? { w: it.dims.w * factor, h: it.dims.h * factor, d: it.dims.d * factor } : it.dims,
      position: it.position ? { x: it.position.x * factor, y: it.position.y * factor, z: it.position.z * factor } : it.position,
    })),
  };
}

/** Draft → final sanitized room + existing items. */
export function finalizeRoomEstimate(draft: DraftRoomEstimate): { room: Room; existingItems: PlacedItem[] } {
  const ids = new IdGen();
  const room = sanitizeRoom({ ...draft.room, openings: draft.openings as Opening[] }, ids);
  const existingItems = sanitizeItems(
    draft.items.map((it) => ({ ...it, origin: "existing" as const })),
    room,
    ids,
  );
  return { room, existingItems };
}
