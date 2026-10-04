// Shared contract between the browser app and the local API server.
// All lengths are METERS. Angles are RADIANS.
//
// Coordinate system (three.js, Y up):
//   The room is centered on the origin. Floor is y = 0.
//   x ∈ [-width/2, +width/2], z ∈ [-depth/2, +depth/2], y ∈ [0, height].
//   Walls: north = back wall at z = -depth/2, south = front wall at z = +depth/2,
//          west = left wall at x = -width/2, east = right wall at x = +width/2.

export type WallSide = "north" | "south" | "east" | "west";
export type Mount = "floor" | "wall" | "ceiling";
export type ShapeKind = "box" | "cylinder" | "sphere" | "cone";
export type Units = "imperial" | "metric";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Bounding-box size of an item before rotation. w = along x, h = along y, d = along z. */
export interface Dims {
  w: number;
  h: number;
  d: number;
}

/** A door or window cut into a wall. */
export interface Opening {
  id: string;
  kind: "door" | "window";
  wall: WallSide;
  /**
   * Distance along the wall from the wall's MIN end to the opening's CENTER.
   * north/south walls run along x (min end = x = -width/2);
   * east/west walls run along z (min end = z = -depth/2).
   */
  offset: number;
  width: number;
  height: number;
  /** Height of the opening's bottom edge above the floor (0 for doors). */
  sill: number;
  /** (Additive, windows only) Curtains/blinds: "closed" blocks daylight. Default "open". */
  covering?: "open" | "closed";
}

export interface Room {
  name: string;
  width: number; // x
  depth: number; // z
  height: number; // y
  wallColor: string; // hex "#rrggbb"
  floorColor: string; // hex
  openings: Opening[];
  /** (Additive) Lighting mode. Default "day". */
  lighting?: LightingMode;
}

export type LightingMode = "day" | "evening" | "night";

/** (Additive) A light-emitting item (lamp, pendant, sconce...). */
export interface LightSettings {
  on: boolean;
  /** Hex light color; warm white ~#ffd8a8. */
  color: string;
  /** 0..1 UI brightness scale (the scene maps it to a physical intensity). */
  intensity: number;
}

/**
 * One primitive inside an item. Expressed in FRACTIONS of the item's bounding box so that
 * resizing an item scales its parts automatically.
 *   center.x, center.z ∈ [-0.5, 0.5] (0 = middle), center.y ∈ [0, 1] (0 = bottom of bbox)
 *   size.* ∈ (0, 1] (1 = full bbox extent on that axis)
 * A cylinder/cone's circular cross-section lies in the x/z plane and is scaled to size.x × size.z.
 * A sphere is scaled to an ellipsoid of size.x × size.y × size.z.
 */
export interface ShapePart {
  kind: ShapeKind;
  center: Vec3;
  size: Vec3;
  color?: string; // hex; falls back to the item's color
}

export interface ColorSwatch {
  name: string;
  hex: string;
}

/** A real product found online. */
export interface ProductCandidate {
  id: string;
  name: string;
  retailer: string;
  url: string;
  price?: number;
  currency?: string; // ISO code, e.g. "USD"
  imageUrl?: string;
  dims: Dims;
  /** "listed" = dims came from the product page; "estimated" = AI guessed them. */
  dimsSource: "listed" | "estimated";
  /** Dimensions as written on the source page, e.g. `24"W x 18"D x 60"H`. */
  dimsText?: string;
  colors: ColorSwatch[];
  /** Style tags, e.g. ["Japanese", "minimalist"] or ["mid-century modern"]. */
  style: string[];
  /** Design origin / country of manufacture, e.g. "Japan", "Denmark (design), made in China". */
  origin?: string;
  materials: string[];
  mount: Mount;
  /** Primitive approximation of the product's silhouette. At least one part. */
  parts: ShapePart[];
  summary?: string;
}

