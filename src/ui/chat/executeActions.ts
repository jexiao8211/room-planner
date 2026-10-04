// Applies the actions a chat reply asks for to the planner store. Pure-ish: it only touches the store API it is
// given (plus an optional camera callback), so it can be unit-tested with the real store and no DOM.
//
// A turn's plan changes become ONE undo step: the actions run through the normal store actions (so stacking,
// wall attachment and room constraints all apply), then the undo history is collapsed to the state before the
// turn. "undo" actions run first and are never collapsed.
import type { ChatAction, ChatPlacement, Dims, Mount, Opening, PlacedItem, ProductCandidate, Room, ShapeKind, ShapePart, Units, WallSide } from "../../shared/types";
import type { NewItemInput, PlannerState } from "../../state/store";
import type { VersionsApi } from "../../state/versions";
import {
  cornerInset,
  coversOpening,
  distanceToWall,
  fitsOnTop,
  footprintHalfExtents,
  footprintsOverlap,
  fitsSurfaceAt,
  pickLevel,
  seatHeight,
  type SurfaceLevel,
  supportSurfaces,
  supportToWorld,
  surfacesFor,
  type SupportSurface,
  nearestWall,
  pointInFootprint,
  rotationFacingAwayFrom,
  wallForItem,
  wallFromRotation,
  wallMountPlacement,
  type Corner,
} from "../../lib/geometry";
import { clampOntoSupport } from "../../scene/dragMath";
import { SHAPE_PRESETS, fullPart, newId } from "../../lib/presets";
import { formatDims, formatLength } from "../../lib/units";
import { runLightingAction } from "./lightingActions";

/** The bits of the zustand store API this module needs (usePlanner satisfies it). */
export interface PlannerApi {
  getState: () => PlannerState;
  setState: (partial: Partial<PlannerState>) => void;
}

export type CameraPresetName = "iso" | "top" | "eye";

export interface ExecContext {
  planner: PlannerApi;
  /** The last product search's results (what addCandidate / previewCandidate index into). */
  lastResults?: ProductCandidate[];
  /** Move the camera (the scene's setCameraPreset). */
  camera?: (preset: CameraPresetName) => void;
  /** Design versions (saveVersion / restoreVersion, and the auto snapshot before a turn with >= 3 changes). */
  versions?: VersionsApi;
}

/**
 * One chip under an assistant message, in one of three states (never "ok" with an error):
 *  - ok: done as asked;
 *  - adjusted: done, but differently than asked (`note` says how / why: "shifted to avoid the bed");
 *  - failed: not done (`error` says why). `ok` is true for ok and adjusted.
 */
export interface ActionResult {
  type: ChatAction["type"];
  ok: boolean;
  /** (Additive) see above; derive it with chipStatus for results saved before it existed. */
  status?: ChipStatus;
  label: string;
  /** Why a failed action wasn't done. */
  error?: string;
  /** (Additive) How an adjusted action differs from what was asked. */
  note?: string;
  /** Hex color to show as a dot on the chip (recolor / added shapes). */
  swatch?: string;
}

export type ChipStatus = "ok" | "adjusted" | "failed";

/** A chip's state, also for results saved before `status` existed (then "ok" + error meant adjusted). */
export function chipStatus(r: Pick<ActionResult, "ok" | "status" | "error" | "note">): ChipStatus {
  if (r.status === "ok" || r.status === "adjusted" || r.status === "failed") return r.status;
  if (!r.ok) return "failed";
  return r.error || r.note ? "adjusted" : "ok";
}

/** A result in its final shape: a status, the reason of an adjusted one in `note`, and `error` only when failed. */
export function finalizeResult(r: ActionResult, notes: string[] = []): ActionResult {
  const reasons = [r.note, r.ok ? r.error : undefined, ...notes].filter((x): x is string => !!x && !!x.trim());
  if (!r.ok) {
    const out: ActionResult = { ...r, status: "failed", error: r.error || "couldn't do that" };
    delete out.note;
    return out;
  }
  const out: ActionResult = { ...r, status: reasons.length ? "adjusted" : "ok" };
  delete out.error;
  if (reasons.length) out.note = [...new Set(reasons)].join("; ");
  else delete out.note;
  return out;
}

export type SearchAction = Extract<ChatAction, { type: "search" }>;

/** Plan state (room + items references) before and after a turn's changes, for "Undo this". */
export interface TurnStep {
  before: { room: Room; items: PlacedItem[] };
  after: { room: Room; items: PlacedItem[] };
}

export interface ExecOutcome {
  results: ActionResult[];
  /** null when the turn didn't change the plan (only selected, previewed, moved the camera, searched, undid...). */
  step: TurnStep | null;
  /** Product searches to start (slow; the caller runs them and reports back in the chat). forItemId is resolved. */
  searches: SearchAction[];
}

export const MAX_ACTIONS = 25;
/** Action types that don't change the design (everything else counts toward the ">= 3 changes" auto snapshot). */
// Lighting mode, lamps and blinds are how the room is viewed (see versions.ts designRoom): "movie night" (blinds,
// night, two lamps dimmed) is not a big design edit worth an auto version.
const NOT_A_CHANGE = new Set<string>(["search", "previewCandidate", "select", "camera", "undo", "saveVersion", "restoreVersion", "setLighting", "setLight", "setWindow"]);
const HISTORY_LIMIT = 100;
const MIN_DIM = 0.02;
/** Floor items lower than this (m) are floor coverings (rugs, mats): not obstacles for anything else. */
const FLAT_COVERING = 0.05;
const MAX_DIM = 5;
const SHAPE_KINDS: ShapeKind[] = ["box", "cylinder", "sphere", "cone"];
const WALL_LABEL: Record<WallSide, string> = { north: "north wall", south: "south wall", east: "east wall", west: "west wall" };
const CORNER_LABEL: Record<Corner, string> = { nw: "north-west corner", ne: "north-east corner", sw: "south-west corner", se: "south-east corner" };
const CAMERA_LABEL: Record<CameraPresetName, string> = { iso: "Corner view", top: "Top view", eye: "Eye-level view" };
const MOUNT_LABEL: Record<Mount, string> = { floor: "stands on the floor", wall: "hangs on the wall", ceiling: "hangs from the ceiling" };
/** Things that go to the back edge of a desk that stands against a wall. */
const BACK_EDGE_ITEMS = /\b(?:monitors?|screens?|displays?|tvs?|televisions?|imacs?)\b/i;
/** Seating that faces diagonally out of a corner. */
const SEATING = /\b(?:arm\s*chairs?|chairs?|recliners?|loungers?|rockers?|seats?)\b/i;

