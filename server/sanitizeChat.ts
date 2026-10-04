// Server-side check of a chat answer (model or mock parser) before it reaches the browser: every action is read
// field by field from untrusted JSON, ids and refs are resolved against the scene, numbers are clamped and
// anything that can't be applied safely is dropped (with a short reason, for the log and the reply).
import type { ChatAction, ChatPlacement, ChatResponse, ChatScene, Dims, LightingMode, Mount, ShapePart, WallSide } from "../src/shared/types";
import { SHAPE_PRESETS } from "../src/lib/presets";
import { STACK_SIZE_RATIO } from "../src/lib/geometry";
import { LIMITS, clamp, normalizeHex, sanitizeParts } from "./sanitize";
import { CHAT_LIMITS } from "./schemas";

const WALLS: WallSide[] = ["north", "south", "east", "west"];
const MOUNTS: Mount[] = ["floor", "wall", "ceiling"];
const CORNERS = ["nw", "ne", "sw", "se"] as const;
const SIDES = ["left", "right", "front", "behind"] as const;
const CAMERAS = ["iso", "top", "eye"] as const;
const LEVELS = ["top", "middle", "bottom"] as const;

export const PRESET_KEYS = SHAPE_PRESETS.map((p) => p.key);

/** Plain color words people (and the mock parser) use, as hex. */
export const COLOR_NAMES: Record<string, string> = {
  red: "#c0392b",
  orange: "#e67e22",
  yellow: "#f1c40f",
  green: "#27ae60",
  sage: "#9caf88",
  olive: "#808000",
  teal: "#16a085",
  blue: "#2e86c1",
  navy: "#1f2d4d",
  purple: "#8e44ad",
  lavender: "#b8a9d9",
  pink: "#e91e63",
  white: "#f5f5f2",
  cream: "#f3ead3",
  beige: "#d8c8a8",
  tan: "#c8a982",
  brown: "#7b5235",
  walnut: "#5c4033",
  oak: "#b8905f",
  wood: "#a0784f",
  black: "#222222",
  gray: "#8c8c8c",
  grey: "#8c8c8c",
  charcoal: "#36454f",
  silver: "#c0c0c0",
  gold: "#c9a227",
};

/** Hex from "#abc" / "#aabbcc" / a color word ("red", "light blue", "dark grey"); null otherwise. */
export function colorFrom(v: unknown): string | null {
  const hex = normalizeHex(v);
  if (hex) return hex;
  if (typeof v !== "string") return null;
  const words = v.trim().toLowerCase().replace(/[-_]/g, " ").split(/\s+/);
  const base = COLOR_NAMES[words[words.length - 1]];
  if (!base) return null;
  if (words.length === 2 && (words[0] === "light" || words[0] === "dark")) return shade(base, words[0] === "light" ? 0.45 : -0.45);
  return words.length === 1 ? base : null;
}

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.round(amount > 0 ? c + (255 - c) * amount : c * (1 + amount)),
  );
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

// ---------- small readers for untrusted JSON ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const r4 = (v: number) => Math.round(v * 10000) / 10000;

function pickLower<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return (allowed as readonly string[]).includes(s) ? (s as T) : null;
}

const CORNER_WORDS: Record<string, (typeof CORNERS)[number]> = {
  northwest: "nw",
  northeast: "ne",
  southwest: "sw",
  southeast: "se",
};

function corner(v: unknown): (typeof CORNERS)[number] | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase().replace(/[\s_-]/g, "");
  return pickLower(s, CORNERS) ?? CORNER_WORDS[s] ?? null;
}

const ACTION_TYPES: Record<string, ChatAction["type"]> = Object.fromEntries(
  (
    [
      "addShape",
      "move",
      "rotate",
      "resize",
      "recolor",
      "rename",
      "remove",
      "duplicate",
      "setRoom",
      "search",
      "addCandidate",
      "previewCandidate",
      "select",
      "camera",
      "undo",
      "setHidden",
      "setMount",
      "setHeight",
      "setOpening",
      "hang",
      "saveVersion",
      "restoreVersion",
      "setLighting",
      "setLight",
      "setWindow",
    ] as const
  ).map((t) => [t.toLowerCase(), t]),
);

// ---------- context ----------

interface Known {
  name: string;
  mount: Mount;
  supportId?: string;
  hidden?: boolean;
  /** Size, when known (for the stacking size rule). */
  dims?: Dims;
}