export interface PlacedItem {
  id: string;
  name: string;
  /** Bottom-center of the item's bounding box, in room coordinates. */
  position: Vec3;
  rotationY: number;
  dims: Dims;
  color: string; // hex
  mount: Mount;
  parts: ShapePart[];
  /** "existing" = detected from the user's photos; "shape" = user-added primitive; "product" = from search. */
  origin: "existing" | "shape" | "product";
  product?: ProductCandidate;
  hidden?: boolean;
  locked?: boolean;
  /**
   * (Additive) The item this one rests on (e.g. a monitor on a desk). position.y is then the support's top,
   * and moving the support carries this item along. Only for mount "floor".
   */
  supportId?: string;
  /**
   * (Additive) Set when this item fell off its support because that support was hidden; showing the support again
   * puts it back on top (if it is still standing where it fell). Cleared when the item is moved or placed explicitly.
   */
  droppedFromId?: string;
  /**
   * (Additive) With droppedFromId: the supportSurfaceY the item had on that support before it fell (absent = its top,
   * 0 = under it), so showing the support again puts it back on that same surface (a bin under a desk stays under).
   */
  droppedSurfaceY?: number;
  /**
   * (Additive) Which surface of the support this item rests on, as a height above the support's base
   * (meters, in the support's own frame). Absent = the support's top (support.dims.h). 0 = the floor
   * underneath it (e.g. a bin under a desk); a mid value = an intermediate shelf / platform.
   */
  supportSurfaceY?: number;
  /** (Additive) Present on light-emitting items. */
  light?: LightSettings;
}

/** (Additive) A saved snapshot of the whole design. */
export interface DesignVersion {
  id: string;
  name: string;
  createdAt: number; // epoch ms
  /** true = taken automatically (before a big change); false = saved by the user. */
  auto: boolean;
  reason?: string;
  room: Room;
  items: PlacedItem[];
  /** Small JPEG data URL of the 3D view. */
  thumbnail?: string;
}

// ---------- API ----------

export interface PhotoInput {
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  dataBase64: string; // no data: prefix
}

export interface RoomFromPhotosRequest {
  photos: PhotoInput[]; // 1–3
  /** Optional real-world measurement used to fix the scale, e.g. { label: "ceiling height", meters: 2.44 }. */
  knownMeasurement?: { label: string; meters: number };
  notes?: string;
}

export interface RoomFromPhotosResponse {
  room: Room;
  /** Furniture already in the room, as items with origin "existing". */
  existingItems: PlacedItem[];
  mock: boolean;
  /** Short human-readable notes about the estimate (assumptions, confidence). */
  notes?: string;
}

export interface ProductSearchRequest {
  query: string; // free text, e.g. "hanging paper lantern lamp for a corner, Japanese style"
  mount?: Mount;
  maxPrice?: number;
  style?: string;
  /** Room context so results can be sanity-checked for fit. */
  room?: { width: number; depth: number; height: number };
  /**
   * (Additive) The item the search is for, e.g. a placeholder shape the user blocked out, so results can match
   * its size and spot. `placement` is a short human description such as "in the north-west corner".
   */
  target?: { name: string; mount: Mount; dims: Dims; placement?: string; isProduct?: boolean };
  /**
   * (Additive) Product page URLs to leave out of the results, e.g. the product already in the room when looking
   * for alternatives to it. `target.isProduct` says the target is such a product rather than a placeholder shape.
   */
  excludeUrls?: string[];
  /** (Additive) What is already in the room, so results can match its style and scale. */
  roomItems?: Array<{ name: string; dims: Dims; color: string }>;
  /**
   * (Additive) By default the server reads a budget / mount written in the query ("under $200", "pendant") when
   * maxPrice / mount are unset. true = use the fields exactly as sent (the web app infers them into its form).
   */
  exactFilters?: boolean;
}

export interface ProductSearchResponse {
  candidates: ProductCandidate[];
  mock: boolean;
  notes?: string;
}

export interface HealthResponse {
  ok: true;
  /** "live" = real Claude calls (API key or Claude subscription); "mock" = demo data. */
  mode: "live" | "mock";
  /** (Additive) Which backend serves the AI calls: an API key, the Claude subscription (Agent SDK), or demo data. */
  provider?: "api" | "subscription" | "mock";
}