class ActionError extends Error {}
/** A surface with no free spot left for the item (it is left off it). */
class NoRoomError extends ActionError {
  constructor(
    message: string,
    readonly supportId: string,
  ) {
    super(message);
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** "#abc" / "#aabbcc" (any case) → "#aabbcc"; anything else → null. */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return null;
}

function cleanDims(d: Partial<Dims> | undefined, base: Dims): Dims {
  const pick = (v: unknown, fallback: number) => (finite(v) && v > 0 ? clamp(v, MIN_DIM, MAX_DIM) : fallback);
  return { w: pick(d?.w, base.w), h: pick(d?.h, base.h), d: pick(d?.d, base.d) };
}

function cleanParts(parts: unknown): ShapePart[] | null {
  if (!Array.isArray(parts) || !parts.length) return null;
  const out: ShapePart[] = [];
  for (const p of parts.slice(0, 24) as Partial<ShapePart>[]) {
    if (!p || !SHAPE_KINDS.includes(p.kind as ShapeKind) || !p.center || !p.size) continue;
    const c = p.center;
    const s = p.size;
    if (![c.x, c.y, c.z, s.x, s.y, s.z].every(finite)) continue;
    const part: ShapePart = {
      kind: p.kind as ShapeKind,
      center: { x: clamp(c.x, -0.5, 0.5), y: clamp(c.y, 0, 1), z: clamp(c.z, -0.5, 0.5) },
      size: { x: clamp(s.x, 0.001, 1), y: clamp(s.y, 0.001, 1), z: clamp(s.z, 0.001, 1) },
    };
    const color = normalizeHex(p.color);
    if (color) part.color = color;
    out.push(part);
  }
  return out.length ? out : null;
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Run the actions of one chat reply. Never throws: each action reports its own success or failure. */
export function executeActions(actions: ChatAction[], ctx: ExecContext): ExecOutcome {
  const { planner } = ctx;
  const S = () => planner.getState();
  const refs = new Map<string, string>();
  const searches: SearchAction[] = [];
  const list = (Array.isArray(actions) ? actions : []).slice(0, MAX_ACTIONS);
  const results: (ActionResult | undefined)[] = new Array(list.length);
  /** The last item this turn added / changed: selected at the end. */
  let touched: string | null = null;

  const units = (): Units => S().units;
  const len = (m: number) => formatLength(m, units());

  // ---------- lookups ----------

  const item = (id: string): PlacedItem | undefined => S().items.find((it) => it.id === id);

  /** An existing id, a ref from earlier in this reply, or (as a fallback) an exact item name, most recent first. */
  const resolve = (key: unknown): string | null => {
    if (typeof key !== "string" || !key) return null;
    const ref = refs.get(key);
    if (ref && item(ref)) return ref;
    if (item(key)) return key;
    const lower = key.trim().toLowerCase();
    const byName = [...S().items].reverse().find((it) => it.name.trim().toLowerCase() === lower);
    return byName?.id ?? null;
  };

  const need = (key: unknown): PlacedItem => {
    const id = resolve(key);
    const it = id ? item(id) : undefined;
    if (!it) throw new ActionError(`couldn't find "${String(key ?? "")}"`);
    return it;
  };

  const unlocked = (it: PlacedItem): PlacedItem => {
    if (it.locked) throw new ActionError(`${it.name} is locked`);
    return it;
  };

  /** True if `id` rests (directly or through others) on `supportId`. */
  const restsOn = (id: string, supportId: string): boolean => {
    const seen = new Set<string>();
    let cur = item(id);
    while (cur?.supportId && !seen.has(cur.id)) {
      if (cur.supportId === supportId) return true;
      seen.add(cur.id);
      cur = item(cur.supportId);
    }
    return false;
  };

  /**
   * Items that later actions of this turn put on / under each item (support id -> item ids): moving the desk first
   * must not trip over the monitor that is about to go on it. Set before each action (see the main loop).
   */
  let incoming = new Map<string, Set<string>>();

  /**
   * Items that move with `id` (it, everything stacked on or under it, and what this turn is about to put on it),
   * excluded from its collision checks.
   */
  const stackOf = (id: string) =>
    new Set([id, ...S().items.filter((it) => restsOn(it.id, id)).map((it) => it.id), ...(incoming.get(id) ?? [])]);

  // ---------- placement ----------

  /** Caveats of the action being run ("shifted to avoid the bed"); shown on its chip. */
  let notes: string[] = [];
  const note = (msg: string) => {
    if (!notes.includes(msg)) notes.push(msg);
  };

  /** Words for where `p` puts things; `self` (the item placed) words a hanging item's spot as "above X". */
  const describe = (p: ChatPlacement, self?: PlacedItem): string => {
    if (self?.mount === "ceiling" && p && typeof p === "object") {
      if (p.kind === "onTop" && (!p.level || p.level === "top")) return `above ${item(resolve(p.targetId) ?? "")?.name ?? p.targetId}`;
      if (p.kind === "at" && finite(p.x) && finite(p.z)) {
        // The server turns "hang the pendant over the desk" into the desk's spot: say "above Desk", not coordinates.
        const below = S().items.find((o) => o.id !== self.id && !o.hidden && o.mount !== "ceiling" && Math.hypot(o.position.x - p.x, o.position.z - p.z) < 0.01);
        if (below) return `above ${below.name}`;
      }
    }
    switch (p.kind) {
      case "center":
        return "center of the room";
      case "corner":
        return CORNER_LABEL[p.corner] ?? "corner";
      case "wall":
        return WALL_LABEL[p.wall] ?? "wall";
      case "onTop": {
        const name = item(resolve(p.targetId) ?? "")?.name ?? p.targetId;
        return p.level && p.level !== "top" ? `on the ${p.level} level of ${name}` : `on ${name}`;
      }
      case "under":
        return `under ${item(resolve(p.targetId) ?? "")?.name ?? p.targetId}`;
      case "nextTo": {
        const name = item(resolve(p.targetId) ?? "")?.name ?? p.targetId;
        if (p.side === "front") return `in front of ${name}`;
        if (p.side === "behind") return `behind ${name}`;
        if (p.side === "left") return `left of ${name}`;
        if (p.side === "right") return `right of ${name}`;
        return `next to ${name}`;
      }
      case "at":
        return `x ${len(Math.abs(p.x))}${p.x < 0 ? " W" : " E"}, z ${len(Math.abs(p.z))}${p.z < 0 ? " N" : " S"} of center`;
      case "floor":
        return "on the floor";
      default:
        return "somewhere";
    }
  };

  /** Take a stacked item off its support (back to the floor) before a floor placement. */
  const unstack = (id: string) => {
    if (item(id)?.supportId) S().placeOnTop(id, null);
  };

  /** Move an item and check that a stacked item stayed on its support; if not, fall back to its center. */
  const moveOnSupport = (id: string, supportId: string, x: number, z: number) => {
    const support = item(supportId);
    if (!support) return;
    // On the same surface of it (a cat tower's middle platform, the floor under a desk).
    const surfaceY = item(id)?.supportId === supportId ? item(id)?.supportSurfaceY : undefined;
    const top = seatHeight({ supportSurfaceY: surfaceY }, support);
    S().updateItem(id, { position: { x, y: top, z } });
    const after = item(id);
    if (!after || after.supportId !== supportId || Math.abs(after.position.y - top) > 1e-3) S().placeOnTop(id, supportId, surfaceY);
  };

  /** Whether `it` fits at local point `l` of a support's surface (clear of its legs / posts / shelves). */
  const surfaceSpotFits = (it: PlacedItem, support: PlacedItem, sf: SupportSurface, l: { x: number; z: number }) =>
    fitsSurfaceAt(it, support, sf, l, it.rotationY);

  /** The first visible item (outside `ignore`) the footprint of `it` at (x, y, z) with rotation r collides with. */
  const blockerAt = (it: PlacedItem, x: number, y: number, z: number, r: number, ignore: Set<string>): PlacedItem | undefined => {
    const probe: PlacedItem = { ...it, position: { x, y, z }, rotationY: r };
    // A rug (a flat floor covering) is the floor for everything else: a lamp may stand on it.
    const flat = (o: PlacedItem) => o.mount === "floor" && !o.supportId && o.dims.h < FLAT_COVERING;
    return S().items.find((o) => !o.hidden && !ignore.has(o.id) && !(flat(o) && !flat(probe)) && footprintsOverlap(probe, o));
  };
  const blockedAt = (it: PlacedItem, x: number, y: number, z: number, r: number, ignore: Set<string>) => !!blockerAt(it, x, y, z, r, ignore);

  /** Name of what an item (where it is now) collides with, ignoring its own stack and what it rests on. */
  const overlapping = (id: string): string | null => {
    const it = item(id);
    if (!it || it.hidden) return null;
    const ignore = stackOf(id);
    for (let cur = it; cur.supportId; ) {
      const up = item(cur.supportId);
      if (!up || ignore.has(up.id)) break;
      ignore.add(up.id);
      cur = up;
    }
    return blockerAt(it, it.position.x, it.position.y, it.position.z, it.rotationY, ignore)?.name ?? null;
  };
  /** Add an "overlaps X" caveat when the item ended up inside something. */
  const warnOverlap = (id: string, what = "no free spot") => {
    const other = overlapping(id);
    if (other) note(`${what}: overlaps ${other}`);
  };

  /** Inside the room without clamping? */
  const fitsRoom = (it: PlacedItem, x: number, z: number, r: number) => {
    const { room } = S();
    const { hx, hz } = footprintHalfExtents(it.dims, r);
    return Math.abs(x) + hx <= room.width / 2 + 1e-6 && Math.abs(z) + hz <= room.depth / 2 + 1e-6;
  };

  /** 0, +step, -step, +2·step, ... up to ±half (rounded to millimeters). */
  const outward = (half: number, step = 0.05) => {
    const out = [0];
    for (let k = step; k <= half + 1e-9; k += step) out.push(Math.round(k * 1000) / 1000, -Math.round(k * 1000) / 1000);
    return out;
  };

  /** Back of a floor item flush against a wall (within 5 cm)? */
  const backAgainstWall = (it: PlacedItem): boolean => {
    const wall = wallFromRotation(it.rotationY);
    return !!wall && distanceToWall(it.position, wall, S().room) - it.dims.d / 2 < 0.05;
  };

  /**
   * Rest `id` on `supportId`: on its top, on another level of it (`level`: a cat tower's middle platform), or on the
   * floor under it (`under`: between a desk's legs, when it fits under). Screens go to the back edge when the support
   * stands against a wall; when something already sits there it is spread out sideways, and when there is no free
   * spot on a top the items on it are re-packed along its width. Caveats go to `note`.
   */
  const stackOn = (id: string, supportId: string, want: { level?: SurfaceLevel; under?: boolean } = {}) => {
    const support = item(supportId);
    const self = item(id);
    if (!support || !self) throw new ActionError("couldn't find that surface");
    if (id === supportId) throw new ActionError(want.under ? "can't put something under itself" : "can't put something on itself");
    if (restsOn(supportId, id)) throw new ActionError(`${support.name} is resting on it`);
    if (support.hidden) throw new ActionError(`${support.name} is hidden`);
    if (support.mount !== "floor") throw new ActionError(`${support.name} isn't standing on the floor`);
    const surfaces = surfacesFor(self, support, support.rotationY);
    let surface: SupportSurface;
    if (want.under) {
      const under = surfaces.find((sf) => sf.kind === "under");
      if (!under) {
        const room = supportSurfaces(support).some((sf) => sf.kind === "under");
        throw new ActionError(room ? `${self.name} doesn't fit under ${support.name}` : `there's no room under ${support.name}`);
      }
      surface = under;
    } else {
      const picked = pickLevel(supportSurfaces(support), surfaces, want.level);
      if (!picked) {
        if (!fitsOnTop(self, support, support.rotationY)) throw new ActionError(`${self.name} is too big to go on ${support.name}`);
        throw new ActionError(`there's no room for ${self.name} on ${support.name}`);
      }
      surface = picked.surface;
      if (want.level && want.level !== "top" && !picked.exact) {
        note(`${support.name} has no ${want.level} level that fits ${self.name}, so it's at ${len(surface.y)}`);
      }
    }
    const open = surface.kind === "top" && Math.abs(surface.y - support.dims.h) < 0.01;
    // To put things back as they were when there turns out to be no room on the support.
    const undoTo = { items: S().items, past: S().past, future: S().future };
    // placeOnTop turns it to match the support and makes it a floor item.
    S().placeOnTop(id, supportId, surface.y);
    const placed = item(id);
    if (!placed || placed.supportId !== supportId) throw new ActionError(`couldn't put it ${want.under ? "under" : "on"} ${support.name}`);
    if (!open) {
      // A lower level / under it: the free spot nearest the middle, clear of its posts and of what is already there.
      const ignore = new Set([...stackOf(id), supportId]);
      const cx = (surface.x0 + surface.x1) / 2;
      const cz = (surface.z0 + surface.z1) / 2;
      const { hx, hz } = footprintHalfExtents(placed.dims, placed.rotationY - support.rotationY);
      const mx = Math.max(0, (surface.x1 - surface.x0) / 2 - hx);
      const mz = Math.max(0, (surface.z1 - surface.z0) / 2 - hz);
      const spots = outward(mx, 0.025)
        .flatMap((dx) => outward(mz, 0.025).map((dz) => ({ x: cx + dx, z: cz + dz })))
        .sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz));
      for (const l of spots) {
        const p = supportToWorld(support, l);
        if (!surfaceSpotFits(placed, support, surface, l)) continue;
        if (blockedAt(placed, p.x, placed.position.y, p.z, placed.rotationY, ignore)) continue;
        moveOnSupport(id, supportId, p.x, p.z);
        return;
      }
      planner.setState(undoTo);
      throw new NoRoomError(`no room left ${want.under ? "under" : "on"} ${support.name}`, supportId);
    }

    const θ = support.rotationY;
    const toWorld = (lx: number, lz: number) => ({
      x: support.position.x + lx * Math.cos(θ) + lz * Math.sin(θ),
      z: support.position.z - lx * Math.sin(θ) + lz * Math.cos(θ),
    });
    const toLocal = (p: { x: number; z: number }) => {
      const dx = p.x - support.position.x;
      const dz = p.z - support.position.z;
      return { lx: dx * Math.cos(θ) - dz * Math.sin(θ), lz: dx * Math.sin(θ) + dz * Math.cos(θ) };
    };
    const maxX = Math.max(0, support.dims.w / 2 - placed.dims.w / 2);
    const maxZ = Math.max(0, support.dims.d / 2 - placed.dims.d / 2);
    // Screens sit near the back of a desk that stands against a wall, not in the middle of it.
    const lz0 = BACK_EDGE_ITEMS.test(placed.name) && backAgainstWall(support) ? -Math.max(0, maxZ - 0.02) : 0;
    const zs = [...new Set([lz0, ...outward(maxZ)])].sort((a, b) => Math.abs(a - lz0) - Math.abs(b - lz0));
    const ignore = stackOf(id);
    for (const lz of zs) {
      for (const lx of outward(maxX)) {
        const p = toWorld(lx, lz);
        if (!blockedAt(placed, p.x, placed.position.y, p.z, placed.rotationY, ignore)) {
          if (Math.abs(lx) > 1e-9 || Math.abs(lz) > 1e-9) moveOnSupport(id, supportId, p.x, p.z);
          return;
        }
      }
    }

    // No free spot for it alone: re-pack everything on the support along its width (in its current left-to-right
    // order, the new item last), each keeping its depth position.
    const siblings = S()
      .items.filter((o) => o.id !== id && !o.hidden && o.supportId === supportId)
      .map((o) => ({ o, ...toLocal(o.position) }))
      .sort((a, b) => a.lx - b.lx);
    const width = (o: PlacedItem) => 2 * footprintHalfExtents(o.dims, o.rotationY - θ).hx;
    const depth = (o: PlacedItem) => 2 * footprintHalfExtents(o.dims, o.rotationY - θ).hz;
    const row = [...siblings, { o: placed, lx: 0, lz: lz0 }];
    const GAP = 0.03;
    const total = row.reduce((sum, r) => sum + width(r.o), 0) + GAP * (row.length - 1);
    const locked = siblings.find((r) => r.o.locked);
    if (total > support.dims.w + 1e-6 || locked) {
      // Leaving it inside the other things would be worse than not putting it there: the item stays where it was.
      planner.setState(undoTo);
      const why = locked ? `${locked.o.name} is locked` : `${siblings.map((r) => r.o.name).join(", ") || "other things"} fill${siblings.length === 1 ? "s" : ""} it`;
      throw new NoRoomError(`no room left on ${support.name} (${why})`, supportId);
    }
    let x = -total / 2;
    for (const r of row) {
      const w = width(r.o);
      const mz = Math.max(0, support.dims.d / 2 - depth(r.o) / 2);
      const p = toWorld(x + w / 2, Math.max(-mz, Math.min(mz, r.lz)));
      moveOnSupport(r.o.id, supportId, p.x, p.z);
      x += w + GAP;
    }
    if (siblings.length) note(`moved ${siblings.map((r) => r.o.name).join(", ")} aside to make room`);
  };

