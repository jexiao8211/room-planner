// zod schemas: request validation (client → server) and structured model output (Claude → server).
import { z } from "zod";

// ---------- requests ----------

export const PhotoInputSchema = z.object({
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  dataBase64: z
    .string()
    .min(16, "photo data is empty")
    .refine((s) => !s.startsWith("data:"), "dataBase64 must not include a data: prefix")
    .refine((s) => /^[A-Za-z0-9+/=\r\n]+$/.test(s.slice(0, 2048)), "dataBase64 is not base64"),
});

export const RoomFromPhotosRequestSchema = z.object({
  photos: z.array(PhotoInputSchema).min(1, "at least one photo is required").max(3, "at most 3 photos"),
  knownMeasurement: z
    .object({
      label: z.string().trim().min(1).max(120),
      meters: z.number().positive().max(100),
    })
    .optional(),
  notes: z.string().max(2000).optional(),
});

const DimsIn = z.object({
  w: z.number().positive().max(100),
  h: z.number().positive().max(100),
  d: z.number().positive().max(100),
});

export const ProductSearchRequestSchema = z.object({
  query: z.string().trim().min(2, "query is too short").max(500),
  mount: z.enum(["floor", "wall", "ceiling"]).optional(),
  maxPrice: z.number().positive().max(1_000_000).optional(),
  style: z.string().trim().max(120).optional(),
  room: z
    .object({
      width: z.number().positive().max(100),
      depth: z.number().positive().max(100),
      height: z.number().positive().max(100),
    })
    .optional(),
  target: z
    .object({
      name: z.string().trim().min(1).max(120),
      mount: z.enum(["floor", "wall", "ceiling"]),
      dims: DimsIn,
      placement: z.string().trim().max(120).optional(),
      isProduct: z.boolean().optional(),
    })
    .optional(),
  excludeUrls: z.array(z.string().max(2000)).max(20).optional(),
  roomItems: z
    .array(z.object({ name: z.string().trim().min(1).max(120), dims: DimsIn, color: z.string().max(20) }))
    .max(60)
    .optional(),
  exactFilters: z.boolean().optional(),
});