/** Scene ids and refs created so far in this answer, in order. */
class Ctx {
  readonly items = new Map<string, Known>();
  readonly refs = new Map<string, Known>();
  readonly removed = new Set<string>();
  /**
   * Items added in this answer without a ref, under a handle of our own: a later "Desk" then means the new desk, not
   * the old one. The handle is only written onto the add (as its ref) once something refers to it.
   */
  private readonly auto = new Map<string, { ref?: string }>();
  private autoN = 0;
  /** Refs the answer itself uses (our own handles must not collide with them). */
  private readonly taken: Set<string>;
  constructor(
    readonly scene: ChatScene,
    rawActions: unknown[] = [],
  ) {
    for (const it of scene.items) this.items.set(it.id, { name: it.name, mount: it.mount, supportId: it.supportId, hidden: it.hidden, dims: it.dims });
    this.taken = new Set(rawActions.map((a) => (isObj(a) && typeof a.ref === "string" ? a.ref.trim() : "")).filter(Boolean));
  }

  /** Register an item added without a (usable) ref so later name references find it. */
  track(action: { ref?: string }, known: Known): void {
    let key: string;
    do key = `new_${++this.autoN}`;
    while (this.taken.has(key) || this.items.has(key) || this.refs.has(key));
    this.refs.set(key, known);
    this.auto.set(key, action);
  }

  /**
   * An existing id or an earlier ref; as a last resort an exact (case-insensitive) item name, most recent wins: an
   * item created earlier in this answer beats one from the scene, and removed items are skipped.
   */
  resolve(v: unknown): string | null {
    if (typeof v !== "string") return null;
    const s = v.trim();
    if (!s) return null;
    if (this.items.has(s) || this.refs.has(s)) return this.removed.has(s) ? null : this.use(s);
    const lower = s.toLowerCase();
    const byName = [...this.items.entries(), ...this.refs.entries()].filter(([id, k]) => !this.removed.has(id) && k.name.toLowerCase() === lower);
    return byName.length ? this.use(byName[byName.length - 1][0]) : null;
  }

  /** A resolved id; one of our own handles is written onto its add as the ref the browser resolves. */
  private use(id: string): string {
    const add = this.auto.get(id);
    if (add) add.ref = id;
    return id;
  }

  /** The scene items `id` rests on, nearest first (cycle-safe). */
  supportsOf(id: string): string[] {
    const out: string[] = [];
    let cur = this.items.get(id)?.supportId;
    while (cur && !out.includes(cur) && cur !== id) {
      out.push(cur);
      cur = this.items.get(cur)?.supportId;
    }
    return out;
  }

  get(id: string): Known | undefined {
    return this.items.get(id) ?? this.refs.get(id);
  }

  /** A fresh ref handle, or null when it's malformed or already taken. */
  claimRef(v: unknown, known: Known): string | null {
    if (typeof v !== "string") return null;
    const s = v.trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(s) || this.items.has(s) || this.refs.has(s)) return null;
    this.refs.set(s, known);
    return s;
  }

  /** True when `target` rests (directly or transitively) on `id`, so `id` can't go on top of it. */
  restsOn(target: string, id: string): boolean {
    const seen = new Set<string>();
    let cur: string | undefined = target;
    while (cur && !seen.has(cur)) {
      if (cur === id) return true;
      seen.add(cur);
      cur = this.get(cur)?.supportId;
    }
    return false;
  }
}

// ---------- placement ----------

/**
 * "Put the pendant on / over / under the desk": a hanging item never rests on anything (it would turn into a floor
 * item); the app hangs it above the target wherever the target is when the action runs (an earlier action of the same
 * answer may move it), and its chip says "above Desk". So the placement is kept as it is, without a level.
 */
function hangAbove(_ctx: Ctx, target: string, kind: "onTop" | "under" = "onTop"): { placement: ChatPlacement } {
  return { placement: { kind, targetId: target } };
}

/**
 * A placement the browser can apply, or null with the reason. `selfId` is the item being placed (for the
 * on-top-of-itself and cycle checks); `mount` is its mount (only floor items can rest on or beside things).
 */
