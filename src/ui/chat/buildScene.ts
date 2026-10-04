// The compact scene description sent with every chat message (see ChatScene in shared/types).
import type { ChatScene, ChatTurn, DesignVersion, PlacedItem, ProductCandidate } from "../../shared/types";
import type { PlannerState } from "../../state/store";
import { supportSurfaces, surfaceNames } from "../../lib/geometry";

/** Most items a scene lists (rooms rarely have this many; keeps the request small). The selection is always in. */
const MAX_ITEMS = 80;
/**
 * Most design versions a scene lists: every named version first (newest ones if there are more), then the newest
 * NEWEST_AUTOS auto snapshots, then older auto snapshots thinned to one per hour (so "this morning" still has one).
 * Below the server's CHAT_LIMITS.versions.
 */
export const SCENE_VERSIONS = 30;
const NEWEST_AUTOS = 10;
/** Previous turns sent with a message. */
export const MAX_HISTORY = 12;

/**
 * The server's request limits (server/schemas.ts ChatRequestSchema / CHAT_LIMITS). Text is clipped to them here so
 * a long item or room name can never make every chat message fail with a 400.
 */
export const SCENE_LIMITS = {
  itemName: 200,
  roomName: 120,
  openings: 40,
  color: 20,
  productName: 300,
  retailer: 200,
  url: 2000,
  results: 20,
  styleWords: 10,
  styleWord: 60,
  query: 500,
  /** Characters of one message (CHAT_LIMITS.message). */
  message: 4000,
  versionName: 80,
} as const;

/** Round to millimeters / milliradians: plenty for the model, and keeps the JSON short. */
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

/** The items to list: the most recent MAX_ITEMS, plus the selected item and what it rests on (in plan order). */
function itemsToSend(items: PlacedItem[], selectedId: string | null): PlacedItem[] {
  if (items.length <= MAX_ITEMS) return items;
  const keep = new Set(items.slice(-MAX_ITEMS).map((it) => it.id));
  const byId = new Map(items.map((it) => [it.id, it]));
  for (let cur = selectedId ? byId.get(selectedId) : undefined; cur && !keep.has(cur.id); cur = cur.supportId ? byId.get(cur.supportId) : undefined) {
    keep.add(cur.id);
  }
  return items.filter((it) => keep.has(it.id));
}