/** First zod issue as a one-line message, e.g. "photos: at least one photo is required". */
export function zodMessage(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "Invalid request body";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

// ---------- model output ----------
// Kept loose on purpose (no numeric bounds, no enums): structured outputs can't enforce bounds, and the SDK's
// schema transform turns z.enum into description text only, so a strict local enum would make one off-list
// value (e.g. mount "tabletop") throw away the whole answer. Allowed values are listed in the descriptions;
// sanitize.ts normalizes case and falls back for anything else.
// Each Vec3 is a fresh inline object (not a shared schema): a reused schema becomes a $ref, and the SDK drops
// descriptions that sit next to a $ref, so the model would never see the conventions below.

const oneOf = (values: readonly string[], what: string) => z.string().describe(`${what}. One of: ${values.join(", ")}.`);

const vec3Out = (description: string) => z.object({ x: z.number(), y: z.number(), z: z.number() }).describe(description);

const shapePartOut = () =>
  z.object({
    kind: oneOf(["box", "cylinder", "sphere", "cone"], "Primitive kind"),
    center: vec3Out("Fractions of the bbox: x,z in [-0.5,0.5] (0 = middle), y in [0,1] (0 = bottom). This is the part's CENTER."),
    size: vec3Out("Fractions of the bbox in (0,1]; 1 = full extent on that axis."),
    color: z.string().nullable().describe("Hex #rrggbb, or null to use the item's color."),
  });

const dimsOut = () =>
  z.object({
    w: z.number().describe("meters along x (width)"),
    h: z.number().describe("meters along y (height)"),
    d: z.number().describe("meters along z (depth)"),
  });

const WALLS = ["north", "south", "east", "west"] as const;
const MOUNTS = ["floor", "wall", "ceiling"] as const;

export const RoomEstimateSchema = z.object({
  room: z.object({
    name: z.string(),
    width: z.number().describe("meters, x extent (west→east)"),
    depth: z.number().describe("meters, z extent (north→south)"),
    height: z.number().describe("meters, floor to ceiling"),
    wallColor: z.string().describe("#rrggbb"),
    floorColor: z.string().describe("#rrggbb"),
  }),
  photos: z.array(
    z.object({
      photoIndex: z.number().describe("1-based index of the photo in the order given"),
      facingWall: z.string().nullable().describe(`Wall the camera is looking at (one of: ${WALLS.join(", ")}), or null if not inferable`),
      note: z.string(),
    }),
  ),
  openings: z.array(
    z.object({
      kind: oneOf(["door", "window"], "Opening kind"),
      wall: oneOf(WALLS, "Wall the opening is in"),
      offset: z.number().describe("meters from the wall's MIN end to the opening CENTER"),
      width: z.number(),
      height: z.number(),
      sill: z.number().describe("meters from floor to the opening's bottom edge (0 for doors)"),
    }),
  ),
  items: z.array(
    z.object({
      name: z.string(),
      dims: dimsOut(),
      mount: oneOf(MOUNTS, "How the item is mounted"),
      color: z.string().describe("dominant color #rrggbb"),
      position: vec3Out("Bottom-center of the bbox in room coordinates (meters). y = 0 for floor items."),
      rotationYDegrees: z.number().describe("Rotation about the vertical axis in degrees; 0 = front faces +z (south)."),
      parts: z.array(shapePartOut()),
    }),
  ),
  knownMeasurementEstimateMeters: z
    .number()
    .nullable()
    .describe(
      "The size (meters) of the object/distance the user gave a known measurement for, as it is IN THIS ANSWER (after you applied the known value). null if none was given.",
    ),
  confidence: oneOf(["low", "medium", "high"], "Overall confidence"),
  notes: z.string().describe("2-4 short sentences: key assumptions and how confident you are."),
});
export type RoomEstimate = z.infer<typeof RoomEstimateSchema>;

export const ProductListSchema = z.object({
  candidates: z.array(
    z.object({
      name: z.string(),
      retailer: z.string(),
      url: z.string().describe("Exact product page URL from the research report"),
      price: z.number().nullable(),
      currency: z.string().nullable().describe("ISO 4217 code, e.g. USD"),
      imageUrl: z.string().nullable(),
      dims: dimsOut(),
      dimsSource: oneOf(["listed", "estimated"], "Where dims came from"),
      dimsText: z.string().nullable().describe("Dimensions exactly as written on the listing"),
      colors: z.array(z.object({ name: z.string(), hex: z.string() })),
      style: z.array(z.string()),
      origin: z.string().nullable(),
      materials: z.array(z.string()),
      mount: oneOf(MOUNTS, "How the product is mounted"),
      parts: z.array(shapePartOut()),
      summary: z.string().nullable(),
    }),
  ),
  notes: z.string().describe("One or two sentences for the user (e.g. what was hard to find)."),
});
export type ProductList = z.infer<typeof ProductListSchema>;

// ---------- chat ----------

/** Request-size limits for POST /api/chat (and the sanitizer's action cap). */
export const CHAT_LIMITS = {
  message: 4000,
  history: 20,
  turnChars: 8000,
  items: 300,
  openings: 40,
  results: 20,
  actions: 20,
  versions: 50,
} as const;

const MountIn = z.enum(["floor", "wall", "ceiling"]);
const Vec3In = z.object({ x: z.number(), y: z.number(), z: z.number() });
const SizeIn = z.number().positive().max(100);
const ChatDimsIn = z.object({ w: SizeIn, h: SizeIn, d: SizeIn });

const ChatOpeningIn = z.object({
  id: z.string().max(120),
  kind: z.enum(["door", "window"]),
  wall: z.enum(["north", "south", "east", "west"]),
  offset: z.number(),
  width: z.number().nonnegative().max(100),
  height: z.number().nonnegative().max(100),
  sill: z.number().max(100),
  covering: z.enum(["open", "closed"]).optional(),
});

const ChatItemIn = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().max(200),
  dims: ChatDimsIn,
  position: Vec3In,
  rotationY: z.number(),
  mount: MountIn,
  color: z.string().max(20),
  origin: z.enum(["existing", "shape", "product"]),
  supportId: z.string().max(120).optional(),
  supportSurfaceY: z.number().min(0).max(100).optional(),
  hidden: z.boolean().optional(),
  light: z.object({ on: z.boolean(), color: z.string().max(20), intensity: z.number().min(0).max(1) }).optional(),
  /** (Additive) Raised levels of a multi-level item (cat tower). */
  levels: z
    .array(z.object({ name: z.string().max(40), y: z.number().min(0).max(100), kind: z.enum(["platform", "box"]).optional() }))
    .max(12)
    .optional(),
  product: z
    .object({
      name: z.string().max(300),
      retailer: z.string().max(200),
      price: z.number().nonnegative().optional(),
      url: z.string().max(2000),
    })
    .optional(),
});