function cleanPlacement(raw: unknown, ctx: Ctx, selfId: string | null, mount: Mount, selfDims?: Dims): { placement: ChatPlacement } | { error: string } {
  if (!isObj(raw)) return { error: "placement is missing" };
  const kind = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
  const { width, depth } = ctx.scene.room;
  switch (kind) {
    case "center":
    case "centre":
    case "middle":
      return { placement: { kind: "center" } };
    case "corner": {
      const c = corner(raw.corner);
      return c ? { placement: { kind: "corner", corner: c } } : { error: `unknown corner "${text(raw.corner, 20)}"` };
    }
    case "wall": {
      const wall = pickLower(raw.wall, WALLS);
      if (!wall) return { error: `unknown wall "${text(raw.wall, 20)}"` };
      // A negative along (the -1 sentinel) = no preference: the app picks the free spot nearest the middle.
      const along = finite(raw.along);
      return { placement: along === null || along < 0 ? { kind: "wall", wall } : { kind: "wall", wall, along: r4(clamp(along, 0, 1)) } };
    }
    case "ontop": {
      const target = ctx.resolve(raw.targetId);
      if (!target) return { error: `unknown item "${text(raw.targetId, 40)}" to put it on` };
      if (mount === "ceiling") return hangAbove(ctx, target);
      if (mount !== "floor") return { error: `a ${mount} item can't rest on another item` };
      const support = ctx.get(target)!;
      if (support.mount !== "floor" || support.hidden) return { error: `"${support.name}" can't hold other items` };
      if (selfId && ctx.restsOn(target, selfId)) return { error: "an item can't rest on itself or on something resting on it" };
      // The app's size rule (fitsOnTop): at most 1.5× the support's top per axis, turned to match it.
      const dims = selfDims ?? (selfId ? ctx.get(selfId)?.dims : undefined);
      if (dims && support.dims && (dims.w > support.dims.w * STACK_SIZE_RATIO + 1e-6 || dims.d > support.dims.d * STACK_SIZE_RATIO + 1e-6)) {
        return { error: `it is too big to go on "${support.name}"` };
      }
      const level = pickLower(raw.level, LEVELS);
      return { placement: level && level !== "top" ? { kind: "onTop", targetId: target, level } : { kind: "onTop", targetId: target } };
    }
    case "under":
    case "underneath":
    case "below":
    case "beneath": {
      const target = ctx.resolve(raw.targetId);
      if (!target) return { error: `unknown item "${text(raw.targetId, 40)}" to put it under` };
      if (mount === "ceiling") return hangAbove(ctx, target, "under");
      if (mount !== "floor") return { error: `a ${mount} item can't go under another item` };
      const support = ctx.get(target)!;
      if (support.mount !== "floor" || support.hidden) return { error: `nothing can go under "${support.name}"` };
      if (target === selfId || (selfId && ctx.restsOn(target, selfId))) return { error: "an item can't go under itself or under something resting on it" };
      // Whether it fits under (the target's legs / clearance) is checked by the app, which knows the shapes.
      return { placement: { kind: "under", targetId: target } };
    }
    case "nextto": {
      const target = ctx.resolve(raw.targetId);
      if (!target) return { error: `unknown item "${text(raw.targetId, 40)}" to put it next to` };
      if (target === selfId) return { error: "an item can't go next to itself" };
      const placement: ChatPlacement = { kind: "nextTo", targetId: target };
      const side = pickLower(raw.side, SIDES);
      if (side) placement.side = side;
      const gap = finite(raw.gap);
      if (gap !== null) placement.gap = r4(clamp(gap, 0, 2));
      return { placement };
    }
    case "at": {
      const x = finite(raw.x);
      const z = finite(raw.z);
      if (x === null || z === null) return { error: "position needs x and z" };
      return { placement: { kind: "at", x: r4(clamp(x, -width / 2, width / 2)), z: r4(clamp(z, -depth / 2, depth / 2)) } };
    }
    case "floor":
    case "onfloor":
    case "ground":
      return { placement: { kind: "floor" } };
    default:
      return { error: `unknown placement "${text(raw.kind, 20)}"` };
  }
}

// ---------- actions ----------

const clampSize = (v: number) => r4(clamp(v, LIMITS.itemMin, LIMITS.itemMax));

/** Full dims from a partial / sentinel object (missing or <= 0 → fallback). */
function fullDims(raw: unknown, fallback: Dims): Dims | null {
  if (!isObj(raw)) return null;
  const pick = (k: keyof Dims) => {
    const v = finite(raw[k]);
    return v !== null && v > 0 ? clampSize(v) : fallback[k];
  };
  return { w: pick("w"), h: pick("h"), d: pick("d") };
}

/** A result index the scene's lastResults actually has. */
function resultAt(v: unknown, results: NonNullable<ChatScene["lastResults"]>) {
  const n = finite(v);
  if (n === null || !Number.isInteger(n)) return null;
  return results.find((r) => r.index === n) ?? null;
}