/** Local clock time with weekday and date, e.g. "Sat, Oct 3, 9:41 AM" (what "this morning" / "yesterday" go by). */
export function localTime(at: number): string {
  return new Date(at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The versions a scene lists, newest first (see SCENE_VERSIONS). */
export function sceneVersions<T extends Pick<DesignVersion, "auto" | "createdAt">>(versions: T[]): T[] {
  const named = versions.filter((v) => !v.auto).slice(0, SCENE_VERSIONS);
  const autos = versions.filter((v) => v.auto);
  const keep = new Set<T>(named);
  const room = () => keep.size < SCENE_VERSIONS;
  for (const v of autos.slice(0, NEWEST_AUTOS)) if (room()) keep.add(v);
  let lastHour: number | null = null;
  for (const v of autos.slice(NEWEST_AUTOS)) {
    const hour = Math.floor(v.createdAt / 3_600_000);
    if (hour === lastHour) continue;
    lastHour = hour;
    if (room()) keep.add(v);
  }
  return versions.filter((v) => keep.has(v));
}

/** Kind of the surface at height y (item frame): a thin shelf / perch, or the roof of a solid part (a condo box). */
function levelKind(it: PlacedItem, y: number): "platform" | "box" | undefined {
  const part = (it.parts ?? []).find((p) => (p.kind === "box" || p.kind === "cylinder") && Math.abs((p.center.y + p.size.y / 2) * it.dims.h - y) < 0.01);
  if (!part) return undefined;
  return part.size.y * it.dims.h <= 0.1 ? "platform" : "box";
}

/** The raised levels of a multi-level item (2+ raised surfaces at least 10 cm up, e.g. a cat tower), else undefined. */
function levelsOf(it: PlacedItem): NonNullable<ChatScene["items"][number]["levels"]> | undefined {
  if (it.mount !== "floor" || !it.parts?.length) return undefined;
  const all = supportSurfaces(it);
  const names = surfaceNames(all);
  const out = all
    .map((sf, i) => ({ sf, name: names[i] }))
    .filter(({ sf, name }) => sf.kind !== "under" && name !== "base")
    .map(({ sf, name }) => {
      const kind = levelKind(it, sf.y);
      return { name, y: r3(sf.y), ...(kind ? { kind } : {}) };
    });
  return out.length >= 2 ? out : undefined;
}

export function buildChatScene(
  s: Pick<PlannerState, "units" | "room" | "items" | "selectedId"> & Partial<Pick<PlannerState, "previewTargetId" | "preview">>,
  lastResults: ProductCandidate[] = [],
  lastQuery?: string,
  /** Saved design versions, newest first (see sceneVersions for which are sent). */
  versions: NonNullable<ChatScene["versions"]> = [],
  /** The current time (epoch ms), for "now" and the versions' local times. */
  now: number = Date.now(),
): ChatScene {
  const { room } = s;
  const sent = itemsToSend(s.items, s.selectedId);
  const items = sent.map((it) => {
    const out: ChatScene["items"][number] = {
      id: it.id,
      name: clip(it.name, SCENE_LIMITS.itemName),
      dims: { w: r3(it.dims.w), h: r3(it.dims.h), d: r3(it.dims.d) },
      position: { x: r3(it.position.x), y: r3(it.position.y), z: r3(it.position.z) },
      rotationY: r3(it.rotationY),
      mount: it.mount,
      color: clip(it.color, SCENE_LIMITS.color),
      origin: it.origin,
    };
    if (it.supportId) out.supportId = it.supportId;
    if (it.supportId && typeof it.supportSurfaceY === "number") out.supportSurfaceY = r3(it.supportSurfaceY);
    if (it.hidden) out.hidden = true;
    if (it.light) out.light = { on: it.light.on, color: clip(it.light.color, SCENE_LIMITS.color), intensity: r3(Math.min(1, Math.max(0, it.light.intensity))) };
    // "Put the cat on the lower platform": the model sees which levels there are, how high, and what they are.
    const levels = levelsOf(it);
    if (levels) out.levels = levels;
    if (it.product) {
      out.product = {
        name: clip(it.product.name, SCENE_LIMITS.productName),
        retailer: clip(it.product.retailer, SCENE_LIMITS.retailer),
        url: clip(it.product.url, SCENE_LIMITS.url),
      };
      if (typeof it.product.price === "number" && it.product.price >= 0) out.product.price = it.product.price;
    }
    return out;
  });
  const scene: ChatScene = {
    units: s.units,
    room: {
      name: clip(room.name, SCENE_LIMITS.roomName),
      width: r3(room.width),
      depth: r3(room.depth),
      height: r3(room.height),
      wallColor: clip(room.wallColor, SCENE_LIMITS.color),
      floorColor: clip(room.floorColor, SCENE_LIMITS.color),
      openings: room.openings
        .slice(0, SCENE_LIMITS.openings)
        .map((o) => ({ ...o, offset: r3(o.offset), width: r3(o.width), height: r3(o.height), sill: r3(o.sill) })),
    },
    items,
    selectedId: s.selectedId && sent.some((it) => it.id === s.selectedId) ? s.selectedId : null,
    lighting: room.lighting === "evening" || room.lighting === "night" ? room.lighting : "day",
    now: localTime(now),
  };
  if (versions.length) {
    scene.versions = sceneVersions(versions).map((v) => ({
      id: clip(v.id, 120),
      name: clip(v.name, SCENE_LIMITS.versionName),
      createdAt: v.createdAt,
      auto: v.auto === true,
      savedAt: localTime(v.createdAt),
    }));
  }
  if (lastResults.length) {
    scene.lastResults = lastResults.slice(0, SCENE_LIMITS.results).map((c, index) => {
      const out: NonNullable<ChatScene["lastResults"]>[number] = {
        index,
        name: clip(c.name, SCENE_LIMITS.productName),
        retailer: clip(c.retailer, SCENE_LIMITS.retailer),
        dims: { w: r3(c.dims.w), h: r3(c.dims.h), d: r3(c.dims.d) },
        mount: c.mount,
        style: c.style.slice(0, SCENE_LIMITS.styleWords).map((t) => clip(t, SCENE_LIMITS.styleWord)),
        colors: c.colors.slice(0, SCENE_LIMITS.styleWords).map((col) => clip(col.name, SCENE_LIMITS.styleWord)),
      };
      if (typeof c.price === "number" && c.price >= 0) out.price = c.price;
      return out;
    });
    // What the results were for: "add the second one" then replaces that item.
    const forItemId = s.previewTargetId && sent.some((it) => it.id === s.previewTargetId) ? s.previewTargetId : undefined;
    // The result shown as a ghost in the room right now: "add it" means that one.
    const shown = s.preview ? lastResults.slice(0, SCENE_LIMITS.results).findIndex((c) => c.id === s.preview!.id) : -1;
    if (lastQuery?.trim() || forItemId || shown >= 0) {
      scene.lastSearch = {
        query: clip(lastQuery?.trim() ?? "", SCENE_LIMITS.query),
        ...(forItemId ? { forItemId } : {}),
        ...(shown >= 0 ? { previewIndex: shown } : {}),
      };
    }
  }
  return scene;
}

const price = (c: ProductCandidate) =>
  typeof c.price === "number" && Number.isFinite(c.price) ? ` ${!c.currency || c.currency === "USD" ? `$${c.price}` : `${c.price} ${c.currency}`}` : "";

/** One line per result for the conversation history, e.g. `Found 3 for "lamp": 1. Akari $129 (IKEA); 2. ...`. */
export function resultsSummary(query: string, candidates: ProductCandidate[]): string {
  if (!candidates.length) return `Found no products for "${query}".`;
  const list = candidates
    .slice(0, SCENE_LIMITS.results)
    .map((c, i) => `${i + 1}. ${c.name}${price(c)} (${c.retailer}, ${c.mount})`)
    .join("; ");
  return `Found ${candidates.length} product${candidates.length === 1 ? "" : "s"} for "${query}": ${list}.`;
}

/**
 * The last few turns of the conversation, oldest first: text turns, plus a one-line summary of finished product
 * searches (so "the second one" means the same thing to the model as to the user).
 */
export function buildHistory(
  messages: { role: "user" | "assistant"; text: string; kind?: string; search?: { query: string; status: string; candidates?: ProductCandidate[] } }[],
): ChatTurn[] {
  return messages
    .map((m): ChatTurn | null => {
      const kind = m.kind ?? "text";
      if (kind === "text" && m.text.trim()) return { role: m.role, content: m.text.slice(0, 2000) };
      if (kind === "search" && m.search?.status === "done") return { role: "assistant", content: resultsSummary(m.search.query, m.search.candidates ?? []).slice(0, 2000) };
      return null;
    })
    .filter((t): t is ChatTurn => !!t)
    .slice(-MAX_HISTORY);
}

/** A follow-up the user can type that will work for these results (by where they mount and what's in the room). */
export function resultsHint(list: Pick<ProductCandidate, "mount" | "dims">[], hasDesk: boolean): string {
  const pick = list.length > 1 ? "second" : "first";
  const c = list[list.length > 1 ? 1 : 0];
  if (!c) return "add the first one";
  if (c.mount === "ceiling") return `add the ${pick} one in the corner`;
  if (c.mount === "wall") return `add the ${pick} one on the north wall`;
  const small = Math.max(c.dims.w, c.dims.d) <= 0.8 && c.dims.h <= 1;
  if (small && hasDesk) return `add the ${pick} one on the desk`;
  return `add the ${pick} one`;
}