  /**
   * Against a wall, facing into the room. `along` (0..1 from the wall's min end) is the preferred spot; the free
   * stretch nearest to it (or to the middle of the wall without it) is used: clear of other items, and of doors /
   * windows for wall items.
   */
  const placeAgainstWall = (it: PlacedItem, wall: WallSide, along?: number) => {
    const { room } = S();
    const alongX = wall === "north" || wall === "south";
    const wallLen = alongX ? room.width : room.depth;
    const ignore = stackOf(it.id);
    const cur = item(it.id)!;

    let spotAt: (coord: number) => { position: { x: number; y: number; z: number }; rotationY: number };
    let blocker: (coord: number) => string | null;
    if (it.mount === "wall") {
      spotAt = (coord) => wallMountPlacement(wall, coord, cur.position.y, it.dims, room);
      blocker = (coord) => {
        const sp = spotAt(coord);
        if (coversOpening(wall, coord, sp.position.y, it.dims, room)) return "a door or window";
        return blockerAt(cur, sp.position.x, sp.position.y, sp.position.z, sp.rotationY, ignore)?.name ?? null;
      };
    } else {
      const rotationY = rotationFacingAwayFrom(wall);
      const { hx, hz } = footprintHalfExtents(it.dims, rotationY);
      const inset = cornerInset(it);
      const y = cur.supportId ? 0 : cur.position.y;
      spotAt = (coord) => ({
        rotationY,
        position:
          wall === "north"
            ? { x: coord, y, z: -room.depth / 2 + hz + inset }
            : wall === "south"
              ? { x: coord, y, z: room.depth / 2 - hz - inset }
              : wall === "west"
                ? { x: -room.width / 2 + hx + inset, y, z: coord }
                : { x: room.width / 2 - hx - inset, y, z: coord },
      });
      blocker = (coord) => {
        const sp = spotAt(coord);
        return blockerAt(cur, sp.position.x, sp.position.y, sp.position.z, rotationY, ignore)?.name ?? null;
      };
    }

    const half = Math.max(0, wallLen / 2 - it.dims.w / 2); // back to the wall, its width runs along it
    const want = finite(along) ? clamp(-wallLen / 2 + clamp(along, 0, 1) * wallLen, -half, half) : 0;
    let coord = want;
    const first = blocker(want);
    if (first) {
      const hit = outward(2 * half)
        .map((k) => want + k)
        .find((c) => Math.abs(c) <= half + 1e-6 && !blocker(c));
      if (hit != null) {
        coord = hit;
        if (finite(along)) note(`shifted ${len(Math.abs(hit - want))} along the wall to avoid ${first}`);
      } else note(`no free spot on the ${WALL_LABEL[wall]}: overlaps ${first}`);
    }
    if (it.mount !== "wall") unstack(it.id);
    S().updateItem(it.id, spotAt(coord));
  };

  /**
   * Rotation for a floor item put into a corner: kept when it already looks away from both of the corner's walls
   * (or isn't facing either); otherwise seating faces diagonally into the room and anything else stands with its
   * back to the corner's north / south wall.
   */
  const cornerRotation = (it: PlacedItem, corner: Corner): number => {
    const sx = corner.endsWith("w") ? -1 : 1;
    const sz = corner.startsWith("n") ? -1 : 1;
    const fx = Math.sin(it.rotationY);
    const fz = Math.cos(it.rotationY);
    if (fx * sx <= 0.7 && fz * sz <= 0.7) return it.rotationY; // not facing either wall of the corner
    if (SEATING.test(it.name)) return Math.atan2(-sx, -sz);
    return rotationFacingAwayFrom(sz < 0 ? "north" : "south");
  };