type Result =
  | { action: ChatAction; note?: string }
  /** `silent`: left out on purpose (e.g. a monitor moved together with its desk), not a failure. */
  | { error: string; type: string; reason: string; silent?: boolean };

const OPENING_OPS = ["add", "update", "remove"] as const;
const OPENING_KINDS = ["door", "window"] as const;

function cleanAction(raw: unknown, ctx: Ctx, movedTogether: Map<string, ChatPlacement>): Result {
  if (!isObj(raw)) return { error: "not an action", type: "action", reason: "not an action" };
  const type = typeof raw.type === "string" ? ACTION_TYPES[raw.type.trim().toLowerCase()] : undefined;
  if (!type) return { error: `unknown action "${text(raw.type, 30)}"`, type: "action", reason: `unknown action "${text(raw.type, 30)}"` };
  const err = (msg: string): Result => ({ error: `${type}: ${msg}`, type, reason: msg });
  const item = () => ctx.resolve(raw.itemId);
  const unknownItem = () => err(`unknown item "${text(raw.itemId, 40)}"`);
  const results = ctx.scene.lastResults ?? [];

  switch (type) {
    case "addShape": {
      const preset = SHAPE_PRESETS.find((p) => p.key === (typeof raw.preset === "string" ? raw.preset.trim().toLowerCase() : ""));
      const mount = pickLower(raw.mount, MOUNTS) ?? undefined;
      const effectiveMount: Mount = mount ?? preset?.mount ?? "floor";
      const name = text(raw.name, 60) || preset?.label || "Item";
      const action: Extract<ChatAction, { type: "addShape" }> = { type: "addShape", name };
      if (preset) action.preset = preset.key;
      const dims = fullDims(raw.dims, preset?.dims ?? { w: 0.5, h: 0.5, d: 0.5 });
      if (dims) action.dims = dims;
      const color = colorFrom(raw.color);
      if (color) action.color = color;
      if (mount) action.mount = mount;
      if (Array.isArray(raw.parts) && raw.parts.length) action.parts = sanitizeParts(raw.parts) as ShapePart[];
      let note: string | undefined;
      if (raw.placement !== undefined && raw.placement !== null) {
        const p = cleanPlacement(raw.placement, ctx, null, effectiveMount, dims ?? preset?.dims);
        if ("placement" in p) action.placement = p.placement;
        else note = `addShape "${name}": placement dropped (${p.error})`;
      }
      const known: Known = {
        name,
        mount: effectiveMount,
        supportId: action.placement?.kind === "onTop" || action.placement?.kind === "under" ? action.placement.targetId : undefined,
        dims: dims ?? preset?.dims,
      };
      const ref = ctx.claimRef(raw.ref, known);
      if (ref) action.ref = ref;
      else ctx.track(action, known);
      return { action, note };
    }
    case "move": {
      const id = item();
      if (!id) return unknownItem();
      const known = ctx.get(id)!;
      const p = cleanPlacement(raw.placement, ctx, id, known.mount);
      if ("error" in p) return err(p.error);
      // A monitor sent to the same place as its desk in the same answer ("move everything to the east wall"): the
      // desk carries it, and moving it on its own would knock it off the desk. A move somewhere else (the user named
      // the monitor) is kept.
      const carried = ctx.supportsOf(id).some((sid) => {
        const sp = movedTogether.get(sid);
        return !!sp && samePlace(p.placement, sp, ctx.get(sid)?.dims);
      });
      if (carried) {
        return { error: `move: "${known.name}" moves with what it rests on`, type, reason: "moves with what it rests on", silent: true };
      }
      known.supportId = p.placement.kind === "onTop" || p.placement.kind === "under" ? p.placement.targetId : undefined;
      if (p.placement.kind === "floor") known.mount = "floor";
      return { action: { type: "move", itemId: id, placement: p.placement } };
    }
    case "rotate": {
      const id = item();
      if (!id) return unknownItem();
      const deg = finite(raw.degrees);
      if (deg === null) return err("degrees is missing");
      const turned = ((deg % 360) + 360) % 360; // [0, 360)
      const degrees = Math.round((turned > 180 ? turned - 360 : turned) * 100) / 100; // (-180, 180]
      return { action: { type: "rotate", itemId: id, degrees, relative: raw.relative !== false } };
    }
    case "resize": {
      const id = item();
      if (!id) return unknownItem();
      const dims: Partial<Dims> = {};
      if (isObj(raw.dims)) {
        for (const k of ["w", "h", "d"] as const) {
          const v = finite(raw.dims[k]);
          if (v !== null && v > 0) dims[k] = clampSize(v);
        }
      }
      if (!Object.keys(dims).length) return err("no size given");
      const sized = ctx.get(id)!;
      if (sized.dims) sized.dims = { ...sized.dims, ...dims };
      return { action: { type: "resize", itemId: id, dims } };
    }
    case "recolor": {
      const id = item();
      if (!id) return unknownItem();
      const color = colorFrom(raw.color);
      if (!color) return err(`not a color "${text(raw.color, 20)}"`);
      return { action: { type: "recolor", itemId: id, color } };
    }
    case "rename": {
      const id = item();
      if (!id) return unknownItem();
      const name = text(raw.name, 60);
      if (!name) return err("name is empty");
      ctx.get(id)!.name = name;
      return { action: { type: "rename", itemId: id, name } };
    }
    case "remove": {
      const id = item();
      if (!id) return unknownItem();
      ctx.removed.add(id);
      return { action: { type: "remove", itemId: id } };
    }
    case "duplicate": {
      const id = item();
      if (!id) return unknownItem();
      const src = ctx.get(id)!;
      const action: Extract<ChatAction, { type: "duplicate" }> = { type: "duplicate", itemId: id };
      let note: string | undefined;
      if (raw.placement !== undefined && raw.placement !== null) {
        const p = cleanPlacement(raw.placement, ctx, null, src.mount, src.dims);
        if ("placement" in p) action.placement = p.placement;
        else note = `duplicate: placement dropped (${p.error})`;
      }
      const known: Known = {
        name: src.name,
        mount: src.mount,
        supportId: action.placement?.kind === "onTop" || action.placement?.kind === "under" ? action.placement.targetId : undefined,
        dims: src.dims,
      };
      const ref = ctx.claimRef(raw.ref, known);
      if (ref) action.ref = ref;
      else ctx.track(action, known);
      return { action, note };
    }
    case "setRoom": {
      const raw2 = isObj(raw.patch) ? raw.patch : {};
      const patch: Extract<ChatAction, { type: "setRoom" }>["patch"] = {};
      const name = text(raw2.name, 60);
      if (name) patch.name = name;
      const size = (k: "width" | "depth" | "height", lo: number, hi: number) => {
        const v = finite(raw2[k]);
        if (v !== null && v > 0) patch[k] = r4(clamp(v, lo, hi));
      };
      size("width", LIMITS.roomSizeMin, LIMITS.roomSizeMax);
      size("depth", LIMITS.roomSizeMin, LIMITS.roomSizeMax);
      size("height", LIMITS.roomHeightMin, LIMITS.roomHeightMax);
      const wall = colorFrom(raw2.wallColor);
      if (wall) patch.wallColor = wall;
      const floor = colorFrom(raw2.floorColor);
      if (floor) patch.floorColor = floor;
      if (!Object.keys(patch).length) return err("nothing to change");
      return { action: { type: "setRoom", patch } };
    }
    case "search": {
      const query = text(raw.query, 500);
      if (query.length < 2) return err("query is empty");
      const action: Extract<ChatAction, { type: "search" }> = { type: "search", query };
      const mount = pickLower(raw.mount, MOUNTS);
      if (mount) action.mount = mount;
      const price = finite(raw.maxPrice);
      if (price !== null && price > 0) action.maxPrice = Math.min(price, 1_000_000);
      const style = text(raw.style, 120);
      if (style) action.style = style;
      const forId = ctx.resolve(raw.forItemId);
      if (forId) action.forItemId = forId;
      return { action };
    }
    case "addCandidate": {
      const r = resultAt(raw.index, results);
      if (!r) return err(results.length ? `no result #${text(String(raw.index), 10)}` : "there are no search results yet");
      const action: Extract<ChatAction, { type: "addCandidate" }> = { type: "addCandidate", index: r.index };
      const replace = ctx.resolve(raw.replaceItemId);
      if (replace) action.replaceItemId = replace;
      let note: string | undefined;
      if (raw.placement !== undefined && raw.placement !== null) {
        const p = cleanPlacement(raw.placement, ctx, replace, r.mount, r.dims);
        if ("placement" in p) action.placement = p.placement;
        else note = `addCandidate: placement dropped (${p.error})`;
      }
      if (replace) ctx.removed.add(replace);
      return { action, note };
    }
    case "previewCandidate": {
      const r = resultAt(raw.index, results);
      if (!r) return err(results.length ? `no result #${text(String(raw.index), 10)}` : "there are no search results yet");
      return { action: { type: "previewCandidate", index: r.index } };
    }
    case "select": {
      const id = item();
      if (!id) return unknownItem();
      return { action: { type: "select", itemId: id } };
    }
    case "camera": {
      const preset = pickLower(raw.preset, CAMERAS);
      if (!preset) return err(`unknown view "${text(raw.preset, 20)}"`);
      return { action: { type: "camera", preset } };
    }
    case "undo": {
      const n = finite(raw.steps);
      const steps = n === null ? 1 : Math.round(clamp(n, 1, 20));
      return { action: { type: "undo", steps } };
    }
    case "setHidden": {
      const id = item();
      if (!id) return unknownItem();
      if (typeof raw.hidden !== "boolean") return err("hidden must be true or false");
      ctx.get(id)!.hidden = raw.hidden;
      return { action: { type: "setHidden", itemId: id, hidden: raw.hidden } };
    }
    case "setMount": {
      const id = item();
      if (!id) return unknownItem();
      const mount = pickLower(raw.mount, MOUNTS);
      if (!mount) return err(`unknown mount "${text(raw.mount, 20)}"`);
      const known = ctx.get(id)!;
      known.mount = mount;
      known.supportId = undefined;
      return { action: { type: "setMount", itemId: id, mount } };
    }
    case "setHeight": {
      const id = item();
      if (!id) return unknownItem();
      const bottom = finite(raw.bottom);
      if (bottom === null || bottom < 0) return err("height is missing");
      return { action: { type: "setHeight", itemId: id, bottom: r4(clamp(bottom, 0, ctx.scene.room.height)) } };
    }
    case "setOpening": {
      const op = pickLower(raw.op, OPENING_OPS);
      if (!op) return err(`unknown change "${text(raw.op, 20)}"`);
      const action: Extract<ChatAction, { type: "setOpening" }> = { type: "setOpening", op };
      if (op !== "add") {
        const id = typeof raw.openingId === "string" ? raw.openingId.trim() : "";
        if (!ctx.scene.room.openings.some((o) => o.id === id)) return err(`unknown door or window "${text(raw.openingId, 40)}"`);
        action.openingId = id;
      }
      if (op === "remove") return { action };
      const kind = pickLower(raw.kind, OPENING_KINDS);
      if (kind) action.kind = kind;
      const wall = pickLower(raw.wall, WALLS);
      if (wall) action.wall = wall;
      // Sentinels: offset / sill < 0 and width / height <= 0 keep the value (or use a default when adding).
      const offset = finite(raw.offset);
      if (offset !== null && offset >= 0) action.offset = r4(Math.min(offset, LIMITS.roomSizeMax));
      const sill = finite(raw.sill);
      if (sill !== null && sill >= 0) action.sill = r4(Math.min(sill, LIMITS.roomHeightMax));
      for (const k of ["width", "height"] as const) {
        const v = finite(raw[k]);
        if (v !== null && v > 0) action[k] = r4(clamp(v, 0.2, LIMITS.roomSizeMax));
      }
      return { action };
    }
    case "hang": {
      const id = item();
      if (!id) return unknownItem();
      const known = ctx.get(id)!;
      known.mount = "ceiling";
      known.supportId = undefined;
      // drop: ceiling → the item's bottom. -1 / 0 / missing = keep a hanging item's drop (or the app's default).
      const drop = finite(raw.drop);
      const roomH = ctx.scene.room.height;
      if (drop === null || drop <= 0) return { action: { type: "hang", itemId: id } };
      return { action: { type: "hang", itemId: id, drop: r4(clamp(drop, LIMITS.itemMin, Math.max(LIMITS.itemMin, roomH - 0.3))) } };
    }
    case "saveVersion": {
      const name = text(raw.name, 80);
      return { action: name ? { type: "saveVersion", name } : { type: "saveVersion" } };
    }
    case "restoreVersion": {
      const versions = ctx.scene.versions ?? [];
      if (!versions.length) return err("there are no saved versions yet");
      // A version id from the scene; a model that wrote the version's name instead still gets it (newest first).
      const key = text(raw.versionId, 120);
      const v = versions.find((x) => x.id === key) ?? versions.find((x) => key && x.name.trim().toLowerCase() === key.toLowerCase());
      if (!v) return err(`unknown version "${text(raw.versionId, 40)}"`);
      return { action: { type: "restoreVersion", versionId: v.id } };
    }
    case "setLighting": {
      const mode = lightingModeFrom(raw.mode);
      return mode ? { action: { type: "setLighting", mode } } : err(`unknown lighting "${text(raw.mode, 20)}"`);
    }
    case "setLight": {
      const id = item();
      if (!id) return unknownItem();
      const action: Extract<ChatAction, { type: "setLight" }> = { type: "setLight", itemId: id };
      const on = raw.on === true || raw.on === false ? raw.on : pickLower(raw.on, ["on", "off"] as const);
      if (on === true || on === "on") action.on = true;
      if (on === false || on === "off") action.on = false;
      const level = finite(raw.intensity);
      // 0..1; a percentage (70) is read as 0.7; negative = keep.
      if (level !== null && level >= 0) action.intensity = r4(clamp(level > 1 ? level / 100 : level, 0, 1));
      const color = lightColorFrom(raw.color);
      if (color) action.color = color;
      if (action.on === undefined && action.intensity === undefined && !action.color) return err("nothing to change on the light");
      return { action };
    }
    case "setWindow": {
      const covering = coveringFrom(raw.covering);
      if (!covering) return err(`unknown blinds setting "${text(raw.covering, 20)}"`);
      const key = typeof raw.openingId === "string" ? raw.openingId.trim() : "";
      const windows = ctx.scene.room.openings.filter((o) => o.kind === "window");
      if (!windows.length) return err("the room has no windows");
      if (key === "*" || key.toLowerCase() === "all") return { action: { type: "setWindow", openingId: "*", covering } };
      const o = ctx.scene.room.openings.find((x) => x.id === key);
      if (!o) return err(`unknown window "${text(raw.openingId, 40)}"`);
      if (o.kind !== "window") return err("that is a door, not a window");
      return { action: { type: "setWindow", openingId: o.id, covering } };
    }
  }
}