const ChatResultIn = z.object({
  index: z.number().int().nonnegative().max(100),
  name: z.string().max(300),
  retailer: z.string().max(200),
  price: z.number().nonnegative().optional(),
  dims: ChatDimsIn,
  mount: MountIn,
  style: z.array(z.string().max(60)).max(10).default([]),
  colors: z.array(z.string().max(60)).max(10).default([]),
});

export const ChatRequestSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, "message is empty")
    .max(CHAT_LIMITS.message, `message is too long (max ${CHAT_LIMITS.message} characters)`),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(CHAT_LIMITS.turnChars) }))
    .max(CHAT_LIMITS.history, `history is too long (max ${CHAT_LIMITS.history} turns)`)
    .default([]),
  scene: z.object({
    units: z.enum(["imperial", "metric"]).default("imperial"),
    room: z.object({
      name: z.string().max(120),
      width: SizeIn,
      depth: SizeIn,
      height: SizeIn,
      wallColor: z.string().max(20),
      floorColor: z.string().max(20),
      openings: z.array(ChatOpeningIn).max(CHAT_LIMITS.openings).default([]),
    }),
    items: z.array(ChatItemIn).max(CHAT_LIMITS.items, `too many items in the scene (max ${CHAT_LIMITS.items})`).default([]),
    selectedId: z
      .string()
      .max(120)
      .nullish()
      .transform((v) => v ?? null),
    lastResults: z.array(ChatResultIn).max(CHAT_LIMITS.results).optional(),
    lighting: z.enum(["day", "evening", "night"]).optional(),
    lastSearch: z
      .object({
        query: z.string().max(500),
        forItemId: z.string().max(120).optional(),
        previewIndex: z.number().int().nonnegative().max(100).optional(),
      })
      .optional(),
    /** (Additive) Saved design versions, newest first. */
    versions: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(120),
          name: z.string().max(200),
          createdAt: z.number(),
          auto: z.boolean(),
          /** (Additive) Local clock time it was saved, e.g. "Sat, Oct 3, 9:41 AM". */
          savedAt: z.string().max(60).optional(),
        }),
      )
      .max(CHAT_LIMITS.versions)
      .optional(),
    /** (Additive) The user's local date and time. */
    now: z.string().max(60).optional(),
  }),
});

// Chat model output. Shaped for structured outputs' documented limits (at most 24 optional properties and 16
// union-typed properties across the schema; no numeric / length / maxItems constraints; anyOf but not oneOf):
// - one anyOf for the action list plus one per placement field (4); nothing is nullable;
// - fields that would otherwise be optional use "keep" sentinels (resize dims 0, setRoom 0 / ""), and
//   rotate.relative / undo.steps are required;
// - every nested object is a fresh schema (no $ref, which would drop the descriptions next to it).
// The answer is checked field by field in sanitizeChat.ts, never trusted as-is (the API SDK turns `const` into
// description text, so even an action's "type" is only a strong hint there).

const placementOut = (description: string) =>
  z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("center") }),
      z.object({ kind: z.literal("corner"), corner: oneOf(["nw", "ne", "sw", "se"], "Corner (n = north/back, w = west/left)") }),
      z.object({
        kind: z.literal("wall"),
        wall: oneOf(WALLS, "Wall to stand against (floor items) or hang on (wall items)"),
        along: z
          .number()
          .describe(
            "0..1 along the wall from its MIN end (west end of north/south, north end of east/west); 0.5 = middle. -1 = let the app pick the free spot nearest the middle. A taken spot is shifted to the nearest free one",
          ),
      }),
      z.object({
        kind: z.literal("onTop"),
        targetId: z.string().describe("Item id from the scene, or a ref added earlier in this answer"),
        level: oneOf(
          ["top", "middle", "bottom"],
          "Which surface of a multi-level item (cat tower, shelf): top (usual), middle, or bottom = its lowest raised surface",
        ),
      }),
      z.object({
        kind: z.literal("under"),
        targetId: z.string().describe("Item id from the scene, or a ref added earlier in this answer"),
      }).describe("On the floor underneath the target, between its legs (a bin under a desk); it moves with the target"),
      z.object({
        kind: z.literal("nextTo"),
        targetId: z.string().describe("Item id from the scene, or a ref added earlier in this answer"),
        side: oneOf(["left", "right", "front", "behind", "any"], "Side of the target, from the target's own point of view (any = first free side)"),
        gap: z.number().describe("meters between the two items, usually 0.05"),
      }),
      z.object({ kind: z.literal("at"), x: z.number().describe("meters, room coordinates"), z: z.number().describe("meters, room coordinates") }),
      z.object({ kind: z.literal("floor") }).describe("Off whatever it rests on, onto the floor in front of that stack"),
    ])
    .describe(description);