  const placeInCorner = (it: PlacedItem, corner: Corner) => {
    if (!CORNER_LABEL[corner]) throw new ActionError("unknown corner");
    if (it.mount === "wall") {
      // A wall item goes to that end of one of the corner's two walls (the one it is on, if it is).
      const { room } = S();
      const ns: WallSide = corner.startsWith("n") ? "north" : "south";
      const ew: WallSide = corner.endsWith("w") ? "west" : "east";
      const current = wallForItem(it, room);
      const wall = current === ew ? ew : ns;
      const along = wall === ns ? (ew === "west" ? 0 : 1) : ns === "north" ? 0 : 1;
      placeAgainstWall(it, wall, along);
      return;
    }
    unstack(it.id);
    if (it.mount === "floor") {
      const r = cornerRotation(item(it.id)!, corner);
      if (Math.abs(wrapAngle(r - item(it.id)!.rotationY)) > 1e-9) S().updateItem(it.id, { rotationY: r });
    }
    S().snapItemToCornerAt(it.id, corner);
    // Taken? Slide out of the corner along either of its walls to the nearest free spot.
    const placed = item(it.id)!;
    const ignore = stackOf(it.id);
    const { x, y, z } = placed.position;
    const first = blockerAt(placed, x, y, z, placed.rotationY, ignore);
    if (!first) return;
    const { room } = S();
    const dx = corner.endsWith("w") ? 1 : -1;
    const dz = corner.startsWith("n") ? 1 : -1;
    for (let k = 0.05; k <= Math.max(room.width, room.depth) + 1e-9; k += 0.05) {
      const spot = [
        { x: x + dx * k, z },
        { x, z: z + dz * k },
      ].find((q) => fitsRoom(placed, q.x, q.z, placed.rotationY) && !blockedAt(placed, q.x, y, q.z, placed.rotationY, ignore));
      if (spot) {
        S().updateItem(it.id, { position: { x: spot.x, y, z: spot.z } });
        note(`the corner was taken by ${first.name}, so it's ${len(k)} along the wall`);
        return;
      }
    }
    note(`no free spot: overlaps ${first.name}`);
  };

  /**
   * When nothing fits right beside `target` and it stands under / on something (a bin under a desk, a cat on a cat
   * tower's level): a floor spot beside that support instead (the bottom of the stack), the free one nearest the
   * target, its front first. True when `it` was put there (the chip notes it).
   */
  const besideHost = (it: PlacedItem, target: PlacedItem): boolean => {
    // Coming down from the target itself (a lamp off the nightstand it stands on) never jumps to beside something else.
    if (restsOn(it.id, target.id)) return false;
    let host = target.supportId ? item(target.supportId) : undefined;
    for (const seen = new Set<string>([target.id]); host?.supportId && !seen.has(host.id); ) {
      seen.add(host.id);
      const below = item(host.supportId);
      if (!below) break;
      host = below;
    }
    if (!host || host.id === it.id || restsOn(host.id, it.id)) return false;
    const h = host;
    const θ = h.rotationY;
    const toWorld = (lx: number, lz: number) => ({ x: h.position.x + lx * Math.cos(θ) + lz * Math.sin(θ), z: h.position.z - lx * Math.sin(θ) + lz * Math.cos(θ) });
    const ignore = stackOf(it.id);
    const gap = 0.05;
    let best: { q: { x: number; z: number }; r: number; score: number } | null = null;
    for (const side of ["front", "right", "left", "behind"] as const) {
      // As placeNextTo: in front = facing it; elsewhere turned like it. left / right from its own point of view.
      const r = side === "front" ? wrapAngle(θ + Math.PI) : θ;
      const { hx, hz } = footprintHalfExtents(it.dims, r - θ);
      const alongW = side === "front" || side === "behind";
      const fixed =
        side === "front" ? h.dims.d / 2 + gap + hz : side === "behind" ? -(h.dims.d / 2 + gap + hz) : side === "left" ? h.dims.w / 2 + gap + hx : -(h.dims.w / 2 + gap + hx);
      for (const k of outward(alongW ? h.dims.w / 2 + hx : h.dims.d / 2 + hz)) {
        const q = alongW ? toWorld(k, fixed) : toWorld(fixed, k);
        if (!fitsRoom(it, q.x, q.z, r) || blockedAt(it, q.x, 0, q.z, r, ignore)) continue;
        const score = Math.hypot(q.x - target.position.x, q.z - target.position.z) + (side === "front" ? 0 : 0.3);
        if (!best || score < best.score) best = { q, r, score };
      }
    }
    if (!best) return false;
    unstack(it.id);
    S().updateItem(it.id, { position: { x: best.q.x, y: item(it.id)!.position.y, z: best.q.z }, rotationY: best.r });
    note(`no room right beside ${target.name}, so it's beside ${h.name}`);
    return true;
  };

  const placeNextTo = (it: PlacedItem, p: Extract<ChatPlacement, { kind: "nextTo" }>) => {
    const target = need(p.targetId);
    if (target.id === it.id) throw new ActionError("can't put something next to itself");
    if (restsOn(target.id, it.id)) throw new ActionError(`${target.name} is resting on it`);
    type Side = NonNullable<typeof p.side>;
    const θ = target.rotationY;
    const gap = finite(p.gap) ? clamp(p.gap, 0, 3) : 0.05;
    // Beside a bed / desk that stands against a wall: line the backs up (nightstands at the headboard).
    const alignBack = it.mount === "floor" && !target.supportId && backAgainstWall(target);
    const offset = (side: Side) => {
      // left/right from the target's point of view, facing its front (+z): its right is local −x.
      const lz = alignBack ? -(target.dims.d / 2 - it.dims.d / 2) : 0;
      if (side === "right") return { lx: -(target.dims.w / 2 + gap + it.dims.w / 2), lz };
      if (side === "left") return { lx: target.dims.w / 2 + gap + it.dims.w / 2, lz };
      if (side === "front") return { lx: 0, lz: target.dims.d / 2 + gap + it.dims.d / 2 };
      return { lx: 0, lz: -(target.dims.d / 2 + gap + it.dims.d / 2) };
    };
    const at = (side: Side) => {
      const { lx, lz } = offset(side);
      return { x: target.position.x + lx * Math.cos(θ) + lz * Math.sin(θ), z: target.position.z - lx * Math.sin(θ) + lz * Math.cos(θ) };
    };
    // In front of something = facing it (a chair at a desk, a TV across from a sofa); elsewhere it matches the target.
    const facing = (side: Side) => (side === "front" ? wrapAngle(θ + Math.PI) : θ);
    const all: Side[] = ["right", "left", "front", "behind"];
    const sides: Side[] = p.side ? [p.side, ...all.filter((s) => s !== p.side)] : all;
    const ignore = new Set([...stackOf(it.id), target.id]);
    // Next to something on a desk = on the same desk; but next to the thing it stands on itself ("off the nightstand,
    // in front of it") = down from it.
    // Something standing UNDER a desk (supportSurfaceY 0) is on the floor: beside it is the floor, never the desk top.
    const underIt = target.supportSurfaceY !== undefined && target.supportSurfaceY < 0.01;
    const support = target.supportId && !underIt && it.mount === "floor" && target.id !== it.supportId ? item(target.supportId) : undefined;
    const y = support ? target.position.y : it.mount === "floor" ? 0 : it.position.y;
    /** On the target's support (when it has one), so the item doesn't fall off the desk. */
    const onSupport = (q: { x: number; z: number }) => !support || pointInFootprint(q, support);
    const freeAt = (s: Side, q: { x: number; z: number }) => fitsRoom(it, q.x, q.z, facing(s)) && onSupport(q) && !blockedAt(it, q.x, y, q.z, facing(s), ignore);
    let free = sides.find((s) => freeAt(s, at(s)));
    let slid: { x: number; z: number } | null = null;
    if (!free && it.mount !== "wall") {
      // Each side's own spot is taken (a nightstand at the headboard, a wall at the foot): slide along that side, the
      // requested side first (a lamp by the bed goes further along the bed rather than into the nightstand).
      const { room } = S();
      const { hx, hz } = footprintHalfExtents(it.dims, θ);
      const inRoom = (q: { x: number; z: number }) => ({ x: clamp(q.x, -room.width / 2 + hx, room.width / 2 - hx), z: clamp(q.z, -room.depth / 2 + hz, room.depth / 2 - hz) });
      search: for (const sd of sides) {
        const base = offset(sd);
        const alongZ = sd === "left" || sd === "right";
        const reach = (alongZ ? target.dims.d : target.dims.w) / 2 + (alongZ ? it.dims.d : it.dims.w) / 2;
        for (const k of outward(reach, 0.05)) {
          const lx = base.lx + (alongZ ? 0 : k);
          const lz = (alongZ ? (alignBack ? 0 : base.lz) : base.lz) + (alongZ ? k : 0);
          const q = inRoom({ x: target.position.x + lx * Math.cos(θ) + lz * Math.sin(θ), z: target.position.z - lx * Math.sin(θ) + lz * Math.cos(θ) });
          const probe: PlacedItem = { ...it, position: { x: q.x, y, z: q.z }, rotationY: facing(sd) };
          if (footprintsOverlap(probe, { ...target, position: { ...target.position, y: probe.position.y } })) continue;
          if (freeAt(sd, q)) {
            free = sd;
            slid = q;
            break search;
          }
        }
      }
    }
    if (!free && it.mount !== "wall") {
      const q = at(p.side ?? sides[0]);
      const why = blockerAt(it, q.x, y, q.z, facing(p.side ?? sides[0]), ignore)?.name;
      // The target stands under / on something (a bin under a desk, a cat on a tower's level): beside that instead.
      if (it.mount === "floor" && besideHost(it, target)) return;
      throw new ActionError(`no free spot next to ${target.name}${why ? ` (${why} is in the way)` : ""}`);
    }
    const side = free ?? sides.find((s) => fitsRoom(it, at(s).x, at(s).z, facing(s))) ?? sides[0];
    if (p.side && free && free !== p.side) {
      const q = at(p.side);
      const why = blockerAt(it, q.x, y, q.z, facing(p.side), ignore)?.name;
      note(`the ${p.side} side was ${why ? `taken by ${why}` : "out of room"}, so it went ${side === "front" ? "in front" : side === "behind" ? "behind" : `on the ${side}`}`);
    }
    const spot = slid ?? at(side);

    if (it.mount === "wall") {
      const { room } = S();
      const wall = target.mount === "wall" ? wallForItem(target, room) : nearestWall(spot, room);
      const along = wall === "north" || wall === "south" ? spot.x : spot.z;
      const height = target.mount === "wall" ? target.position.y : it.position.y;
      S().updateItem(it.id, wallMountPlacement(wall, along, height, it.dims, room));
      warnOverlap(it.id);
      return;
    }
    if (support) {
      // Next to something that stands on a desk: on the same desk.
      const supportId = support.id;
      if (supportId === it.id || restsOn(supportId, it.id)) throw new ActionError(`can't stack it that way`);
      if (!fitsOnTop(it, support, support.rotationY)) throw new ActionError(`${it.name} is too big to go on ${support.name}`);
      // On the same surface as the target (next to the cat on the tower's middle level), else its top.
      S().placeOnTop(it.id, supportId, target.supportSurfaceY);
      if (item(it.id)?.supportId !== supportId && target.supportSurfaceY !== undefined) {
        S().placeOnTop(it.id, supportId);
        if (item(it.id)?.supportId === supportId) note(`it doesn't fit on the level ${target.name} is on, so it's on top of ${support.name}`);
      }
      if (item(it.id)?.supportId !== supportId) throw new ActionError("couldn't put it there");
      moveOnSupport(it.id, supportId, spot.x, spot.z);
      warnOverlap(it.id);
      return;
    }
    unstack(it.id);
    S().updateItem(it.id, { position: { x: spot.x, y: item(it.id)!.position.y, z: spot.z }, rotationY: facing(side) });
    if (!free) warnOverlap(it.id);
  };