const LIGHTING_WORDS: Record<string, LightingMode> = {
  day: "day",
  daytime: "day",
  daylight: "day",
  morning: "day",
  noon: "day",
  afternoon: "day",
  evening: "evening",
  dusk: "evening",
  sunset: "evening",
  "golden hour": "evening",
  night: "night",
  nighttime: "night",
  midnight: "night",
  dark: "night",
};

function lightingModeFrom(v: unknown): LightingMode | null {
  return typeof v === "string" ? (LIGHTING_WORDS[v.trim().toLowerCase().replace(/[-_]/g, " ")] ?? null) : null;
}

function coveringFrom(v: unknown): "open" | "closed" | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (/^(?:open|opened|up|raised?)$/.test(s)) return "open";
  if (/^(?:closed?|shut|down|lowered?|drawn)$/.test(s)) return "closed";
  return null;
}

/** Light colors by word ("warm", "cool white", "daylight"), or any hex / plain color word. */
export const LIGHT_COLOR_WORDS: Record<string, string> = {
  warm: "#ffd8a8",
  "warm white": "#ffd8a8",
  "soft white": "#ffd8a8",
  "very warm": "#ffb062",
  candle: "#ffb062",
  amber: "#ffb062",
  neutral: "#fff4e6",
  "neutral white": "#fff4e6",
  white: "#fff4e6",
  cool: "#c8dcff",
  "cool white": "#c8dcff",
  daylight: "#c8dcff",
};