export interface ApiError {
  error: string;
}

// ---------- Chat (additive) ----------

/** Where to put something, as the chat model describes it. The browser turns this into coordinates. */
export type ChatPlacement =
  | { kind: "center" }
  | { kind: "corner"; corner: "nw" | "ne" | "sw" | "se" }
  /** Against a wall; `along` 0..1 runs from the wall's MIN end (see Opening.offset), 0.5 = middle. */
  | { kind: "wall"; wall: WallSide; along?: number }
  /**
   * Resting on top of another item (desk, nightstand, dresser...). `level` picks a surface on multi-level
   * items (cat tower, bookshelf): "top" (default), "middle", "bottom" (lowest raised surface).
   */
  | { kind: "onTop"; targetId: string; level?: "top" | "middle" | "bottom" }
  /** (Additive) On the floor underneath another item (under a desk / table / bed with clearance). */
  | { kind: "under"; targetId: string }
  /** Beside another item. left/right are from the target's own point of view facing its front (+z). */
  | { kind: "nextTo"; targetId: string; side?: "left" | "right" | "front" | "behind"; gap?: number }
  /** Absolute floor position (meters, room coordinates; bottom-center). */
  | { kind: "at"; x: number; z: number }
  /**
   * (Additive) Off whatever it rests on, onto the floor just in front of the stack it was on ("take the lamp off the
   * nightstand", "put the monitor on the floor"). A wall / ceiling item becomes a floor item.
   */
  | { kind: "floor" };

/**
 * One change the chat asks the app to make. `itemId` may be an existing item id OR the `ref` of an item added
 * earlier in the same response (e.g. addShape ref "lamp1", then move itemId "lamp1").
 * All lengths are meters; colors are hex.
 */