  /**
   * Off whatever it rests on, onto the floor in front of the stack it was on (or the nearest free side of it). A wall
   * / ceiling item comes down to the floor where it hung.
   */
  const putOnFloor = (id: string) => {
    const it = item(id)!;
    if (it.mount !== "floor") {
      S().updateItem(id, { mount: "floor", position: { ...it.position, y: 0 } });
      warnOverlap(id);
      return;
    }
    if (!it.supportId) {
      note("it was already on the floor");
      return;
    }
    S().placeOnTop(id, null);
    const down = item(id);
    if (!down || down.supportId) throw new ActionError("couldn't take it down");
    // Its spot in front of the stack is taken: the nearest free side of what it stood on.
    if (!overlapping(id)) return;
    let base = item(it.supportId);
    for (const seen = new Set<string>(); base?.supportId && !seen.has(base.id); ) {
      seen.add(base.id);
      const below = item(base.supportId);
      if (!below) break;
      base = below;
    }
    if (!base) {
      warnOverlap(id);
      return;
    }
    try {
      placeNextTo(down, { kind: "nextTo", targetId: base.id, side: "front" });
    } catch {
      warnOverlap(id); // nowhere free beside it either: it stays in front of it, and the chip says what it overlaps
    }
  };

  /** A floor point for a stacked item: when it is still over its support, it slides on it instead of falling off. */
  const slideOnSupport = (id: string, x: number, z: number): boolean => {
    const it = item(id);
    const sup = it?.supportId ? item(it.supportId) : undefined;
    if (!it || !sup || !pointInFootprint({ x, z }, sup)) return false;
    const q = clampOntoSupport({ x, z }, it, sup);
    moveOnSupport(id, sup.id, q.x, q.z);
    return true;
  };

  /** Put an existing item where `p` says. Throws ActionError when it can't; caveats go to `note`. */
  const place = (id: string, p: ChatPlacement) => {
    const it = item(id);
    if (!it) throw new ActionError("item disappeared");
    if (!p || typeof p !== "object") throw new ActionError("no placement given");
    switch (p.kind) {
      case "onTop":
      case "under": {
        const target = need(p.targetId);
        if (it.mount === "ceiling" && target.id !== it.id) {
          // A hanging lamp stays hanging (it never becomes a floor item by being stacked): it goes over the target.
          // "Over / on the desk" is then exactly what was asked (the chip says "above Desk"); "under" or a level isn't.
          S().updateItem(id, { position: { x: target.position.x, y: it.position.y, z: target.position.z } });
          if (p.kind === "under" || (p.level && p.level !== "top")) note(`it hangs from the ceiling, so it's above ${target.name}`);
          return;
        }
        stackOn(id, target.id, p.kind === "under" ? { under: true } : { level: p.level });
        return;
      }
      case "nextTo":
        placeNextTo(it, p);
        return;
      case "corner":
        placeInCorner(it, p.corner);
        return;
      case "wall":
        if (!WALL_LABEL[p.wall]) throw new ActionError("unknown wall");
        placeAgainstWall(it, p.wall, p.along);
        return;
      case "center": {
        if (it.mount === "wall") {
          placeAgainstWall(it, wallForItem(it, S().room), 0.5);
          return;
        }
        if (slideOnSupport(id, 0, 0)) return;
        unstack(id);
        S().updateItem(id, { position: { x: 0, y: item(id)!.position.y, z: 0 } });
        warnOverlap(id, "the middle is taken");
        return;
      }
      case "at": {
        if (!finite(p.x) || !finite(p.z)) throw new ActionError("bad coordinates");
        if (it.mount === "wall") {
          const { room } = S();
          const wall = nearestWall(p, room);
          S().updateItem(id, wallMountPlacement(wall, wall === "north" || wall === "south" ? p.x : p.z, it.position.y, it.dims, room));
          return;
        }
        if (slideOnSupport(id, p.x, p.z)) return;
        unstack(id);
        S().updateItem(id, { position: { x: p.x, y: item(id)!.position.y, z: p.z } });
        warnOverlap(id, "that spot is taken");
        return;
      }
      case "floor":
        putOnFloor(id);
        return;
      default:
        throw new ActionError("unknown placement");
    }
  };

  /** Place a just-created item; a failed placement keeps the item (where it was added) and reports why. */
  const placeNew = (id: string, p: ChatPlacement | undefined, label: string, extra: Partial<ActionResult> = {}): ActionResult => {
    if (!p) {
      // The app picked the spot: say so when the room is too full for a free one.
      warnOverlap(id, "no free space");
      return { type: "addShape", ok: true, label, ...extra };
    }
    const where = describe(p, item(id));
    try {
      place(id, p);
      return { type: "addShape", ok: true, label: `${label} · ${where}`, ...extra };
    } catch (e) {
      const support = e instanceof NoRoomError ? item(e.supportId) : undefined;
      if (support && item(id)) {
        // No room on the surface: beside it instead (on the floor, or on what the surface itself stands on).
        try {
          placeNextTo(item(id)!, { kind: "nextTo", targetId: support.id });
          return { type: "addShape", ok: true, label: `${label} · next to ${support.name}`, error: `${messageOf(e)}, so it's beside it`, ...extra };
        } catch {
          // fall through: it stays where it was added
        }
      }
      return { type: "addShape", ok: true, label, error: `couldn't put it ${where}: ${messageOf(e)}`, ...extra };
    }
  };