function lightColorFrom(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  return LIGHT_COLOR_WORDS[v.trim().toLowerCase().replace(/[-_]/g, " ")] ?? colorFrom(v);
}

export interface SanitizedActions {
  actions: ChatAction[];
  /** Why actions (or parts of them) were left out, for the log. */
  dropped: string[];
  /** Actions that were left out because they couldn't be applied, with the reason (shown as muted chips). */
  skipped: Array<{ type: string; reason: string }>;
  /** Placements that were dropped (the item is still added, at a spot the app picks). */
  placementsDropped: number;
}

/** Scene items the answer moves somewhere other than onto another item (their stacks travel with them), and where. */
function movedItems(list: unknown[], scene: ChatScene): Map<string, ChatPlacement> {
  const ctx = new Ctx(scene);
  const out = new Map<string, ChatPlacement>();
  for (const a of list) {
    if (!isObj(a) || typeof a.type !== "string" || a.type.trim().toLowerCase() !== "move") continue;
    const id = ctx.resolve(a.itemId);
    if (!id || !ctx.items.has(id)) continue;
    const p = cleanPlacement(a.placement, ctx, id, ctx.items.get(id)!.mount);
    if ("placement" in p && p.placement.kind !== "onTop" && p.placement.kind !== "under" && p.placement.kind !== "floor") out.set(id, p.placement);
  }
  return out;
}