export type ChatAction =
  | {
      type: "addShape";
      ref?: string;
      /** A SHAPE_PRESETS key (box, cylinder, sphere, cone, bed, desk, pendant, frame, ...) to start from. */
      preset?: string;
      name: string;
      dims?: Dims;
      color?: string;
      mount?: Mount;
      /** Custom silhouette (fractions of bbox, see ShapePart). Overrides the preset's parts. */
      parts?: ShapePart[];
      placement?: ChatPlacement;
    }
  | { type: "move"; itemId: string; placement: ChatPlacement }
  | { type: "rotate"; itemId: string; degrees: number; relative?: boolean }
  | { type: "resize"; itemId: string; dims: Partial<Dims> }
  | { type: "recolor"; itemId: string; color: string }
  | { type: "rename"; itemId: string; name: string }
  | { type: "remove"; itemId: string }
  | { type: "duplicate"; itemId: string; ref?: string; placement?: ChatPlacement }
  | {
      type: "setRoom";
      patch: { name?: string; width?: number; depth?: number; height?: number; wallColor?: string; floorColor?: string };
    }
  /** Start a real product search (slow: 1-3 min). Results come back into the chat. */
  | {
      type: "search";
      query: string;
      mount?: Mount;
      maxPrice?: number;
      style?: string;
      /** Placeholder item the product is meant to replace / match. */
      forItemId?: string;
    }
  /** Put result #index (0-based) of the LAST search into the room. */
  | { type: "addCandidate"; index: number; placement?: ChatPlacement; replaceItemId?: string }
  | { type: "previewCandidate"; index: number }
  | { type: "select"; itemId: string }
  | { type: "camera"; preset: "iso" | "top" | "eye" }
  | { type: "undo"; steps?: number }
  // ---- (Additive, round 3) ----
  | { type: "saveVersion"; name?: string }
  | { type: "restoreVersion"; versionId: string }
  | { type: "setLighting"; mode: LightingMode }
  /** Turn a light-emitting item on/off or change it; giving any field to an item without a light adds one. */
  | { type: "setLight"; itemId: string; on?: boolean; intensity?: number; color?: string }
  /** Open/close a window's curtains. openingId "*" = every window. */
  | { type: "setWindow"; openingId: string; covering: "open" | "closed" }
  /** Hang an item from the ceiling; drop = distance from the ceiling down to the item's bottom (meters). */
  | { type: "hang"; itemId: string; drop?: number }
  /** (Additive) Hide an item from the 3D view (it stays in the plan) or show it again. */
  | { type: "setHidden"; itemId: string; hidden: boolean }
  /** (Additive) Change how an item is mounted (e.g. hang a mirror on the wall); the app re-places it. */
  | { type: "setMount"; itemId: string; mount: Mount }
  /** (Additive) Height of a wall item's BOTTOM edge above the floor, meters ("hang the art at 5 ft"). */
  | { type: "setHeight"; itemId: string; bottom: number }
  /**
   * (Additive) Add, change or remove a door / window. `openingId` is an id from scene.room.openings (update /
   * remove). Fields left out keep their value (update) or get a sensible default (add).
   */
  | {
      type: "setOpening";
      op: "add" | "update" | "remove";
      openingId?: string;
      kind?: Opening["kind"];
      wall?: WallSide;
      /** Distance along the wall from its MIN end to the opening's center (see Opening.offset). */
      offset?: number;
      width?: number;
      height?: number;
      sill?: number;
    };

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Compact scene description sent with every chat message. */
export interface ChatScene {
  units: Units;
  room: Pick<Room, "name" | "width" | "depth" | "height" | "wallColor" | "floorColor" | "openings">;
  items: Array<{
    id: string;
    name: string;
    dims: Dims;
    position: Vec3;
    rotationY: number;
    mount: Mount;
    color: string;
    origin: PlacedItem["origin"];
    supportId?: string;
    /** (Additive) see PlacedItem.supportSurfaceY */
    supportSurfaceY?: number;
    hidden?: boolean;
    product?: { name: string; retailer: string; price?: number; url: string };
    /** (Additive) */
    light?: LightSettings;
    /**
     * (Additive) The raised surfaces of a multi-level item (2+ raised surfaces, e.g. a cat tower), highest first, as
     * onTop.level names them: "top", "middle level", "bottom level" (others "level"); y = meters above its base;
     * kind "platform" (a thin shelf / perch) or "box" (the roof of a solid part, e.g. a condo box).
     */
    levels?: Array<{ name: string; y: number; kind?: "platform" | "box" }>;
  }>;
  /** (Additive) Current lighting mode. */
  lighting?: LightingMode;
  /**
   * (Additive) Saved design versions, newest first, for "go back to option A": every named version, the newest auto
   * ones and older auto ones thinned to about one per hour (at most ~30). `savedAt` = local clock time, e.g.
   * "Sat 9:41 AM".
   */
  versions?: Array<{ id: string; name: string; createdAt: number; auto: boolean; savedAt?: string }>;
  /** (Additive) The user's local date and time when the message was sent, e.g. "Sat Oct 3, 6:40 PM". */
  now?: string;
  selectedId: string | null;
  /** The last product search's results, so "add the second one" works. */
  lastResults?: Array<{
    index: number;
    name: string;
    retailer: string;
    price?: number;
    dims: Dims;
    mount: Mount;
    style: string[];
    colors: string[];
  }>;
  /**
   * (Additive) What the last product search was for. With `forItemId` (a placeholder / product the search should
   * replace), picking a result ("add the second one") replaces that item unless the user asks for another one.
   */
  lastSearch?: {
    query: string;
    forItemId?: string;
    /**
     * (Additive) Index (into lastResults) of the result the user is previewing as a ghost in the room right now, so
     * "add it" / "this one" means that result.
     */
    previewIndex?: number;
  };
}

export interface ChatRequest {
  message: string;
  /** Previous turns, oldest first (the client sends at most the last ~12). */
  history: ChatTurn[];
  scene: ChatScene;
}

export interface ChatResponse {
  /** Short, friendly reply shown in the chat. */
  reply: string;
  actions: ChatAction[];
  mock: boolean;
  /** (Additive) Steps of the answer that were left out (unknown item, impossible stack...) with a short reason. */
  skipped?: Array<{ type: string; reason: string }>;
}