  /**
   * Hang an item from the ceiling, `drop` meters from the ceiling to its bottom (none: keep a hanging item's drop, a
   * pendant's drop for a lamp, flush for anything else). The cord stretches; the drop is kept within the room.
   */
  const hang = (it: PlacedItem, drop: number | undefined, type: ChatAction["type"]): ActionResult => {
    const wasCeiling = it.mount === "ceiling";
    const before = wasCeiling ? it.dims.h : null;
    const used = S().hangFromCeiling(it.id, drop);
    if (used == null) throw new ActionError(`couldn't hang ${it.name}`);
    if (drop !== undefined && Math.abs(used - drop) > 0.005) {
      note(drop > used ? `it can't come closer than ${len(S().room.height - used)} to the floor, so it hangs ${len(used)} down` : `it is ${len(used)} tall itself, so it hangs ${len(used)} down`);
    }
    warnOverlap(it.id, "hanging there");
    touched = it.id;
    const label =
      !wasCeiling
        ? `Hung ${it.name} from the ceiling · ${len(used)} drop`
        : before !== null && Math.abs(used - before) > 0.005
          ? `${used > before ? "Lowered" : "Raised"} ${it.name} by ${len(Math.abs(used - before))} · ${len(used)} drop`
          : `${it.name} hangs ${len(used)} below the ceiling`;
    return { type, ok: true, label };
  };

  // ---------- actions ----------

  const run = (a: ChatAction): ActionResult => {
    switch (a.type) {
      case "addShape": {
        const key = typeof a.preset === "string" ? a.preset.trim().toLowerCase() : "";
        const preset = SHAPE_PRESETS.find((p) => p.key === key);
        const primitive = !preset && SHAPE_KINDS.includes(key as ShapeKind) ? (key as ShapeKind) : null;
        const base = preset ?? SHAPE_PRESETS[0];
        const asked: Mount = (["floor", "wall", "ceiling"] as Mount[]).includes(a.mount as Mount) ? (a.mount as Mount) : base.mount;
        // On / under something = a floor item, except a hanging item: it stays hanging, above that thing (see place).
        const mount: Mount = (a.placement?.kind === "onTop" || a.placement?.kind === "under") && asked !== "ceiling" ? "floor" : asked;
        const color = normalizeHex(a.color) ?? base.color;
        const input: NewItemInput = {
          name: (typeof a.name === "string" && a.name.trim() ? a.name.trim() : preset?.label ?? "Shape").slice(0, 80),
          dims: cleanDims(a.dims, base.dims),
          mount,
          color,
          parts: cleanParts(a.parts) ?? (primitive ? [fullPart(primitive)] : base.parts),
          origin: "shape",
        };
        const id = S().addItem(input);
        if (typeof a.ref === "string" && a.ref) refs.set(a.ref, id);
        const result = placeNew(id, a.placement, `Added ${input.name}`, { swatch: color });
        touched = id;
        return result;
      }
      case "move": {
        const it = unlocked(need(a.itemId));
        const where = describe(a.placement, it);
        place(it.id, a.placement);
        touched = it.id;
        return { type: a.type, ok: true, label: `Moved ${it.name} → ${where}` };
      }
      case "rotate": {
        const it = unlocked(need(a.itemId));
        if (!finite(a.degrees)) throw new ActionError("no angle given");
        if (it.mount === "wall") throw new ActionError("wall items always face out from their wall");
        const rad = (a.degrees * Math.PI) / 180;
        const rotationY = wrapAngle(a.relative === false ? rad : it.rotationY + rad);
        S().updateItem(it.id, { rotationY });
        touched = it.id;
        const deg = Math.round(a.degrees);
        return { type: a.type, ok: true, label: a.relative === false ? `Turned ${it.name} to ${deg}°` : `Rotated ${it.name} ${deg > 0 ? "+" : ""}${deg}°` };
      }
      case "resize": {
        const it = unlocked(need(a.itemId));
        const dims = cleanDims(a.dims, it.dims);
        S().updateItem(it.id, { dims });
        touched = it.id;
        return { type: a.type, ok: true, label: `Resized ${it.name} → ${formatDims(dims, units())}` };
      }
      case "recolor": {
        const it = need(a.itemId);
        const color = normalizeHex(a.color);
        if (!color) throw new ActionError(`"${String(a.color)}" isn't a color`);
        S().updateItem(it.id, { color });
        touched = it.id;
        return { type: a.type, ok: true, label: `Recolored ${it.name}`, swatch: color };
      }
      case "rename": {
        const it = need(a.itemId);
        const name = typeof a.name === "string" ? a.name.trim().slice(0, 80) : "";
        if (!name) throw new ActionError("no new name given");
        S().updateItem(it.id, { name });
        touched = it.id;
        return { type: a.type, ok: true, label: `Renamed ${it.name} → ${name}` };
      }
      case "remove": {
        const it = need(a.itemId);
        S().removeItem(it.id);
        if (touched === it.id) touched = null;
        return { type: a.type, ok: true, label: `Removed ${it.name}` };
      }
      case "duplicate": {
        const it = need(a.itemId);
        const copyId = S().duplicateItem(it.id);
        if (!copyId) throw new ActionError("couldn't copy it");
        if (typeof a.ref === "string" && a.ref) refs.set(a.ref, copyId);
        const r = placeNew(copyId, a.placement, `Duplicated ${it.name}`);
        touched = copyId;
        return { ...r, type: a.type };
      }
      case "setRoom": {
        const p = a.patch ?? {};
        const { room } = S();
        const patch: Partial<Room> = {};
        const parts: string[] = [];
        if (typeof p.name === "string" && p.name.trim()) patch.name = p.name.trim().slice(0, 80);
        if (finite(p.width) && p.width > 0) patch.width = clamp(p.width, 1.5, 15);
        if (finite(p.depth) && p.depth > 0) patch.depth = clamp(p.depth, 1.5, 15);
        if (finite(p.height) && p.height > 0) patch.height = clamp(p.height, 1.8, 6);
        const wallColor = normalizeHex(p.wallColor);
        const floorColor = normalizeHex(p.floorColor);
        if (wallColor) patch.wallColor = wallColor;
        if (floorColor) patch.floorColor = floorColor;
        if (!Object.keys(patch).length) throw new ActionError("nothing to change");
        if (patch.width != null || patch.depth != null) parts.push(`${len(patch.width ?? room.width)} × ${len(patch.depth ?? room.depth)}`);
        if (patch.height != null) parts.push(`${len(patch.height)} ceiling`);
        if (patch.wallColor) parts.push("wall color");
        if (patch.floorColor) parts.push("floor color");
        if (patch.name) parts.push(`“${patch.name}”`);
        S().updateRoom(patch);
        return { type: a.type, ok: true, label: `Room → ${parts.join(", ")}`, swatch: patch.wallColor ?? patch.floorColor };
      }
      case "search": {
        const query = typeof a.query === "string" ? a.query.trim() : "";
        if (!query) throw new ActionError("nothing to search for");
        const forItemId = a.forItemId != null ? (resolve(a.forItemId) ?? undefined) : undefined;
        searches.push({ ...a, query, forItemId });
        return { type: a.type, ok: true, label: `Searching for “${query}”` };
      }
      case "addCandidate": {
        const c = candidate(a.index);
        const label = `Added ${c.name}`;
        if (a.replaceItemId != null) {
          const target = need(a.replaceItemId);
          const id = S().replaceItemWithProduct(target.id, c);
          if (!id) throw new ActionError(`couldn't replace ${target.name}`);
          touched = id;
          const replaced = `Replaced ${target.name} with ${c.name}`;
          // A placement given with the swap moves the product there (it starts at the replaced item's spot).
          const r = a.placement ? placeNew(id, a.placement, replaced) : { type: a.type, ok: true, label: replaced };
          return { ...r, type: a.type };
        }
        const id = S().addProduct(c);
        if (S().preview?.id === c.id) S().setPreview(null);
        const r = placeNew(id, a.placement, label);
        touched = id;
        return { ...r, type: a.type };
      }
      case "previewCandidate": {
        const c = candidate(a.index);
        S().setPreview(c);
        return { type: a.type, ok: true, label: `Previewing ${c.name}` };
      }
      case "select": {
        const it = need(a.itemId);
        touched = it.id;
        return { type: a.type, ok: true, label: `Selected ${it.name}` };
      }
      case "camera": {
        if (!CAMERA_LABEL[a.preset]) throw new ActionError("unknown view");
        ctx.camera?.(a.preset);
        return { type: a.type, ok: true, label: CAMERA_LABEL[a.preset] };
      }
      case "setHidden": {
        const it = need(a.itemId);
        const hidden = a.hidden === true;
        if (!!it.hidden === hidden) return { type: a.type, ok: true, label: `${it.name} is already ${hidden ? "hidden" : "shown"}` };
        S().updateItem(it.id, { hidden });
        if (hidden && touched === it.id) touched = null;
        if (hidden && S().selectedId === it.id) S().select(null);
        if (!hidden) touched = it.id;
        return { type: a.type, ok: true, label: `${hidden ? "Hid" : "Showed"} ${it.name}` };
      }
      case "setMount": {
        const it = unlocked(need(a.itemId));
        const mount = a.mount;
        if (!MOUNT_LABEL[mount]) throw new ActionError(`unknown mount "${String(mount)}"`);
        touched = it.id;
        // "Put the monitor on the floor" on a stacked monitor: take it down rather than report "already on the floor".
        if (mount === "floor" && it.mount === "floor" && it.supportId) {
          putOnFloor(it.id);
          return { type: a.type, ok: true, label: `${it.name} now ${MOUNT_LABEL[mount]}` };
        }
        if (it.mount === mount) return { type: a.type, ok: true, label: `${it.name} already ${MOUNT_LABEL[mount]}` };
        // Up to the ceiling the same way as "hang it from the ceiling": a lamp on a cord, never an upright floor lamp
        // stuck flush to the ceiling with its base in mid-air.
        if (mount === "ceiling") return hang(it, undefined, a.type);
        // Off whatever it rested on; the store re-places it for the new mount (nearest wall, ceiling, floor).
        if (it.supportId) S().placeOnTop(it.id, null);
        const y = mount === "wall" ? Math.min(1.5, Math.max(0, S().room.height - it.dims.h)) : 0;
        S().updateItem(it.id, { mount, position: { ...item(it.id)!.position, y } });
        if (mount === "wall") {
          const cur = item(it.id)!;
          placeAgainstWall(cur, wallForItem(cur, S().room), undefined);
        } else warnOverlap(it.id);
        return { type: a.type, ok: true, label: `${it.name} now ${MOUNT_LABEL[mount]}` };
      }
      case "setHeight": {
        const it = unlocked(need(a.itemId));
        if (!finite(a.bottom)) throw new ActionError("no height given");
        if (it.mount === "floor") throw new ActionError(`${it.name} stands on the floor (or on what's below it); hang it on the wall first`);
        if (it.mount === "ceiling") return hang(it, Math.max(0, S().room.height - a.bottom), a.type);
        const { room } = S();
        const bottom = clamp(a.bottom, 0, Math.max(0, room.height - it.dims.h));
        if (bottom < a.bottom - 1e-6) note(`the ceiling is at ${len(room.height)}, so it's at ${len(bottom)}`);
        S().updateItem(it.id, { position: { ...it.position, y: bottom } });
        const cur = item(it.id)!;
        const wall = wallForItem(cur, room);
        if (coversOpening(wall, wall === "north" || wall === "south" ? cur.position.x : cur.position.z, cur.position.y, cur.dims, room)) note("it covers a door or window");
        else warnOverlap(it.id, "at that height");
        touched = it.id;
        return { type: a.type, ok: true, label: `Hung ${it.name} at ${len(bottom)}` };
      }
      case "hang":
        return hang(unlocked(need(a.itemId)), finite(a.drop) && a.drop > 0 ? a.drop : undefined, a.type);
      case "setOpening":
        return setOpening(a);
      case "saveVersion": {
        if (!ctx.versions) throw new ActionError("versions aren't available here");
        const v = ctx.versions.save(typeof a.name === "string" ? a.name : undefined);
        return { type: a.type, ok: true, label: `Saved version “${v.name}”` };
      }
      case "restoreVersion": {
        if (!ctx.versions) throw new ActionError("versions aren't available here");
        // The id from the scene; as a fallback an exact name ("Option A"), newest first.
        const all = ctx.versions.list();
        const key = typeof a.versionId === "string" ? a.versionId.trim() : "";
        const found = all.find((v) => v.id === key) ?? all.find((v) => v.name.trim().toLowerCase() === key.toLowerCase());
        if (!found) throw new ActionError(all.length ? `couldn't find that version` : "there are no saved versions yet");
        // Its "Before restoring" picture: the 3D view still shows the design from before this turn, so only take it
        // now when nothing in this turn has changed the plan yet.
        const v = ctx.versions.restore(found.id, { thumbnail: unchangedSinceStart() ? "now" : "later" });
        if (!v) throw new ActionError(`couldn't restore “${found.name}”`);
        if (touched && !item(touched)) touched = null;
        return { type: a.type, ok: true, label: `Restored “${v.name}”` };
      }
      case "setLighting":
      case "setLight":
      case "setWindow": {
        const r = runLightingAction(a, S, resolve);
        if (r.touched) touched = r.touched;
        const { touched: _t, ...rest } = r;
        return { type: a.type, ...rest };
      }
      case "undo":
        // Handled before the other actions (see below).
        return { type: a.type, ok: false, label: "Undo", error: "not run" };
      default:
        throw new ActionError(`unknown action "${String((a as { type?: unknown }).type)}"`);
    }
  };