/**
 * Whether a stacked item's move sends it where its support goes anyway (same wall / corner / neighbour, or a point on
 * the support's new spot), so the support carrying it does the job.
 */
function samePlace(a: ChatPlacement, b: ChatPlacement, supportDims?: Dims): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "center":
      return true;
    case "corner":
      return a.corner === (b as typeof a).corner;
    case "wall": {
      const o = b as typeof a;
      if (a.wall !== o.wall) return false;
      return a.along === undefined || o.along === undefined || Math.abs(a.along - o.along) < 0.15;
    }
    case "nextTo": {
      const o = b as typeof a;
      return a.targetId === o.targetId && (!a.side || !o.side || a.side === o.side);
    }
    case "at": {
      const o = b as typeof a;
      const reach = supportDims ? Math.max(supportDims.w, supportDims.d) / 2 + 0.05 : 0.3;
      return Math.hypot(a.x - o.x, a.z - o.z) <= reach;
    }
    default:
      return false;
  }
}

/** Clean an untrusted action list against the scene (at most CHAT_LIMITS.actions survive). */
export function sanitizeChatActions(raw: unknown, scene: ChatScene): SanitizedActions {
  const list = Array.isArray(raw) ? raw : [];
  const ctx = new Ctx(scene, list);
  const actions: ChatAction[] = [];
  const dropped: string[] = [];
  const skipped: SanitizedActions["skipped"] = [];
  let placementsDropped = 0;
  const together = movedItems(list, scene);
  for (const a of list) {
    if (actions.length >= CHAT_LIMITS.actions) {
      dropped.push(`more than ${CHAT_LIMITS.actions} actions`);
      skipped.push({ type: "action", reason: `more than ${CHAT_LIMITS.actions} changes at once` });
      break;
    }
    const res = cleanAction(a, ctx, together);
    if ("error" in res) {
      dropped.push(res.error);
      if (!res.silent) skipped.push({ type: res.type, reason: res.reason });
      continue;
    }
    actions.push(res.action);
    if (res.note) {
      dropped.push(res.note);
      placementsDropped++;
    }
  }
  return { actions, dropped, skipped, placementsDropped };
}