const chatPartOut = () =>
  z.object({
    kind: oneOf(["box", "cylinder", "sphere", "cone"], "Primitive kind"),
    center: z.object({ x: z.number(), y: z.number(), z: z.number() }).describe("Part CENTER as fractions of the bbox: x,z in [-0.5,0.5], y in [0,1] (0 = bottom)"),
    size: z.object({ x: z.number(), y: z.number(), z: z.number() }).describe("Fractions of the bbox in (0,1]"),
    color: z.string().describe("Hex #rrggbb; omit to use the item's color").optional(),
  });

const itemIdOut = () => z.string().describe("Item id from the scene, or a ref added earlier in this answer");

/** One variant per ChatAction type, keyed by type. */
export const CHAT_ACTION_OUT = {
  addShape: z.object({
    type: z.literal("addShape"),
    ref: z.string().describe('Short handle (e.g. "desk1") so later actions in this answer can refer to the new item').optional(),
    preset: z.string().describe("Shape preset key to start from (see the system prompt)").optional(),
    name: z.string().describe('Display name, e.g. "Desk"'),
    dims: z.object({ w: z.number(), h: z.number(), d: z.number() }).describe("meters; w along x, h up, d along z").optional(),
    color: z.string().describe("Main color, hex #rrggbb").optional(),
    mount: oneOf(MOUNTS, "How it is mounted").optional(),
    parts: z.array(chatPartOut()).describe("1-6 primitives for a custom silhouette (overrides the preset's parts)").optional(),
    placement: placementOut("Where to put it; omit to let the app pick a free spot").optional(),
  }),
  move: z.object({ type: z.literal("move"), itemId: itemIdOut(), placement: placementOut("Where to move it") }),
  rotate: z.object({
    type: z.literal("rotate"),
    itemId: itemIdOut(),
    degrees: z.number().describe("Degrees about the vertical axis; positive = counter-clockwise seen from above"),
    relative: z.boolean().describe("true = turn by this much; false = set this absolute rotation (0 = front faces south)"),
  }),
  resize: z.object({
    type: z.literal("resize"),
    itemId: itemIdOut(),
    dims: z
      .object({
        w: z.number().describe("meters, or 0 to keep"),
        h: z.number().describe("meters, or 0 to keep"),
        d: z.number().describe("meters, or 0 to keep"),
      })
      .describe("New size; 0 keeps that dimension"),
  }),
  recolor: z.object({ type: z.literal("recolor"), itemId: itemIdOut(), color: z.string().describe("Hex #rrggbb") }),
  rename: z.object({ type: z.literal("rename"), itemId: itemIdOut(), name: z.string() }),
  remove: z.object({ type: z.literal("remove"), itemId: itemIdOut() }),
  duplicate: z.object({
    type: z.literal("duplicate"),
    itemId: itemIdOut(),
    ref: z.string().describe("Handle for the copy").optional(),
    placement: placementOut("Where to put the copy; omit for next to the original").optional(),
  }),
  setRoom: z.object({
    type: z.literal("setRoom"),
    patch: z
      .object({
        name: z.string().describe('New room name, or "" to keep'),
        width: z.number().describe("meters (x, west-east), or 0 to keep"),
        depth: z.number().describe("meters (z, north-south), or 0 to keep"),
        height: z.number().describe("meters, or 0 to keep"),
        wallColor: z.string().describe('Hex #rrggbb, or "" to keep'),
        floorColor: z.string().describe('Hex #rrggbb, or "" to keep'),
      })
      .describe('Room changes; 0 / "" keep the current value'),
  }),
  search: z.object({
    type: z.literal("search"),
    query: z.string().describe('What to shop for, in plain words, e.g. "Japanese paper pendant lamp"'),
    mount: oneOf(MOUNTS, "Mount filter").optional(),
    maxPrice: z.number().describe("USD").optional(),
    style: z.string().optional(),
    forItemId: z.string().describe("Placeholder item the product should replace / match").optional(),
  }),
  addCandidate: z.object({
    type: z.literal("addCandidate"),
    index: z.number().describe("0-based index into the scene's lastResults"),
    placement: placementOut("Where to put it").optional(),
    replaceItemId: z.string().describe("Item the product replaces (it takes that item's spot)").optional(),
  }),
  previewCandidate: z.object({ type: z.literal("previewCandidate"), index: z.number().describe("0-based index into lastResults") }),
  select: z.object({ type: z.literal("select"), itemId: itemIdOut() }),
  camera: z.object({ type: z.literal("camera"), preset: oneOf(["iso", "top", "eye"], "Camera view") }),
  undo: z.object({ type: z.literal("undo"), steps: z.number().describe("How many steps to undo, usually 1") }),
  setHidden: z.object({
    type: z.literal("setHidden"),
    itemId: itemIdOut(),
    hidden: z.boolean().describe("true = hide it from the view (it stays in the plan), false = show it again"),
  }),
  setMount: z.object({ type: z.literal("setMount"), itemId: itemIdOut(), mount: oneOf(MOUNTS, "New mount; the app re-places the item") }),
  setHeight: z.object({
    type: z.literal("setHeight"),
    itemId: itemIdOut(),
    bottom: z.number().describe("Wall items only: meters from the floor to the item's BOTTOM edge"),
  }),
  setOpening: z.object({
    type: z.literal("setOpening"),
    op: oneOf(["add", "update", "remove"], "What to do"),
    openingId: z.string().describe('Opening id from scene.room.openings (update / remove), "" when adding'),
    kind: oneOf(["door", "window"], "Door or window"),
    wall: oneOf(WALLS, "Wall it is in"),
    offset: z.number().describe("meters from the wall's MIN end to its CENTER, or -1 to keep (add: middle of the wall)"),
    width: z.number().describe("meters, or 0 to keep / default"),
    height: z.number().describe("meters, or 0 to keep / default"),
    sill: z.number().describe("meters from the floor to its bottom edge (doors 0), or -1 to keep / default"),
  }),
  hang: z.object({
    type: z.literal("hang"),
    itemId: itemIdOut(),
    drop: z
      .number()
      .describe(
        "meters from the CEILING down to the item's bottom (for a ceiling item that is its height, dims.h); -1 = keep a hanging item's drop / the app's default",
      ),
  }),
  saveVersion: z.object({
    type: z.literal("saveVersion"),
    name: z.string().describe('Name for the saved version, e.g. "Option A"; "" = the default name ("Version N")'),
  }),
  restoreVersion: z.object({
    type: z.literal("restoreVersion"),
    versionId: z.string().describe("Version id from scene.versions"),
  }),
  setLighting: z.object({ type: z.literal("setLighting"), mode: oneOf(["day", "evening", "night"], "Lighting mode of the whole view") }),
  setLight: z.object({
    type: z.literal("setLight"),
    itemId: itemIdOut(),
    on: oneOf(["on", "off", "keep"], "Switch the light on or off, or keep it as it is"),
    intensity: z.number().describe("Brightness 0..1 (0.7 = normal), or -1 to keep"),
    color: z.string().describe('Light color hex: warm white #ffd8a8, neutral #fff4e6, cool daylight #c8dcff, very warm #ffb062; "" to keep'),
  }),
  setWindow: z.object({
    type: z.literal("setWindow"),
    openingId: z.string().describe('Window id from scene.room.openings, or "*" for every window'),
    covering: oneOf(["open", "closed"], "open = blinds / curtains open (daylight comes in), closed = blinds down"),
  }),
};

export type ChatActionType = keyof typeof CHAT_ACTION_OUT;
export const CHAT_ACTION_TYPES = Object.keys(CHAT_ACTION_OUT) as ChatActionType[];

type ActionVariant = (typeof CHAT_ACTION_OUT)[ChatActionType];
export const ChatActionOutSchema = z.discriminatedUnion("type", Object.values(CHAT_ACTION_OUT) as [ActionVariant, ...ActionVariant[]]);

export const ChatOutputSchema = z.object({
  reply: z.string().describe("1-3 short, friendly sentences for the user"),
  actions: z.array(ChatActionOutSchema).describe("Changes to make, in order (at most 20). Empty when only answering or asking."),
});
export type ChatOutput = z.infer<typeof ChatOutputSchema>;
