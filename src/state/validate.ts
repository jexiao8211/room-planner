// Normalization for plans coming from outside the app's own actions: imported files and localStorage.
// A malformed item must never reach the scene (a part without `center` crashes rendering, a missing
// rotationY turns positions into NaN), so everything is checked and filled in with safe defaults here.
import type { ColorSwatch, Dims, Mount, Opening, PlacedItem, ProductCandidate, Room, ShapeKind, ShapePart, Vec3, WallSide } from "../shared/types";
import { defaultRoom, newId } from "../lib/presets";
import { httpUrl } from "../lib/urls";
import { autoLight, normalizeLight } from "../lib/lighting";

const MOUNTS: Mount[] = ["floor", "wall", "ceiling"];
const SHAPES: ShapeKind[] = ["box", "cylinder", "sphere", "cone"];
const WALLS: WallSide[] = ["north", "south", "east", "west"];
const ORIGINS: PlacedItem["origin"][] = ["existing", "shape", "product"];

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v : fallback);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

export function validHex(v: unknown): string | null {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null;
}

function vec3(v: unknown): Vec3 | null {
  if (!isObj(v) || !isNum(v.x) || !isNum(v.y) || !isNum(v.z)) return null;
  return { x: v.x, y: v.y, z: v.z };
}

function dims(v: unknown): Dims | null {
  if (!isObj(v) || ![v.w, v.h, v.d].every((n) => isNum(n) && n > 0)) return null;
  return { w: v.w as number, h: v.h as number, d: v.d as number };
}

const FULL_BOX: ShapePart = { kind: "box", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } };

/** Keep only parts with a known kind and finite center/size (size > 0). Never returns an empty list. */
export function normalizeParts(v: unknown): ShapePart[] {
  const out: ShapePart[] = [];
  if (Array.isArray(v)) {
    for (const p of v) {
      if (!isObj(p)) continue;
      const center = vec3(p.center);
      const size = vec3(p.size);
      if (!center || !size || !(size.x > 0 && size.y > 0 && size.z > 0)) continue;
      if (!(SHAPES as string[]).includes(p.kind as string)) continue;
      const part: ShapePart = { kind: p.kind as ShapeKind, center, size };
      const color = validHex(p.color);
      if (color) part.color = color;
      out.push(part);
    }
  }
  return out.length ? out : [{ ...FULL_BOX, center: { ...FULL_BOX.center }, size: { ...FULL_BOX.size } }];
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

/**
 * A usable product candidate (from a saved plan or saved search results), or undefined. Its link must be an
 * http(s) URL (a shared plan file could otherwise carry a data: / file: / protocol-handler link that runs on
 * click); an image URL that isn't one is dropped.
 */
export function normalizeProduct(v: unknown): ProductCandidate | undefined {
  if (!isObj(v) || typeof v.name !== "string") return undefined;
  const url = httpUrl(v.url);
  if (!url) return undefined;
  const d = dims(v.dims) ?? { w: 0.5, h: 0.5, d: 0.5 };
  const colors: ColorSwatch[] = Array.isArray(v.colors)
    ? v.colors.flatMap((c) => {
        const hex = isObj(c) ? validHex(c.hex) : null;
        return hex ? [{ name: str((c as Record<string, unknown>).name, hex), hex }] : [];
      })
    : [];
  const p: ProductCandidate = {
    id: str(v.id, newId("prod")),
    name: v.name,
    retailer: str(v.retailer, ""),
    url,
    dims: d,
    dimsSource: v.dimsSource === "listed" ? "listed" : "estimated",
    colors,
    style: strList(v.style),
    materials: strList(v.materials),
    mount: oneOf(v.mount, MOUNTS, "floor"),
    parts: normalizeParts(v.parts),
  };
  if (isNum(v.price)) p.price = v.price;
  if (typeof v.currency === "string") p.currency = v.currency;
  const imageUrl = httpUrl(v.imageUrl);
  if (imageUrl) p.imageUrl = imageUrl;
  for (const key of ["dimsText", "origin", "summary"] as const) {
    if (typeof v[key] === "string") p[key] = v[key] as string;
  }
  return p;
}

/** A usable item, or null when the essentials (id, finite position, positive dims) are missing. */
export function normalizeItem(v: unknown): PlacedItem | null {
  if (!isObj(v) || typeof v.id !== "string" || !v.id) return null;
  const position = vec3(v.position);
  const d = dims(v.dims);
  if (!position || !d) return null;
  const item: PlacedItem = {
    id: v.id,
    name: str(v.name, "Item"),
    position,
    rotationY: isNum(v.rotationY) ? v.rotationY : 0,
    dims: d,
    color: validHex(v.color) ?? "#999999",
    mount: oneOf(v.mount, MOUNTS, "floor"),
    parts: normalizeParts(v.parts),
    origin: oneOf(v.origin, ORIGINS, "shape"),
  };
  const product = normalizeProduct(v.product);
  if (product) item.product = product;
  if (v.hidden === true) item.hidden = true;
  if (v.locked === true) item.locked = true;
  if (typeof v.supportId === "string" && v.supportId && v.supportId !== v.id && item.mount === "floor") item.supportId = v.supportId;
  // Which surface of the support (a cat tower's platform, 0 = under it); only with a support.
  if (item.supportId && typeof v.supportSurfaceY === "number" && Number.isFinite(v.supportSurfaceY) && v.supportSurfaceY >= 0 && v.supportSurfaceY <= 100) {
    item.supportSurfaceY = v.supportSurfaceY;
  }
  if (typeof v.droppedFromId === "string" && v.droppedFromId && v.droppedFromId !== v.id && item.mount === "floor") item.droppedFromId = v.droppedFromId;
  if (item.droppedFromId && typeof v.droppedSurfaceY === "number" && Number.isFinite(v.droppedSurfaceY) && v.droppedSurfaceY >= 0 && v.droppedSurfaceY <= 100) {
    item.droppedSurfaceY = v.droppedSurfaceY;
  }
  // Lights: kept when valid; lamp-like items saved before lighting existed get a default one.
  const light = normalizeLight(v.light) ?? autoLight({ name: item.name });
  if (light) item.light = light;
  return item;
}

/** Drop supportIds that point at a missing item (stacking is re-checked by the store when a plan is loaded). */
export function dropDanglingSupports(items: PlacedItem[]): PlacedItem[] {
  const ids = new Set(items.map((it) => it.id));
  for (const it of items) {
    if (it.supportId && !ids.has(it.supportId)) delete it.supportId;
    if (!it.supportId) delete it.supportSurfaceY;
    if (it.droppedFromId && !ids.has(it.droppedFromId)) delete it.droppedFromId;
    if (!it.droppedFromId) delete it.droppedSurfaceY;
  }
  return items;
}

function normalizeOpening(v: unknown): Opening | null {
  if (!isObj(v)) return null;
  if (![v.offset, v.width, v.height, v.sill].every(isNum) || !((v.width as number) > 0 && (v.height as number) > 0)) return null;
  const kind = v.kind === "window" ? "window" : v.kind === "door" ? "door" : null;
  if (!kind) return null;
  return {
    id: str(v.id, newId(kind === "door" ? "door" : "win")),
    kind,
    wall: oneOf(v.wall, WALLS, kind === "door" ? "south" : "north"),
    offset: v.offset as number,
    width: v.width as number,
    height: v.height as number,
    sill: Math.max(0, v.sill as number),
    ...(kind === "window" && v.covering === "closed" ? { covering: "closed" as const } : {}),
  };
}

/** A usable room, or null when width/depth/height aren't positive numbers. */
export function normalizeRoom(v: unknown): Room | null {
  if (!isObj(v) || ![v.width, v.depth, v.height].every((n) => isNum(n) && n > 0)) return null;
  const base = defaultRoom();
  return {
    name: str(v.name, base.name),
    width: v.width as number,
    depth: v.depth as number,
    height: v.height as number,
    wallColor: validHex(v.wallColor) ?? base.wallColor,
    floorColor: validHex(v.floorColor) ?? base.floorColor,
    openings: Array.isArray(v.openings) ? v.openings.map(normalizeOpening).filter((o): o is Opening => o !== null) : [],
    ...(v.lighting === "evening" || v.lighting === "night" || v.lighting === "day" ? { lighting: v.lighting } : {}),
  };
}

/**
 * Parse an exported plan file. Throws (with a readable message) when the room or any item lacks its
 * essentials; everything else (rotation, mount, parts, colors, openings) is normalized.
 */
export function parsePlannerFile(json: string): { room: Room; items: PlacedItem[] } {
  const data: unknown = JSON.parse(json);
  if (!isObj(data) || !isObj(data.room) || !Array.isArray(data.items)) {
    throw new Error("Not a Room Planner file (missing room/items).");
  }
  const room = normalizeRoom(data.room);
  if (!room) throw new Error("Invalid room: width, depth and height must be positive numbers.");
  const items = data.items.map((raw) => {
    const it = normalizeItem(raw);
    if (!it) throw new Error("Invalid item in file (needs id, position, dims and parts).");
    return it;
  });
  const ids = new Set<string>();
  for (const it of items) {
    if (ids.has(it.id)) it.id = newId("item");
    ids.add(it.id);
  }
  return { room, items: dropDanglingSupports(items) };
}

/** Rehydrated (localStorage) state: invalid items are dropped instead of crashing every reload. */
export function normalizePersisted(v: unknown): { room?: Room; items?: PlacedItem[]; units?: "imperial" | "metric" } {
  if (!isObj(v)) return {};
  const out: { room?: Room; items?: PlacedItem[]; units?: "imperial" | "metric" } = {};
  const room = normalizeRoom(v.room);
  if (room) out.room = room;
  if (Array.isArray(v.items)) out.items = dropDanglingSupports(v.items.map(normalizeItem).filter((it): it is PlacedItem => it !== null));
  if (v.units === "imperial" || v.units === "metric") out.units = v.units;
  return out;
}