  const OPENING_DEFAULTS: Record<Opening["kind"], { width: number; height: number; sill: number }> = {
    door: { width: 0.81, height: 2.03, sill: 0 },
    window: { width: 1.2, height: 1.2, sill: 0.9 },
  };

  /** Add / change / remove a door or window (kept inside its wall and under the ceiling). */
  const setOpening = (a: Extract<ChatAction, { type: "setOpening" }>): ActionResult => {
    const { room } = S();
    const kindWord = (k: Opening["kind"]) => (k === "door" ? "door" : "window");
    if (a.op === "remove") {
      const o = room.openings.find((x) => x.id === a.openingId);
      if (!o) throw new ActionError("couldn't find that door or window");
      S().updateRoom({ openings: room.openings.filter((x) => x.id !== o.id) });
      return { type: a.type, ok: true, label: `Removed ${kindWord(o.kind)} · ${WALL_LABEL[o.wall]}` };
    }
    let base: Opening;
    if (a.op === "update") {
      const o = room.openings.find((x) => x.id === a.openingId);
      if (!o) throw new ActionError("couldn't find that door or window");
      base = o;
    } else if (a.op === "add") {
      const kind: Opening["kind"] = a.kind === "door" ? "door" : "window";
      const wall: WallSide = a.wall && WALL_LABEL[a.wall] ? a.wall : "north";
      const wallLen = wall === "north" || wall === "south" ? room.width : room.depth;
      base = { id: newId(kind === "door" ? "door" : "win"), kind, wall, offset: wallLen / 2, ...OPENING_DEFAULTS[kind] };
    } else throw new ActionError(`unknown change "${String(a.op)}"`);
    const kind: Opening["kind"] = a.kind === "door" || a.kind === "window" ? a.kind : base.kind;
    const wall: WallSide = a.wall && WALL_LABEL[a.wall] ? a.wall : base.wall;
    const wallLen = wall === "north" || wall === "south" ? room.width : room.depth;
    const pos = (v: unknown, fallback: number) => (finite(v) && v > 0 ? v : fallback);
    const width = clamp(pos(a.width, base.width), 0.3, wallLen);
    const sill = kind === "door" ? 0 : clamp(finite(a.sill) && a.sill >= 0 ? a.sill : base.sill, 0, room.height - 0.2);
    const height = clamp(pos(a.height, base.height), 0.2, room.height - sill);
    const offset = clamp(finite(a.offset) && a.offset >= 0 ? a.offset : wall === base.wall ? base.offset : wallLen / 2, width / 2, wallLen - width / 2);
    const next: Opening = { id: base.id, kind, wall, offset, width, height, sill };
    const others = room.openings.filter((x) => x.id !== base.id);
    const clash = others.find((o) => o.wall === wall && Math.abs(o.offset - offset) < (o.width + width) / 2);
    if (clash) note(`overlaps the ${kindWord(clash.kind)} on that wall`);
    S().updateRoom({ openings: a.op === "add" ? [...room.openings, next] : room.openings.map((x) => (x.id === base.id ? next : x)) });
    const what = `${kindWord(kind)} · ${WALL_LABEL[wall]}, ${len(width)} wide`;
    return { type: a.type, ok: true, label: a.op === "add" ? `Added ${what}` : `Changed ${what}` };
  };

  const candidate = (index: unknown): ProductCandidate => {
    const all = ctx.lastResults ?? [];
    if (!all.length) throw new ActionError("there are no search results yet");
    if (!finite(index) || index < 0 || index >= all.length || !Number.isInteger(index)) {
      throw new ActionError(`there are only ${all.length} result${all.length === 1 ? "" : "s"}`);
    }
    return all[index];
  };

  const failLabel = (a: ChatAction): string => {
    switch (a?.type) {
      case "addShape":
        return `Add ${a.name || "shape"}`;
      case "move":
        return "Move";
      case "rotate":
        return "Rotate";
      case "resize":
        return "Resize";
      case "recolor":
        return "Recolor";
      case "rename":
        return "Rename";
      case "remove":
        return "Remove";
      case "duplicate":
        return "Duplicate";
      case "setRoom":
        return "Change room";
      case "search":
        return "Search";
      case "addCandidate":
        return `Add result #${finite(a.index) ? a.index + 1 : "?"}`;
      case "previewCandidate":
        return `Preview result #${finite(a.index) ? a.index + 1 : "?"}`;
      case "select":
        return "Select";
      case "camera":
        return "Change view";
      case "setHidden":
        return a.hidden ? "Hide" : "Show";
      case "setMount":
        return "Change mount";
      case "setHeight":
        return "Change height";
      case "hang":
        return "Hang from the ceiling";
      case "setOpening":
        return a.op === "remove" ? "Remove opening" : a.op === "add" ? `Add ${a.kind ?? "window"}` : "Change opening";
      case "saveVersion":
        return "Save version";
      case "restoreVersion":
        return "Restore version";
      case "setLighting":
        return "Change lighting";
      case "setLight":
        return "Change light";
      case "setWindow":
        return a.covering === "closed" ? "Close blinds" : "Open blinds";
      default:
        return "Action";
    }
  };