export interface SanitizedChat extends SanitizedActions {
  reply: string;
}

/**
 * The whole answer: `{ reply, actions }` from the model or the mock parser. A missing reply gets a neutral one.
 * The reply never claims something that won't happen: when nothing survives it says why instead, when steps had to
 * be skipped it says so, and when a placement was dropped it says the app picked the spot.
 */
export function sanitizeChatOutput(raw: unknown, scene: ChatScene): SanitizedChat {
  const obj = isObj(raw) ? raw : {};
  const out = sanitizeChatActions(obj.actions, scene);
  const { actions, skipped, placementsDropped } = out;
  let reply = typeof obj.reply === "string" ? obj.reply.trim().slice(0, 1200) : "";
  if (!actions.length && skipped.length) {
    // Every step failed: the model's reply ("Moved the desk onto the monitor.") would be false.
    reply = `I couldn't do that: ${skipped[0].reason}.`;
  } else {
    if (!reply) reply = actions.length ? "Done." : "Sorry, I couldn't work out what to change. Could you rephrase that?";
    if (skipped.length) reply += ` (I skipped ${skipped.length} step${skipped.length === 1 ? "" : "s"} I couldn't apply.)`;
    if (placementsDropped)
      reply += ` (I couldn't place ${placementsDropped === 1 ? "1 item" : `${placementsDropped} items`} where asked, so the app picked a spot.)`;
  }
  return { ...out, reply };
}

/**
 * The ChatResponse for a raw `{ reply, actions }` answer. Everything left out goes to `log`; steps that couldn't be
 * applied also go to the client as `skipped` (short reasons, shown as muted chips).
 */
export function chatResponseFrom(raw: unknown, scene: ChatScene, mock: boolean, log?: (line: string) => void): ChatResponse {
  const out = sanitizeChatOutput(raw, scene);
  if (out.dropped.length && log) log(`[chat] skipped: ${out.dropped.join("; ").slice(0, 600)}`);
  const res: ChatResponse = { reply: out.reply, actions: out.actions, mock };
  if (out.skipped.length) res.skipped = out.skipped.slice(0, CHAT_LIMITS.actions);
  return res;
}