  // What the 3D view shows while this turn runs (it re-renders after it): thumbnails are only right for this plan.
  const turnStart = { room: S().room, items: S().items };
  const unchangedSinceStart = () => S().room === turnStart.room && S().items === turnStart.items;

  // 1) Undo actions first: they act on the history from before this turn and are not part of its undo step.
  list.forEach((a, i) => {
    if (a?.type !== "undo") return;
    const steps = finite(a.steps) ? clamp(Math.round(a.steps), 1, 20) : 1;
    let done = 0;
    for (let k = 0; k < steps && S().past.length; k++, done++) S().undo();
    results[i] = finalizeResult(
      done ? { type: "undo", ok: true, label: `Undid ${done} change${done === 1 ? "" : "s"}` } : { type: "undo", ok: false, label: "Undo", error: "nothing to undo" },
    );
  });

  // A turn with several changes is a big edit: keep the design from before it as an auto version.
  if (ctx.versions && list.filter((a) => a && !NOT_A_CHANGE.has(a.type)).length >= 3) {
    ctx.versions.autoSnapshot("chat", { thumbnail: unchangedSinceStart() ? "now" : "later" });
  }

  // 2) Everything else, collapsed into one undo step.
  const before = { room: S().room, items: S().items };
  const keptPast = S().past;
  const keptFuture = S().future;
  // In dependency order (a desk is moved before the monitor goes on it); chips stay in the reply's order.
  const order = runOrder(list, resolve);
  const touchLog: { i: number; id: string }[] = [];
  order.forEach((i, pos) => {
    const a = list[i];
    if (a?.type === "undo") return;
    notes = [];
    // What the rest of the turn puts on / under each item: moving that item ignores them (no "overlaps Monitor").
    incoming = new Map();
    for (const j of order.slice(pos + 1)) {
      const b = list[j];
      if (b?.type !== "move") continue;
      const pl = b.placement;
      if (!pl || (pl.kind !== "onTop" && pl.kind !== "under")) continue;
      const target = resolve(pl.targetId);
      const what = resolve(b.itemId);
      if (!target || !what) continue;
      incoming.set(target, new Set([...(incoming.get(target) ?? []), what]));
    }
    touched = null;
    try {
      // Caveats of a done action ("shifted to avoid the bed") make an "adjusted" chip, never "ok" with an error.
      results[i] = finalizeResult(run(a), notes);
    } catch (e) {
      results[i] = finalizeResult({ type: a?.type ?? "select", ok: false, label: failLabel(a), error: messageOf(e) });
    }
    if (touched) touchLog.push({ i, id: touched });
  });
  incoming = new Map();
  // "it" in the next message (and the inspector) follows the item touched by the reply's last action that touched one.
  const last = touchLog.filter((t) => item(t.id) && !item(t.id)!.hidden).sort((x, y) => y.i - x.i)[0];
  if (last) S().select(last.id);

  const end = S();
  let step: TurnStep | null = null;
  if (end.room !== before.room || end.items !== before.items) {
    planner.setState({ past: [...keptPast, before].slice(-HISTORY_LIMIT), future: [] });
    step = { before, after: { room: end.room, items: end.items } };
  } else if (end.past !== keptPast) {
    // Nothing changed in the end (e.g. a step that was taken back): no empty undo step either.
    planner.setState({ past: keptPast, future: keptFuture });
  }

  return { results: results.filter((r): r is ActionResult => !!r), step, searches };
}

/** The item key (id, ref or name, as written) an action places relative to, if any. */
function placementTarget(a: ChatAction | undefined): string | null {
  if (!a || typeof a !== "object") return null;
  const p = "placement" in a ? (a.placement as ChatPlacement | undefined) : undefined;
  return p && typeof p === "object" && "targetId" in p && typeof p.targetId === "string" ? p.targetId : null;
}

/** Item keys an action moves, turns, resizes, re-mounts or creates (by ref): what later placements depend on. */
function shapedKeys(a: ChatAction | undefined): string[] {
  if (!a || typeof a !== "object") return [];
  switch (a.type) {
    case "addShape":
    case "duplicate":
      return typeof a.ref === "string" && a.ref ? [a.ref] : [];
    case "move":
    case "rotate":
    case "resize":
    case "setMount":
      return typeof a.itemId === "string" ? [a.itemId] : [];
    default:
      return [];
  }
}

/**
 * The order to run a reply's actions in (indices into `list`): as written, except that an action that places
 * something on / under / next to an item, or refers to an item by a ref, runs after the LATER actions that create,
 * move, turn, resize or re-mount that item ("put the monitor on the desk, and move the desk to the wall": the desk
 * moves first, then the monitor goes onto it where it now stands). Removals are not moved ahead. Ties and cycles keep
 * the written order. Saving / restoring a version is a barrier: everything written before it runs before it, and
 * nothing moves across it ("put the monitor on the desk, save as A, then move the desk": A has the monitor on the
 * desk). `resolve` maps a key (id / ref / name) to an item id when it exists.
 */
export function runOrder(list: ChatAction[], resolve: (key: string) => string | null = () => null): number[] {
  const barrier = (a: ChatAction | undefined) => a?.type === "saveVersion" || a?.type === "restoreVersion";
  if (list.some(barrier)) {
    const order: number[] = [];
    let start = 0;
    list.forEach((a, i) => {
      if (!barrier(a)) return;
      order.push(...runOrder(list.slice(start, i), resolve).map((k) => k + start), i);
      start = i + 1;
    });
    order.push(...runOrder(list.slice(start), resolve).map((k) => k + start));
    return order;
  }
  const canon = (k: string) => resolve(k) ?? k;
  const shaped = list.map((a) => new Set(shapedKeys(a).map(canon)));
  const uses = list.map((a) => {
    const out = new Set<string>();
    const t = placementTarget(a);
    if (t) out.add(canon(t));
    // An action on an item made by a later action's ref ("lamp1") waits for it.
    if (a && typeof a === "object" && "itemId" in a && typeof a.itemId === "string" && !resolve(a.itemId)) out.add(a.itemId);
    return out;
  });
  const deps = list.map((_, i) => {
    const out: number[] = [];
    for (let j = i + 1; j < list.length; j++) if ([...uses[i]].some((k) => shaped[j].has(k))) out.push(j);
    return out;
  });
  const done = new Set<number>();
  const order: number[] = [];
  while (order.length < list.length) {
    let next = -1;
    for (let i = 0; i < list.length; i++) {
      if (done.has(i)) continue;
      if (deps[i].every((j) => done.has(j))) {
        next = i;
        break;
      }
    }
    if (next < 0) next = [...list.keys()].find((i) => !done.has(i))!; // a cycle: the written order
    done.add(next);
    order.push(next);
  }
  return order;
}

function messageOf(e: unknown): string {
  if (e instanceof ActionError) return e.message;
  return e instanceof Error ? e.message || "something went wrong" : "something went wrong";
}

// ---------- "Undo this" ----------

export type TurnStatus = { state: "applied"; steps: number } | { state: "undone"; canRedo: boolean } | { state: "gone" };

/**
 * Where a turn's undo step is in the store's history. "applied" with steps = how many undos it takes to revert it
 * (1 = it is the latest change); "undone" when it was undone (redoable only while the plan is at its before-state).
 */
export function turnStatus(step: TurnStep, s: Pick<PlannerState, "past" | "future" | "room" | "items">): TurnStatus {
  const same = (a: { room: Room; items: PlacedItem[] }, b: { room: Room; items: PlacedItem[] }) => a.room === b.room && a.items === b.items;
  // Applied = the history holds `before` immediately followed by `after` (the next snapshot, or the current state).
  for (let i = s.past.length - 1; i >= 0; i--) {
    const next = i + 1 < s.past.length ? s.past[i + 1] : s;
    if (same(s.past[i], step.before) && same(next, step.after)) return { state: "applied", steps: s.past.length - i };
  }
  if (same(s, step.before)) return { state: "undone", canRedo: !!s.future[0] && same(s.future[0], step.after) };
  // Undone further back (e.g. with the toolbar's undo, several steps): its after-state waits in the redo stack
  // right behind its before-state. Only the newest undone step can be redone from here.
  for (let j = 1; j < s.future.length; j++) {
    if (same(s.future[j - 1], step.before) && same(s.future[j], step.after)) return { state: "undone", canRedo: false };
  }
  return { state: "gone" };
}

/** Revert a turn (and anything done after it). Returns false if its step is no longer in the history. */
export function undoTurn(step: TurnStep, planner: PlannerApi): boolean {
  const st = turnStatus(step, planner.getState());
  if (st.state !== "applied") return false;
  for (let k = 0; k < st.steps; k++) planner.getState().undo();
  return true;
}

/** Re-apply an undone turn. */
export function redoTurn(step: TurnStep, planner: PlannerApi): boolean {
  const st = turnStatus(step, planner.getState());
  if (st.state !== "undone" || !st.canRedo) return false;
  planner.getState().redo();
  return true;
}
