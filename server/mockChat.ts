// Demo-mode chat: a deterministic, rule-based parser that turns simple commands into ChatActions. Good enough for a
// demo and for E2E tests; anything it doesn't understand gets a friendly list of examples. Its output goes through
// the same sanitizer as a model's answer.
import type { ChatAction, ChatPlacement, ChatRequest, ChatScene, Dims, Mount, ShapePart, Units, WallSide } from "../src/shared/types";
import { SHAPE_PRESETS } from "../src/lib/presets";
import { STACK_SIZE_RATIO } from "../src/lib/geometry";
import { inferSearchFilters } from "../src/lib/queryFilters";
import { M_PER_FT, M_PER_IN, formatLength } from "../src/lib/units";
import { colorFrom } from "./sanitizeChat";
import { handleLighting } from "./mockLighting";

export interface MockChatResult {
  reply: string;
  actions: ChatAction[];
}

export const MOCK_CHAT_EXAMPLES = [
  "add a desk against the west wall",
  "put a monitor on the desk",
  "move the bed to the north wall",
  "rotate the bed 90",
  "make it red",
  "make the desk 4 ft wide",
  "find a Japanese hanging lamp under $200",
  "add the second one",
  "undo",
  "save this as option A",
  "make it night",
  "turn off the lamp",
  "close the blinds",
];

// ---------- things the parser can add ----------

interface Thing {
  key: string;
  name: string;
  words: RegExp;
  dims: Dims;
  mount: Mount;
  color?: string;
  preset?: string;
  parts?: ShapePart[];
}

const part = (kind: ShapePart["kind"], c: [number, number, number], s: [number, number, number], color?: string): ShapePart => ({
  kind,
  center: { x: c[0], y: c[1], z: c[2] },
  size: { x: s[0], y: s[1], z: s[2] },
  ...(color ? { color } : {}),
});

const legs = (h: number, w = 0.06): ShapePart[] =>
  [
    [-0.45, -0.45],
    [0.45, -0.45],
    [-0.45, 0.45],
    [0.45, 0.45],
  ].map(([x, z]) => part("box", [x * (1 - w), h / 2, z * (1 - w)], [w, h, w]));

// Base, a stand that meets the back of the screen, and the screen (item color, so recoloring a monitor shows).
const MONITOR_PARTS: ShapePart[] = [
  part("box", [0, 0.03, 0], [0.4, 0.06, 0.9]),
  part("box", [0, 0.25, 0], [0.06, 0.4, 0.1]),
  part("box", [0, 0.65, 0.1], [1, 0.7, 0.12]),
];
const TABLE_LAMP_PARTS: ShapePart[] = [
  part("cylinder", [0, 0.04, 0], [0.5, 0.08, 0.5], "#444444"),
  part("cylinder", [0, 0.35, 0], [0.08, 0.6, 0.08], "#444444"),
  part("cone", [0, 0.8, 0], [1, 0.4, 1]),
];
const FLOOR_LAMP_PARTS: ShapePart[] = [
  part("cylinder", [0, 0.01, 0], [0.6, 0.02, 0.6], "#333333"),
  part("cylinder", [0, 0.45, 0], [0.06, 0.86, 0.06], "#333333"),
  part("cylinder", [0, 0.89, 0], [1, 0.2, 1]),
];

const presetThing = (key: string, name: string, words: RegExp): Thing => {
  const p = SHAPE_PRESETS.find((x) => x.key === key)!;
  return { key, name, words, dims: p.dims, mount: p.mount, color: p.color, preset: key };
};

/**
 * The thing whose words END last in a phrase wins (the head noun: "desk chair" is a chair, "TV stand" a stand); on a
 * tie the earlier, more specific entry wins ("table lamp" before "lamp").
 */
const THINGS: Thing[] = [
  presetThing("pendant", "Hanging lamp", /\b(?:hanging|pendant|ceiling)\s+(?:lamps?|lights?)\b|\bpendants?\b|\bchandeliers?\b/),
  { key: "tableLamp", name: "Table lamp", words: /\b(?:table|desk|bedside|reading)\s+lamps?\b/, dims: { w: 0.3, h: 0.5, d: 0.3 }, mount: "floor", color: "#f2e6c9", parts: TABLE_LAMP_PARTS },
  { key: "floorLamp", name: "Floor lamp", words: /\b(?:floor|standing)\s+lamps?\b/, dims: { w: 0.4, h: 1.6, d: 0.4 }, mount: "floor", color: "#f2e6c9", parts: FLOOR_LAMP_PARTS },
  { key: "lamp", name: "Lamp", words: /\blamps?\b/, dims: { w: 0.4, h: 1.6, d: 0.4 }, mount: "floor", color: "#f2e6c9", parts: FLOOR_LAMP_PARTS },
  { key: "monitor", name: "Monitor", words: /\b(?:monitors?|screens?|displays?)\b/, dims: { w: 0.6, h: 0.4, d: 0.2 }, mount: "floor", color: "#2b2b2b", parts: MONITOR_PARTS },
  { key: "console", name: "TV stand", words: /\b(?:tv|television|media)\s+(?:stands?|consoles?|units?|cabinets?)\b|\b(?:consoles?|sideboards?|credenzas?)\b/, dims: { w: 1.5, h: 0.5, d: 0.4 }, mount: "floor", color: "#8b6f4e", parts: [part("box", [0, 0.55, 0], [1, 0.9, 1]), ...legs(0.1)] },
  { key: "tv", name: "TV", words: /\b(?:tvs?|televisions?)\b/, dims: { w: 1.25, h: 0.78, d: 0.25 }, mount: "floor", color: "#2b2b2b", parts: MONITOR_PARTS },
  { key: "laptop", name: "Laptop", words: /\blaptops?\b/, dims: { w: 0.33, h: 0.22, d: 0.24 }, mount: "floor", color: "#9a9a9a", parts: [part("box", [0, 0.03, 0.05], [1, 0.06, 0.9]), part("box", [0, 0.55, -0.45], [1, 0.9, 0.06], "#222222")] },
  presetThing("desk", "Desk", /\b(?:desks?|work\s*stations?)\b/),
  { key: "nightstand", name: "Nightstand", words: /\b(?:night\s*stands?|bedside\s+tables?|night\s+tables?)\b/, dims: { w: 0.5, h: 0.6, d: 0.4 }, mount: "floor", color: "#8b6f4e", parts: [part("box", [0, 0.6, 0], [1, 0.8, 1]), ...legs(0.2)] },
  presetThing("bed", "Bed", /\b(?:(?:queen|king|double|twin)\s+)?beds?\b/),
  { key: "coffeeTable", name: "Coffee table", words: /\bcoffee\s+tables?\b/, dims: { w: 1.1, h: 0.45, d: 0.6 }, mount: "floor", color: "#9c7b57", parts: [part("box", [0, 0.93, 0], [1, 0.14, 1]), ...legs(0.86)] },
  { key: "table", name: "Table", words: /\b(?:dining\s+|kitchen\s+)?tables?\b/, dims: { w: 1.6, h: 0.75, d: 0.9 }, mount: "floor", color: "#9c7b57", parts: [part("box", [0, 0.96, 0], [1, 0.08, 1]), ...legs(0.92)] },
  { key: "armchair", name: "Armchair", words: /\barm\s*chairs?\b/, dims: { w: 0.8, h: 0.9, d: 0.8 }, mount: "floor", color: "#7d8b99", parts: [part("box", [0, 0.25, 0.05], [1, 0.5, 0.9]), part("box", [0, 0.7, -0.42], [1, 0.6, 0.16]), part("box", [-0.42, 0.6, 0.05], [0.16, 0.3, 0.9]), part("box", [0.42, 0.6, 0.05], [0.16, 0.3, 0.9])] },
  { key: "chair", name: "Chair", words: /\b(?:office\s+|desk\s+|dining\s+|gaming\s+)?chairs?\b|\bstools?\b/, dims: { w: 0.5, h: 0.9, d: 0.5 }, mount: "floor", color: "#555555", parts: [part("box", [0, 0.5, 0], [1, 0.08, 1]), part("box", [0, 0.77, -0.45], [1, 0.46, 0.1]), ...legs(0.46)] },
  { key: "sofa", name: "Sofa", words: /\b(?:sofas?|couch(?:es)?|loveseats?)\b/, dims: { w: 2.0, h: 0.85, d: 0.9 }, mount: "floor", color: "#7d8b99", parts: [part("box", [0, 0.25, 0.05], [1, 0.5, 0.9]), part("box", [0, 0.7, -0.42], [1, 0.6, 0.16]), part("box", [-0.46, 0.6, 0.05], [0.08, 0.3, 0.9]), part("box", [0.46, 0.6, 0.05], [0.08, 0.3, 0.9])] },
  { key: "wallShelf", name: "Wall shelf", words: /\b(?:wall|floating)\s+shel(?:f|ves)\b/, dims: { w: 0.8, h: 0.2, d: 0.25 }, mount: "wall", color: "#9c7b57", parts: [part("box", [0, 0.1, 0], [1, 0.2, 1])] },
  { key: "bookshelf", name: "Bookshelf", words: /\bbook\s*(?:shel(?:f|ves)|cases?)\b|\bshel(?:f|ves)\b/, dims: { w: 0.8, h: 1.8, d: 0.3 }, mount: "floor", color: "#9c7b57" },
  { key: "dresser", name: "Dresser", words: /\b(?:dressers?|chests? of drawers|drawers)\b/, dims: { w: 1.2, h: 0.8, d: 0.5 }, mount: "floor", color: "#8b6f4e" },
  { key: "wardrobe", name: "Wardrobe", words: /\b(?:wardrobes?|armoires?|closets?)\b/, dims: { w: 1.0, h: 2.0, d: 0.6 }, mount: "floor", color: "#8b6f4e" },
  { key: "rug", name: "Rug", words: /\b(?:rugs?|carpets?|mats?)\b/, dims: { w: 1.6, h: 0.02, d: 2.3 }, mount: "floor", color: "#b9a68a" },
  { key: "plant", name: "Plant", words: /\b(?:plants?|ficus|monsteras?|ferns?)\b/, dims: { w: 0.4, h: 1.0, d: 0.4 }, mount: "floor", color: "#4f7942", parts: [part("cylinder", [0, 0.15, 0], [0.6, 0.3, 0.6], "#a0522d"), part("sphere", [0, 0.65, 0], [1, 0.7, 1])] },
  { key: "mirror", name: "Mirror", words: /\bmirrors?\b/, dims: { w: 0.6, h: 0.9, d: 0.03 }, mount: "wall", color: "#c8d6df" },
  presetThing("frame", "Wall art", /\b(?:wall\s+art|paintings?|posters?|pictures?|(?<!bed\s)frames?|prints?|artworks?)\b/),
  presetThing("cattower", "Cat tower", /\bcat\s*(?:towers?|trees?|condos?|scratchers?)\b/),
  presetThing("cat", "Cat", /\b(?:cats?|kittens?|kitty)\b/),
  { key: "bin", name: "Bin", words: /\b(?:bins?|trash\s*cans?|waste\s*(?:paper\s*)?baskets?|garbage\s*cans?)\b/, dims: { w: 0.3, h: 0.35, d: 0.3 }, mount: "floor", color: "#5a5a5a", parts: [part("cylinder", [0, 0.5, 0], [1, 1, 1])] },
  presetThing("box", "Box", /\b(?:box(?:es)?|cubes?|blocks?)\b/),
  presetThing("cylinder", "Cylinder", /\bcylinders?\b/),
  presetThing("sphere", "Sphere", /\b(?:spheres?|balls?)\b/),
  presetThing("cone", "Cone", /\bcones?\b/),
];

const SMALL_ON_SURFACES = new Set(["monitor", "laptop", "tableLamp", "plant"]);
/** Names of things other things are put on ("move the monitor to the desk" = onto it). */
const SURFACE_WORDS = /\b(?:desks?|tables?|night\s*stands?|dressers?|shel(?:f|ves)|counters?|cabinets?|consoles?|sideboards?|stands?|benches?)\b/;
/** Things you sit at, so "a chair at the desk" goes in front of it. */
const SIT_AT_WORDS = /\b(?:desks?|tables?|vanity|vanities|counters?)\b/;
/** Words that make a request about a vibe or an area rather than one object ("a cozy reading corner"). */
const ABSTRACT_WORDS = /\b(?:corners?|areas?|spaces?|nooks?|zones?|vibes?|feel|looks?|setups?|atmosphere|styles?|cozy|cosy|comfortable|nice|modern|better|nicer|layout|design)\b/;

function thingFor(phrase: string): Thing | null {
  // "a bed with two nightstands" is a bed: only the part before "with" / "and" names the thing.
  const head = phrase.split(/\s+(?:with|and|plus|for)\s+/)[0];
  let best: Thing | null = null;
  let bestEnd = -1;
  for (const t of THINGS) {
    let end = -1;
    for (const m of head.matchAll(new RegExp(t.words.source, "g"))) end = Math.max(end, m.index + m[0].length);
    if (end > bestEnd) {
      best = t;
      bestEnd = end;
    }
  }
  return best;
}

// ---------- parsing helpers ----------

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const UNIT = String.raw`(ft|feet|foot|'|in|inch|inches|"|cm|mm|m|meters?|metres?)?`;

/** Meters for a number + unit. A bare number uses `bare` ("ft" / "in") in imperial, meters (or cm if big) in metric. */
function toMeters(v: number, unit: string | undefined, units: Units, bare: "ft" | "in"): number {
  switch (unit) {
    case "ft":
    case "feet":
    case "foot":
    case "'":
      return v * M_PER_FT;
    case "in":
    case "inch":
    case "inches":
    case '"':
      return v * M_PER_IN;
    case "cm":
      return v / 100;
    case "mm":
      return v / 1000;
    case "m":
    case "meter":
    case "meters":
    case "metre":
    case "metres":
      return v;
    default:
      if (units === "metric") return v < 10 ? v : v / 100;
      return bare === "ft" ? v * M_PER_FT : v * M_PER_IN;
  }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** "4 ft wide", "30 inches tall", "2 m long" → dims (long = the item's longer horizontal side). */
function dimsFromText(lc: string, units: Units, base: Dims | null): Partial<Dims> {
  const out: Partial<Dims> = {};
  const re = new RegExp(String.raw`${NUM}\s*${UNIT}\s*(wide|width|across|tall|high|height|deep|depth|long|length)\b`, "g");
  for (const m of lc.matchAll(re)) {
    const v = toMeters(Number(m[1]), m[2], units, "in");
    const word = m[3];
    if (/wide|width|across/.test(word)) out.w = r3(v);
    else if (/tall|high|height/.test(word)) out.h = r3(v);
    else if (/deep|depth/.test(word)) out.d = r3(v);
    else out[base && base.w >= base.d ? "w" : "d"] = r3(v);
  }
  // "5 by 8 ft" / "5x8" → w × d (bare numbers are feet: nobody says a 5 by 8 inch rug).
  const by = new RegExp(String.raw`${NUM}\s*${UNIT}\s*(?:by|x|×)\s*${NUM}\s*${UNIT}`).exec(lc);
  if (by && out.w === undefined && out.d === undefined) {
    const unit = by[4] ?? by[2];
    out.w = r3(toMeters(Number(by[1]), by[2] ?? unit, units, "ft"));
    out.d = r3(toMeters(Number(by[3]), unit, units, "ft"));
  }
  return out;
}

/** The trailing color of a phrase ("red", "light blue", "#336699"), or null. */
function trailingColor(lc: string): { hex: string; word: string } | null {
  const m = /(?:^|\s)((?:light|dark)\s+)?([a-z]+|#[0-9a-f]{3}(?:[0-9a-f]{3})?)\s*$/.exec(lc);
  if (!m) return null;
  const word = `${m[1] ?? ""}${m[2]}`.trim();
  const hex = colorFrom(word);
  return hex ? { hex, word } : null;
}

/** Any color word inside a phrase ("a red box"). */
function colorIn(lc: string): string | null {
  for (const w of lc.split(/\s+/)) {
    const hex = w.startsWith("#") ? colorFrom(w) : colorFrom(w.replace(/[^a-z]/g, ""));
    if (hex) return hex;
  }
  return null;
}

const ORDINALS: Record<string, number> = {
  first: 0,
  "1st": 0,
  second: 1,
  "2nd": 1,
  third: 2,
  "3rd": 2,
  fourth: 3,
  "4th": 3,
  fifth: 4,
  "5th": 4,
  sixth: 5,
  "6th": 5,
};

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, another: 1, some: 1, two: 2, three: 3, four: 4, pair: 2 };

const title = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

function singular(w: string): string {
  if (w.length > 3 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && /(?:ches|shes|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9#]+/)
    .filter((t) => t && !["the", "a", "an", "my", "of", "that", "this", "your"].includes(t))
    .map(singular);

// ---------- context ----------

interface Entry {
  id: string; // scene id or a ref from this answer
  name: string;
  mount: Mount;
  dims: Dims;
  hidden?: boolean;
  /** What it rests on (scene supportId, or the onTop target of an item added in this answer). */
  supportId?: string;
}

class Ctx {
  readonly entries: Entry[];
  readonly actions: ChatAction[] = [];
  readonly said: string[] = [];
  /** The item "it" refers to: the last one touched in this message, else the selection. */
  last: string | null;
  /** After a failed find: an item whose name only uses the word as a modifier ("desk" → "Desk chair"). */
  suggestion: Entry | null = null;
  private refN = 0;

  constructor(readonly scene: ChatScene) {
    this.entries = scene.items.map((it) => ({ id: it.id, name: it.name, mount: it.mount, dims: it.dims, hidden: it.hidden, supportId: it.supportId }));
    this.last = scene.selectedId && this.entries.some((e) => e.id === scene.selectedId) ? scene.selectedId : null;
  }

  nameOf(id: string): string {
    return this.entries.find((e) => e.id === id)?.name ?? "it";
  }

  newRef(key: string): string {
    let ref: string;
    do {
      this.refN += 1;
      ref = `${key.toLowerCase()}${this.refN}`;
    } while (this.entries.some((e) => e.id === ref));
    return ref;
  }

  /** True when `id` rests (directly or through others) on `on`. */
  restsOn(id: string, on: string): boolean {
    const seen = new Set<string>();
    let cur = this.entries.find((e) => e.id === id);
    while (cur?.supportId && !seen.has(cur.id)) {
      if (cur.supportId === on) return true;
      seen.add(cur.id);
      cur = this.entries.find((e) => e.id === cur!.supportId);
    }
    return false;
  }

  /**
   * The item a phrase names: pronouns → "it"; else best name match, most recent wins. A name that only uses the
   * phrase as a modifier of another thing ("desk" in "Desk chair", "table" in "Table lamp") doesn't count: it is
   * kept as `suggestion` for a "did you mean" reply.
   */
  find(phrase: string): Entry | null {
    this.suggestion = null;
    const p = phrase
      .toLowerCase()
      .replace(/[?.!,]+$/g, "")
      .replace(/^(?:the|a|an|my|our|your|that|this)\s+/, "")
      .trim();
    if (!p) return null;
    if (/^(?:it|this|that|this one|that one|them|selected|selection|selected (?:item|one)|the selected (?:item|one))$/.test(phrase.trim().toLowerCase()) || /^(?:it|this|that|one|selected(?: item| one)?|selection)$/.test(p)) {
      return this.last ? (this.entries.find((e) => e.id === this.last) ?? null) : null;
    }
    const want = tokens(p);
    if (!want.length) return null;
    let best: Entry | null = null;
    let bestScore = 0;
    this.entries.forEach((e) => {
      const name = e.name.toLowerCase();
      const have = tokens(name);
      let score = 0;
      if (name === p || e.id.toLowerCase() === p) score = 100;
      else if (new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(name)) score = 80;
      else {
        const shared = want.filter((t) => have.includes(t)).length;
        if (shared) score = 40 + 40 * (shared / Math.max(want.length, have.length));
      }
      if (score > 0 && score < 100 && usedAsModifier(want, e.name)) score = 1;
      if (e.hidden) score -= 0.5;
      if (score > 0 && score >= bestScore) {
        best = e;
        bestScore = score;
      }
    });
    if (best && bestScore <= 1) {
      this.suggestion = best;
      return null;
    }
    return best;
  }
}

/** The stacking size rule (src/lib/geometry fitsOnTop, item turned to match the support). */
function tooBigFor(item: Dims, support: Dims): boolean {
  return item.w > support.w * STACK_SIZE_RATIO + 1e-6 || item.d > support.d * STACK_SIZE_RATIO + 1e-6;
}

/** "desk" in "Desk chair": the wanted word is followed by another thing's noun in the name. */
function usedAsModifier(want: string[], name: string): boolean {
  const have = tokens(name.replace(/\(.*?\)/g, " ").split(",")[0]);
  const last = want[want.length - 1];
  const i = have.lastIndexOf(last);
  if (i < 0 || i >= have.length - 1) return false;
  const rest = have.slice(i + 1).join(" ");
  return THINGS.some((t) => t.words.test(rest));
}

// ---------- placements ----------

const WALL_WORD: Record<string, WallSide> = {
  north: "north",
  back: "north",
  south: "south",
  front: "south",
  west: "west",
  left: "west",
  east: "east",
  right: "east",
};

const CORNER_OF: Record<string, "nw" | "ne" | "sw" | "se"> = {};
for (const [ns, n] of [
  ["north", "n"],
  ["back", "n"],
  ["south", "s"],
  ["front", "s"],
]) {
  for (const [ew, e] of [
    ["west", "w"],
    ["left", "w"],
    ["east", "e"],
    ["right", "e"],
  ]) {
    CORNER_OF[`${ns} ${ew}`] = `${n}${e}` as "nw";
    CORNER_OF[`${ns}${ew}`] = `${n}${e}` as "nw";
  }
}

/** First corner (nw, ne, sw, se) with no floor item standing near it. */
function freeCorner(scene: ChatScene): "nw" | "ne" | "sw" | "se" {
  const { width, depth } = scene.room;
  const spots = { nw: [-width / 2, -depth / 2], ne: [width / 2, -depth / 2], sw: [-width / 2, depth / 2], se: [width / 2, depth / 2] } as const;
  for (const c of ["nw", "ne", "sw", "se"] as const) {
    const [x, z] = spots[c];
    const taken = scene.items.some(
      (it) => !it.hidden && it.mount === "floor" && Math.abs(it.position.x - x) < it.dims.w / 2 + 0.4 && Math.abs(it.position.z - z) < it.dims.d / 2 + 0.4,
    );
    if (!taken) return c;
  }
  return "nw";
}

const PLACE_START =
  /\s+(?=(?:on top of|on to|onto|on|atop|in|into|inside|at|to|towards?|against|along|by|beside|besides|next to|near|alongside|in front of|behind|under|underneath|(?:to the )?(?:left|right) of)\b)/;

type Placed = { placement: ChatPlacement; where: string } | { missing: Thing; build: (id: string) => { placement: ChatPlacement; where: string } } | { error: string } | null;

/**
 * A placement from words like "in the NW corner", "against the north wall", "on the desk", "next to the bed".
 * `selfKey` is the THINGS key of the item being placed: small surface items read "to the desk" as onto it, and
 * seating reads "at the desk" as in front of it.
 */
function parsePlacement(phrase: string, ctx: Ctx, selfId: string | null, selfKey?: string): Placed {
  const p = phrase.toLowerCase().trim().replace(/[?.!]+$/, "");
  if (!p) return null;

  // "on the left (side) of the bed" is beside it, not on it; "on either side of the bed" is next to it.
  const onSide = /^on\s+(?:the\s+)?(left|right)(?:[\s-]+hand)?(?:\s+side)?\s+of\s+(.+)$/.exec(p);
  if (onSide) return parsePlacement(`to the ${onSide[1]} of ${onSide[2]}`, ctx, selfId, selfKey);
  const eitherSide = /^on\s+(?:either|each|both|the two)\s+sides?\s+of\s+(.+)$/.exec(p);
  if (eitherSide) return parsePlacement(`next to ${eitherSide[1]}`, ctx, selfId, selfKey);

  // "under the desk": on the floor underneath it (the app checks it fits under).
  const under = /^(?:under(?:neath)?|beneath|below)\s+(.+)$/.exec(p);
  if (under) {
    const t = ctx.find(under[1]);
    if (t && t.id !== selfId) return { placement: { kind: "under", targetId: t.id }, where: `under the ${t.name.toLowerCase()}` };
    const th = thingFor(under[1]);
    if (th) return { missing: th, build: (id: string) => ({ placement: { kind: "under", targetId: id }, where: `under the ${th.name.toLowerCase()}` }) };
    return { error: `I couldn't find "${under[1].replace(/^(?:the|a|an|my)\s+/, "")}" in the room` };
  }
  // "on the middle level of the cat tower", "on the top shelf of the bookshelf", "on the cat tower's base", and with a
  // single multi-level item in the room just "on the lower platform".
  const LEVEL_WORD = String.raw`(top|upper|highest|middle|mid|second|bottom|lower|lowest)`;
  const LEVEL_NOUN = String.raw`(level|shelf|platform|perch|tier|deck|floor|step)`;
  const lvlOf = new RegExp(String.raw`^(?:on|onto|to)\s+(?:the\s+)?(?:${LEVEL_WORD}\s+${LEVEL_NOUN}|(base))\s+(?:of|on)\s+(.+)$`).exec(p);
  const lvlPoss = !lvlOf ? new RegExp(String.raw`^(?:on|onto|to)\s+(?:the\s+)?(.+?)'s\s+(?:${LEVEL_WORD}\s+${LEVEL_NOUN}|(base)|${LEVEL_NOUN})$`).exec(p) : null;
  const lvlBare = !lvlOf && !lvlPoss ? new RegExp(String.raw`^(?:on|onto|to)\s+(?:the\s+)?${LEVEL_WORD}\s+${LEVEL_NOUN}$`).exec(p) : null;
  const multi = ctx.scene.items.filter((it) => !it.hidden && (it.levels?.length ?? 0) >= 2);
  let lvl: [string, string, string, string] | null = null; // [match, level word, noun, target phrase]
  if (lvlOf) lvl = [lvlOf[0], lvlOf[1] ?? "bottom", lvlOf[2] ?? "base", lvlOf[4]];
  else if (lvlPoss) lvl = [lvlPoss[0], lvlPoss[2] ?? (lvlPoss[4] ? "bottom" : lvlPoss[5] === "platform" ? "middle" : "top"), lvlPoss[3] ?? lvlPoss[5] ?? "base", lvlPoss[1]];
  else if (lvlBare && multi.length === 1) lvl = [lvlBare[0], lvlBare[1], lvlBare[2], multi[0].name];
  if (lvl) {
    const word = lvl[1];
    const noun = lvl[2];
    const named = ctx.find(lvl[3]);
    const levels = named ? ctx.scene.items.find((it) => it.id === named.id)?.levels : undefined;
    let level: "top" | "middle" | "bottom" = /^(?:top|upper|highest)$/.test(word) ? "top" : /^(?:bottom|lower|lowest)$/.test(word) ? "bottom" : "middle";
    // "The lower platform / perch / shelf": the lowest real platform below the top (a cat tower's middle platform,
    // not the roof of its condo box).
    if (level === "bottom" && /^(?:platform|perch|shelf)$/.test(noun) && levels) {
      const platforms = levels.filter((l) => l.kind === "platform" && l.name !== "top");
      const lowest = platforms[platforms.length - 1];
      if (lowest?.name === "middle level") level = "middle";
    }
    const what = level === "top" ? "top" : `${level} level`;
    const t = named;
    const mk = (id: string, name: string) => ({
      placement: (level === "top" ? { kind: "onTop", targetId: id } : { kind: "onTop", targetId: id, level }) as ChatPlacement,
      where: `on the ${what} of the ${name}`,
    });
    if (t && t.id !== selfId) return mk(t.id, t.name.toLowerCase());
    const th = thingFor(lvl[3]);
    if (th) return { missing: th, build: (id: string) => mk(id, th.name.toLowerCase()) };
    return { error: `I couldn't find "${lvl[3].replace(/^(?:the|a|an|my)\s+/, "")}" in the room` };
  }
  // Small things go ONTO a surface "to the desk", but "to the left of the desk" is still beside it.
  const toSurface = /^(?:to|over to|onto)\s+(?:the\s+|my\s+)?(.+)$/.exec(p);
  const bare = toSurface && !/^(?:left|right|front|back|side|other side|middle|end)\b/.test(toSurface[1]) && !/\bof\b/.test(toSurface[1]);
  if (toSurface && bare && selfKey && SMALL_ON_SURFACES.has(selfKey) && SURFACE_WORDS.test(toSurface[1])) {
    return parsePlacement(`on ${toSurface[1]}`, ctx, selfId, selfKey);
  }
  const atThing = /^at\s+(?:the\s+|my\s+)?(.+)$/.exec(p);
  if (atThing && SIT_AT_WORDS.test(atThing[1])) return parsePlacement(`in front of ${atThing[1]}`, ctx, selfId, selfKey);

  const corner = /\b(north|south|back|front)[\s-]?(east|west|left|right)\b(?:\s+corner)?|\b(nw|ne|sw|se)\b/.exec(p);
  if (corner && (/\bcorner\b/.test(p) || corner[3])) {
    const c = corner[3] ? (corner[3] as "nw") : CORNER_OF[`${corner[1]} ${corner[2]}`];
    return { placement: { kind: "corner", corner: c }, where: `in the ${c.toUpperCase()} corner` };
  }
  if (/\bcorner\b/.test(p)) {
    const c = freeCorner(ctx.scene);
    return { placement: { kind: "corner", corner: c }, where: `in the ${c.toUpperCase()} corner` };
  }
  const wall = /\b(north|south|east|west|back|front|left|right)(?:ern)?\s+wall\b/.exec(p);
  if (wall) {
    const w = WALL_WORD[wall[1]];
    return { placement: { kind: "wall", wall: w }, where: `against the ${w} wall` };
  }
  if (/\bwindows?\b/.test(p)) {
    const win = ctx.scene.room.openings.find((o) => o.kind === "window");
    if (win) {
      const len = win.wall === "north" || win.wall === "south" ? ctx.scene.room.width : ctx.scene.room.depth;
      return { placement: { kind: "wall", wall: win.wall, along: r3(Math.min(1, Math.max(0, win.offset / len))) }, where: "by the window" };
    }
  }
  if (/\b(?:center|centre|middle)\b/.test(p)) return { placement: { kind: "center" }, where: "in the middle of the room" };

  const onTop = /^(?:on top of|on to|onto|on|atop|upon)\s+(.+)$/.exec(p);
  const nextTo =
    /^(?:(?:to the\s+)?(left|right)(?:[\s-]+hand)?\s+(?:side\s+)?of|(in front of|(?:to the\s+|at the\s+)?front\s+of)|(behind|(?:to the\s+|at the\s+)?back\s+of)|next to|beside|besides|by|near|alongside|towards?|to)\s+(.+)$/.exec(p);
  const targetPhrase = onTop?.[1] ?? nextTo?.[4];
  if (!targetPhrase) return null;
  const side = nextTo ? ((nextTo[1] as "left" | "right" | undefined) ?? (nextTo[2] ? "front" : nextTo[3] ? "behind" : undefined)) : undefined;
  const make = (targetId: string, name: string) =>
    onTop
      ? { placement: { kind: "onTop", targetId } as ChatPlacement, where: `on top of the ${name}` }
      : { placement: { kind: "nextTo", targetId, ...(side ? { side } : {}) } as ChatPlacement, where: `${side === "left" || side === "right" ? `to the ${side} of` : side === "front" ? "in front of" : side === "behind" ? "behind" : "next to"} the ${name}` };

  const target = ctx.find(targetPhrase);
  if (target && target.id !== selfId) return make(target.id, target.name.toLowerCase());
  const thing = thingFor(targetPhrase);
  if (thing) return { missing: thing, build: (id: string) => make(id, thing.name.toLowerCase()) };
  return { error: `I couldn't find "${targetPhrase.replace(/^(?:the|a|an|my)\s+/, "")}" in the room` };
}

/** Resolve a Placed, adding the missing target (e.g. the desk a monitor should go on) first. */
function settle(placed: Placed, ctx: Ctx): { placement?: ChatPlacement; where?: string; error?: string } {
  if (!placed) return {};
  if ("error" in placed) return { error: placed.error };
  if ("placement" in placed) return placed;
  const id = addThing(ctx, placed.missing, {}, undefined);
  ctx.said.push(`There was no ${placed.missing.name.toLowerCase()}, so I added one first.`);
  return placed.build(id);
}

// ---------- actions ----------

/** Push an addShape for a thing; returns its ref. */
function addThing(ctx: Ctx, thing: Thing, opts: { dims?: Partial<Dims>; color?: string | null; name?: string }, placement: ChatPlacement | undefined): string {
  const onSurface = placement?.kind === "onTop";
  const base = thing.key === "lamp" && onSurface ? THINGS.find((t) => t.key === "tableLamp")! : thing;
  const ref = ctx.newRef(base.key);
  const dims = { ...base.dims, ...(opts.dims ?? {}) };
  const name = opts.name ?? base.name;
  const action: Extract<ChatAction, { type: "addShape" }> = { type: "addShape", ref, name, dims, mount: base.mount };
  if (base.preset) action.preset = base.preset;
  if (base.parts) action.parts = base.parts;
  const color = opts.color ?? base.color;
  if (color) action.color = color;
  if (placement) action.placement = placement;
  ctx.actions.push(action);
  ctx.entries.push({ id: ref, name, mount: base.mount, dims, supportId: placement?.kind === "onTop" || placement?.kind === "under" ? placement.targetId : undefined });
  ctx.last = ref;
  return ref;
}

type Handler = (clause: string, lc: string, ctx: Ctx) => boolean;

const notFound = (ctx: Ctx, phrase: string) => {
  const word = phrase.replace(/^(?:the|a|an|my)\s+/i, "");
  const maybe = ctx.suggestion ? ` Did you mean the ${ctx.suggestion.name.toLowerCase()}?` : "";
  ctx.said.push(`I couldn't find "${word}" in the room.${maybe}`);
  return true;
};

const keyOf = (name: string) => thingFor(name.toLowerCase())?.key;

const handleUndo: Handler = (_c, lc, ctx) => {
  const m = /^(?:please\s+)?(?:undo|revert|go back|oops|take that back)\b(?:\s+(?:the\s+)?(?:last\s+)?(\d+|two|three|four|five))?/.exec(lc);
  if (!m) return false;
  const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };
  const steps = m[1] ? (words[m[1]] ?? Number(m[1])) : 1;
  ctx.actions.push({ type: "undo", steps });
  ctx.said.push(steps === 1 ? "Undid the last change." : `Undid the last ${steps} changes.`);
  return true;
};

const handleCamera: Handler = (_c, lc, ctx) => {
  let preset: "iso" | "top" | "eye" | null = null;
  if (/\b(?:top|overhead|plan|bird'?s[- ]?eye)\s*(?:view|camera|down)?\b|\bview from above\b|\bfrom above\b/.test(lc) && /\b(?:view|camera|look|show|switch|see|from above|top down|plan)\b/.test(lc)) preset = "top";
  else if (/\b(?:eye[- ]level|first[- ]person|walk(?:[- ]?through)?)\b/.test(lc)) preset = "eye";
  else if (/\b(?:iso(?:metric)?|3d|default|perspective|normal)\s+(?:view|camera)\b/.test(lc)) preset = "iso";
  if (!preset) return false;
  ctx.actions.push({ type: "camera", preset });
  ctx.said.push(preset === "top" ? "Switched to the top view." : preset === "eye" ? "Switched to eye level." : "Back to the 3D view.");
  return true;
};

const ORDINAL_RE = /\b(?:the\s+)?(first|second|third|fourth|fifth|sixth|1st|2nd|3rd|4th|5th|6th|last)\s+(?:one|option|result|choice|product|item|lamp|pick)\b|(?:#|\bnumber\s+|\boption\s+|\bresult\s+|\bno\.?\s*)(\d)\b/;

const handleCandidate: Handler = (_clause, lc, ctx) => {
  const m = ORDINAL_RE.exec(lc);
  if (!m) return false;
  const verb = /^(?:please\s+)?(?:add|use|put|place|pick|choose|take|get|i'?ll take|let'?s (?:go with|use|add)|go with|preview|show(?: me)?|try|replace|swap|i like)\b/.exec(lc);
  if (!verb) return false;
  const results = ctx.scene.lastResults ?? [];
  if (!results.length) {
    ctx.said.push('There are no search results yet. Try "find a Japanese hanging lamp under $200" first.');
    return true;
  }
  const n = m[1] ? (m[1] === "last" ? results.length - 1 : ORDINALS[m[1]]) : Number(m[2]) - 1;
  const r = results.find((x) => x.index === n) ?? results[n];
  if (!r) {
    ctx.said.push(`There are only ${results.length} results.`);
    return true;
  }
  if (/^(?:please\s+)?(?:preview|show(?: me)?|try)\b/.test(lc)) {
    ctx.actions.push({ type: "previewCandidate", index: r.index });
    ctx.said.push(`Previewing ${r.name}.`);
    return true;
  }
  return addResult(ctx, r, lc, lc.slice(m.index + m[0].length));
};

type SearchResult = NonNullable<ChatScene["lastResults"]>[number];

/** Put search result `r` into the room: in place of what the search was for, or where `after` says. */
function addResult(ctx: Ctx, r: SearchResult, lc: string, after: string): boolean {
  const action: Extract<ChatAction, { type: "addCandidate" }> = { type: "addCandidate", index: r.index };
  const replace = /^(?:please\s+)?(?:replace|swap)\s+(.+?)\s+(?:with|for)\b/.exec(lc) ?? /\b(?:instead of|in place of|to replace)\s+(.+)$/.exec(lc);
  let where = "";
  if (replace) {
    const target = ctx.find(replace[1]);
    if (!target) return notFound(ctx, replace[1]);
    action.replaceItemId = target.id;
    where = ` in place of the ${target.name.toLowerCase()}`;
  } else {
    // The search was for an item (a placeholder, or "swap the lamp for ..."): the pick replaces it, unless the user
    // asks for another one.
    const forId = ctx.scene.lastSearch?.forItemId;
    const forEntry = forId ? ctx.entries.find((e) => e.id === forId) : undefined;
    if (forEntry && !/\b(?:another|also|as well|too|extra|in addition|keep)\b/.test(lc)) {
      action.replaceItemId = forEntry.id;
      where = ` in place of the ${forEntry.name.toLowerCase()}`;
    }
    const placed = settle(parsePlacement(after, ctx, forEntry?.id ?? null), ctx);
    if (placed.error) ctx.said.push(`${placed.error}, so I let the app pick a spot.`);
    const besideOrOn = placed.placement?.kind === "onTop" || placed.placement?.kind === "nextTo";
    if (placed.placement && besideOrOn && r.mount !== "floor") {
      ctx.said.push(`It's a ${r.mount} item, so it can't go ${placed.where}; I let the app pick a spot.`);
    } else if (placed.placement) {
      action.placement = placed.placement;
      where = `${where} ${placed.where}`;
    }
  }
  ctx.actions.push(action);
  ctx.said.push(`${action.replaceItemId ? "Swapped in" : "Added"} ${r.name}${where}.`);
  return true;
}

/** "it", "this one", "the preview": words that point at something rather than name it. */
const POINTER_WORDS = /^(?:it|this|that|them|this one|that one|the one|the preview(?:ed)?(?: one| item| product)?|previewed (?:one|item|product))$/;

const handleSearch: Handler = (clause, lc, ctx) => {
  const m = /^(?:can you |could you |please |i want to |i'?d like to |help me |let'?s )?(?:find|search(?: for)?|look(?:ing)? for|shop(?:ping)? for|browse(?: for)?|get me|show me|buy|i(?:'m| am) looking for)\s+(?:me\s+)?(.+)$/.exec(lc);
  if (!m) return false;
  const query = clause
    .slice(lc.length - m[1].length)
    .replace(/^(?:a|an|some|the)\s+/i, "")
    .trim();
  if (query.length < 2) return false;
  const filters = inferSearchFilters(query);
  const action: Extract<ChatAction, { type: "search" }> = { type: "search", query };
  if (filters.maxPrice) action.maxPrice = filters.maxPrice;
  if (filters.mount) action.mount = filters.mount;
  const forItem = /\b(?:for|to replace)\s+(?:the|my)\s+([a-z][a-z ]*?)\s*$/.exec(m[1]);
  if (forItem && !/corner|room|wall|bedroom|office/.test(forItem[1])) {
    const target = ctx.find(forItem[1]);
    if (target) action.forItemId = target.id;
  }
  ctx.actions.push(action);
  ctx.said.push(`Searching online for "${query}". This takes 1-3 minutes; the results will show up here.`);
  return true;
};

/** "swap the lamp for something mid-century", "replace the desk with a standing desk": search for a replacement. */
const handleSwap: Handler = (clause, lc, ctx) => {
  const m = /^(?:please\s+)?(?:swap|replace|switch|change)\s+(?:out\s+)?(.+?)\s+(?:for|with|to)\s+(?:something|anything|one|a|an|some)?\s*(?:more\s+|that'?s\s+|in\s+)?(.+)$/.exec(lc);
  if (!m || ORDINAL_RE.test(lc)) return false;
  const item = ctx.find(m[1]);
  if (!item) return notFound(ctx, m[1]);
  const want = clause.slice(lc.length - m[2].length).replace(/\s+(?:style|instead)$/i, "").trim();
  if (!want || colorFrom(want)) return false; // "change the desk to red" is a recolor
  const noun = THINGS.find((t) => t.key === keyOf(item.name))?.name.toLowerCase() ?? item.name.replace(/\(.*?\)/g, "").trim().toLowerCase();
  const query = thingFor(want.toLowerCase()) ? want : `${want} ${noun}`;
  const action: Extract<ChatAction, { type: "search" }> = { type: "search", query, forItemId: item.id };
  const filters = inferSearchFilters(query);
  if (filters.maxPrice) action.maxPrice = filters.maxPrice;
  if (item.mount !== "floor") action.mount = item.mount;
  ctx.actions.push(action);
  ctx.last = item.id;
  ctx.said.push(`Searching online for "${query}" to replace the ${item.name.toLowerCase()}. This takes 1-3 minutes; then say "add the first one" to swap it in.`);
  return true;
};

/** "hide the dresser", "show the dresser again". */
const handleHide: Handler = (_c, lc, ctx) => {
  const m = /^(?:please\s+)?(hide|show|unhide|bring back)\s+(.+?)(?:\s+again)?$/.exec(lc);
  if (!m) return false;
  const item = ctx.find(m[2]);
  if (!item) return /^(?:show)\b/.test(lc) ? false : notFound(ctx, m[2]); // "show me ..." is something else
  const hidden = m[1] === "hide";
  ctx.actions.push({ type: "setHidden", itemId: item.id, hidden });
  item.hidden = hidden;
  if (!hidden) ctx.last = item.id;
  ctx.said.push(hidden ? `Hid the ${item.name.toLowerCase()} (it's still in the plan; say "show the ${item.name.toLowerCase()}" to bring it back).` : `The ${item.name.toLowerCase()} is back.`);
  return true;
};

/**
 * "hang the mirror on the wall", "hang the art at 5 ft", "hang the lamp from the ceiling", "lower the pendant by 6
 * inches", "raise the art 10 cm".
 */
const handleHang: Handler = (_c, lc, ctx) => {
  const by = new RegExp(String.raw`^(?:please\s+)?(lower|raise|drop|lift)\s+(.+?)\s+(?:by\s+)?(?:another\s+)?${NUM}\s*${UNIT}$`).exec(lc);
  if (by) {
    const item = ctx.find(by[2]);
    if (!item) return notFound(ctx, by[2]);
    const scene = ctx.scene.items.find((e) => e.id === item.id);
    const amount = toMeters(Number(by[3]), by[4], ctx.scene.units, "in");
    const down = by[1] === "lower" || by[1] === "drop";
    const name = item.name.toLowerCase();
    if (item.mount === "ceiling") {
      const drop = r3(Math.max(0.05, (scene ? ctx.scene.room.height - scene.position.y : item.dims.h) + (down ? amount : -amount)));
      ctx.actions.push({ type: "hang", itemId: item.id, drop });
      ctx.last = item.id;
      ctx.said.push(`${down ? "Lowered" : "Raised"} the ${name} by ${formatLength(amount, ctx.scene.units)}: it now hangs ${formatLength(drop, ctx.scene.units)} below the ceiling.`);
      return true;
    }
    if (item.mount === "wall" && scene) {
      const bottom = r3(Math.max(0, scene.position.y + (down ? -amount : amount)));
      ctx.actions.push({ type: "setHeight", itemId: item.id, bottom });
      ctx.last = item.id;
      ctx.said.push(`${down ? "Lowered" : "Raised"} the ${name} to ${formatLength(bottom, ctx.scene.units)} off the floor.`);
      return true;
    }
    ctx.said.push(`The ${name} stands on the floor, so I can't raise or lower it. Hang it from the ceiling or on a wall first.`);
    return true;
  }
  const fromCeiling = /^(?:please\s+)?(?:hang|mount|put|move|attach|suspend)\s+(.+?)\s+(?:from|on|onto|to|off)\s+(?:the\s+)?ceiling(?:\s+instead)?$/.exec(lc);
  if (fromCeiling) {
    const item = ctx.find(fromCeiling[1]);
    if (!item) return notFound(ctx, fromCeiling[1]);
    ctx.actions.push({ type: "hang", itemId: item.id });
    item.mount = "ceiling";
    item.supportId = undefined;
    ctx.last = item.id;
    ctx.said.push(`Hung the ${item.name.toLowerCase()} from the ceiling.`);
    return true;
  }
  const at = new RegExp(String.raw`^(?:please\s+)?(?:hang|mount|put|move|raise|lower)\s+(.+?)\s+(?:at|to)\s+${NUM}\s*${UNIT}(?:\s+(?:high|up|off the floor|from the floor))?$`).exec(lc);
  if (at) {
    const item = ctx.find(at[1]);
    if (!item) return notFound(ctx, at[1]);
    if (item.mount !== "wall") return false;
    const bottom = r3(toMeters(Number(at[2]), at[3], ctx.scene.units, "ft"));
    ctx.actions.push({ type: "setHeight", itemId: item.id, bottom });
    ctx.last = item.id;
    ctx.said.push(`Hung the ${item.name.toLowerCase()} with its bottom edge at ${formatLength(bottom, ctx.scene.units)}.`);
    return true;
  }
  const m = /^(?:please\s+)?(?:hang|mount|put|move|stand|set)\s+(.+?)\s+(?:on|onto|to|from)\s+(?:the\s+)?(?:(north|south|east|west|back|front|left|right)(?:ern)?\s+)?(wall|ceiling|floor)(?:\s+instead)?$/.exec(lc);
  if (!m) return false;
  const item = ctx.find(m[1]);
  if (!item) return notFound(ctx, m[1]);
  const mount = m[3] as Mount;
  const side = m[2] && mount === "wall" ? WALL_WORD[m[2]] : undefined;
  if (side && item.mount !== "wall" && /^(?:please\s+)?(?:hang|mount)\b/.test(lc)) {
    // "hang the mirror on the north wall": it becomes a wall item, on that wall.
    ctx.actions.push({ type: "setMount", itemId: item.id, mount: "wall" }, { type: "move", itemId: item.id, placement: { kind: "wall", wall: side } });
    item.mount = "wall";
    item.supportId = undefined;
    ctx.last = item.id;
    ctx.said.push(`Hung the ${item.name.toLowerCase()} on the ${side} wall.`);
    return true;
  }
  if (side) return false; // "move the desk to the north wall": a normal move
  if (mount === "floor" && item.supportId) return false; // "put the monitor on the floor" = off its desk (handleOff)
  if (item.mount === mount) {
    ctx.said.push(`The ${item.name.toLowerCase()} is already ${mount === "floor" ? "on the floor" : `on the ${mount}`}.`);
    return true;
  }
  ctx.actions.push({ type: "setMount", itemId: item.id, mount });
  item.mount = mount;
  item.supportId = undefined;
  ctx.last = item.id;
  ctx.said.push(mount === "wall" ? `Hung the ${item.name.toLowerCase()} on the wall.` : mount === "ceiling" ? `Hung the ${item.name.toLowerCase()} from the ceiling.` : `Put the ${item.name.toLowerCase()} on the floor.`);
  return true;
};

/** "add a window on the east wall", "remove the door", "make the window 4 ft wide". */
const handleOpening: Handler = (_c, lc, ctx) => {
  const add = /^(?:please\s+)?(?:add|put|cut|there(?:'s| is))\s+(?:a|an|another)\s+(window|door)\s+(?:on|in|to|into)\s+(?:the\s+)?(north|south|east|west|back|front|left|right)(?:ern)?\s+wall$/.exec(lc);
  if (add) {
    const wall = WALL_WORD[add[2]];
    ctx.actions.push({ type: "setOpening", op: "add", kind: add[1] as "door" | "window", wall });
    ctx.said.push(`Added a ${add[1]} in the middle of the ${wall} wall.`);
    return true;
  }
  const openings = ctx.scene.room.openings;
  const pick = (kind: string, wallWord?: string) => {
    const wall = wallWord ? WALL_WORD[wallWord] : undefined;
    const list = openings.filter((o) => o.kind === kind && (!wall || o.wall === wall));
    return list[list.length - 1];
  };
  const del = /^(?:please\s+)?(?:remove|delete|get rid of)\s+(?:the\s+)?(?:(north|south|east|west|back|front|left|right)\s+)?(window|door)(?:\s+on the (north|south|east|west|back|front|left|right) wall)?$/.exec(lc);
  if (del) {
    const o = pick(del[2], del[1] ?? del[3]);
    if (!o) {
      ctx.said.push(`There's no ${del[2]} like that in the room.`);
      return true;
    }
    ctx.actions.push({ type: "setOpening", op: "remove", openingId: o.id });
    ctx.said.push(`Removed the ${o.kind} on the ${o.wall} wall.`);
    return true;
  }
  const size = new RegExp(String.raw`^(?:please\s+)?(?:make|set)\s+(?:the\s+)?(?:(north|south|east|west)\s+)?(window|door)\s+(?:to\s+|be\s+)?${NUM}\s*${UNIT}\s*(wide|tall|high)$`).exec(lc);
  if (size) {
    const o = pick(size[2], size[1]);
    if (!o) return false;
    const v = r3(toMeters(Number(size[3]), size[4], ctx.scene.units, "ft"));
    ctx.actions.push({ type: "setOpening", op: "update", openingId: o.id, ...(size[5] === "wide" ? { width: v } : { height: v }) });
    ctx.said.push(`Made the ${o.kind} ${formatLength(v, ctx.scene.units)} ${size[5]}.`);
    return true;
  }
  return false;
};

/** "take the monitor off the desk", "put the lamp on the floor", "put it down": back to the floor, in front. */
const handleOff: Handler = (_c, lc, ctx) => {
  const m =
    /^(?:please\s+)?(?:take|get|lift|move|put|set|bring|place)\s+(.+?)\s+(?:off(?:\s+of)?(?:\s+(?:the\s+|my\s+)?(.+))?|down(?:\s+on\s+the\s+floor)?|(?:on|onto|to)\s+the\s+floor)$/.exec(lc) ??
    /^(?:please\s+)?(?:take|get)\s+(?:off|down)\s+(.+)$/.exec(lc);
  if (!m) return false;
  const item = ctx.find(m[1]);
  if (!item) return notFound(ctx, m[1]);
  ctx.last = item.id;
  if (!item.supportId) {
    ctx.said.push(`The ${item.name.toLowerCase()} is already on the floor.`);
    return true;
  }
  // It lands in front of the bottom of the stack (a lamp on a box on a desk: in front of the desk).
  let base = ctx.entries.find((e) => e.id === item.supportId);
  for (const seen = new Set<string>(); base?.supportId && !seen.has(base.id); ) {
    seen.add(base.id);
    const below = ctx.entries.find((e) => e.id === base!.supportId);
    if (!below) break;
    base = below;
  }
  ctx.actions.push({ type: "move", itemId: item.id, placement: { kind: "floor" } });
  item.supportId = undefined;
  ctx.said.push(`Put the ${item.name.toLowerCase()} on the floor${base ? ` in front of the ${base.name.toLowerCase()}` : ""}.`);
  return true;
};

const handleRoom: Handler = (clause, lc, ctx) => {
  const units = ctx.scene.units;
  const size = new RegExp(
    String.raw`\b(?:make|set|change|resize)\s+(?:the\s+|my\s+)?room\s+(?:to\s+|be\s+)?(?:size\s+)?${NUM}\s*${UNIT}\s*(?:by|x|×)\s*${NUM}\s*${UNIT}(?:\s*(?:by|x|×)\s*${NUM}\s*${UNIT})?`,
  ).exec(lc);
  if (size) {
    const unit = size[6] ?? size[4] ?? size[2];
    const patch = {
      width: r3(toMeters(Number(size[1]), size[2] ?? unit, units, "ft")),
      depth: r3(toMeters(Number(size[3]), size[4] ?? unit, units, "ft")),
      ...(size[5] ? { height: r3(toMeters(Number(size[5]), size[6] ?? unit, units, "ft")) } : {}),
    };
    ctx.actions.push({ type: "setRoom", patch });
    ctx.said.push(`Resized the room to ${size[1]} × ${size[3]}${unit ? ` ${unit}` : units === "imperial" ? " ft" : " m"}.`);
    return true;
  }
  const ceiling = new RegExp(String.raw`\b(?:ceiling|room)(?:\s+height)?\s+(?:to\s+|is\s+|be\s+)?${NUM}\s*${UNIT}\s*(?:high|tall)?\b|\b(?:make|set)\s+the\s+ceiling(?:s)?\s+(?:to\s+)?${NUM}\s*${UNIT}`).exec(lc);
  if (ceiling && /\b(?:ceiling|height|high|tall)\b/.test(lc)) {
    const v = Number(ceiling[1] ?? ceiling[3]);
    const height = r3(toMeters(v, ceiling[2] ?? ceiling[4], units, "ft"));
    ctx.actions.push({ type: "setRoom", patch: { height } });
    ctx.said.push(`Set the ceiling height to ${v}${(ceiling[2] ?? ceiling[4]) ? ` ${ceiling[2] ?? ceiling[4]}` : units === "imperial" ? " ft" : " m"}.`);
    return true;
  }
  const surface = /\b(?:make|paint|color|colour|turn|change|set)\s+(?:the\s+|my\s+)?(walls?|floor(?:ing)?)\s+(?:color\s+)?(?:to\s+)?(?:be\s+)?(.+)$/.exec(lc);
  if (surface) {
    const color = trailingColor(surface[2]);
    if (!color) {
      ctx.said.push(`I don't know the color "${surface[2]}". Try a simple color name or a hex code like #a3b18a.`);
      return true;
    }
    const isWall = surface[1].startsWith("wall");
    ctx.actions.push({ type: "setRoom", patch: isWall ? { wallColor: color.hex } : { floorColor: color.hex } });
    ctx.said.push(`Made the ${isWall ? "walls" : "floor"} ${color.word}.`);
    return true;
  }
  const rename = /\b(?:rename|call)\s+(?:the\s+|my\s+)?room\s+(?:to\s+)?["']?(.+?)["']?$/.exec(lc);
  if (rename) {
    const name = clause.slice(lc.length - rename[1].length - (/["']$/.test(lc) ? 1 : 0)).replace(/["'.!]+$/g, "").trim();
    ctx.actions.push({ type: "setRoom", patch: { name } });
    ctx.said.push(`Renamed the room to "${name}".`);
    return true;
  }
  return false;
};

const handleRotate: Handler = (_c, lc, ctx) => {
  const m = /^(?:please\s+)?(?:rotate|turn|spin)\s+(.+?)(?:\s+(?:by\s+)?(-?\d+(?:\.\d+)?)\s*(?:°|deg(?:rees?)?)?)?(?:\s+(clockwise|counter-?clockwise|anti-?clockwise|to the left|to the right|left|right|around))?\s*$/.exec(lc);
  if (!m) return false;
  if (!m[2] && !m[3] && /^(?:turn)\b/.test(lc)) return false; // "turn it blue" is a recolor
  const item = ctx.find(m[1]);
  if (!item) return notFound(ctx, m[1]);
  let degrees = m[2] ? Number(m[2]) : m[3] === "around" ? 180 : 90;
  if (m[3] && /^(?:clockwise|to the right|right)$/.test(m[3])) degrees = -degrees;
  ctx.actions.push({ type: "rotate", itemId: item.id, degrees, relative: true });
  ctx.last = item.id;
  ctx.said.push(`Rotated the ${item.name.toLowerCase()} ${Math.abs(degrees)}°.`);
  return true;
};

const handleRemove: Handler = (_c, lc, ctx) => {
  const m = /^(?:please\s+)?(?:delete|remove|get rid of|take out|trash|throw away)\s+(.+?)(?:\s+from the room)?$/.exec(lc);
  if (!m) return false;
  const item = ctx.find(m[1]);
  if (!item) return notFound(ctx, m[1]);
  ctx.actions.push({ type: "remove", itemId: item.id });
  ctx.entries.splice(ctx.entries.indexOf(item), 1);
  if (ctx.last === item.id) ctx.last = null;
  ctx.said.push(`Removed the ${item.name.toLowerCase()}.`);
  return true;
};

const handleRename: Handler = (clause, lc, ctx) => {
  const split = /^(?:please\s+)?(?:rename|call|name)\s+(.+?)\s+(?:to|as)\s+(.+)$/.exec(lc) ?? /^(?:please\s+)?(?:call|name)\s+(it|this|that)\s+(.+)$/.exec(lc);
  if (!split) return false;
  const item = ctx.find(split[1]);
  if (!item) return notFound(ctx, split[1]);
  const name = clause.slice(lc.length - split[2].length).replace(/^["']|["'.!]+$/g, "").trim();
  if (!name) return false;
  ctx.actions.push({ type: "rename", itemId: item.id, name });
  item.name = name;
  ctx.last = item.id;
  ctx.said.push(`Renamed it to "${name}".`);
  return true;
};

const handleDuplicate: Handler = (_c, lc, ctx) => {
  const m = /^(?:please\s+)?(?:duplicate|copy|clone)\s+(.+)$/.exec(lc);
  if (!m) return false;
  const [what, where] = splitPlacement(m[1]);
  const item = ctx.find(what);
  if (!item) return notFound(ctx, what);
  const placed = settle(parsePlacement(where, ctx, null), ctx);
  const ref = ctx.newRef("copy");
  ctx.actions.push({ type: "duplicate", itemId: item.id, ref, ...(placed.placement ? { placement: placed.placement } : {}) });
  ctx.entries.push({ ...item, id: ref });
  ctx.last = ref;
  ctx.said.push(`Duplicated the ${item.name.toLowerCase()}${placed.where ? ` ${placed.where}` : ""}.`);
  return true;
};

const handleSelect: Handler = (_c, lc, ctx) => {
  const m = /^(?:please\s+)?(?:select|highlight)\s+(.+)$/.exec(lc);
  if (!m) return false;
  const item = ctx.find(m[1]);
  if (!item) return notFound(ctx, m[1]);
  ctx.actions.push({ type: "select", itemId: item.id });
  ctx.last = item.id;
  ctx.said.push(`Selected the ${item.name.toLowerCase()}.`);
  return true;
};

/** "make X 4 ft wide", "make X bigger", "make X red", "paint X blue". */
const handleMake: Handler = (_c, lc, ctx) => {
  const m = /^(?:please\s+)?(?:make|set|resize|change|paint|color|colour|turn|recolor|recolour)\s+(.+)$/.exec(lc);
  if (!m) return false;
  const rest = m[1];
  // Size: "<item> [to|be] 4 ft wide [and 2 ft deep]"
  const sizeAt = new RegExp(String.raw`\s+(?:to\s+|be\s+)?${NUM}\s*${UNIT}\s*(?:wide|width|across|tall|high|height|deep|depth|long|length)\b`).exec(rest);
  if (sizeAt) {
    const item = ctx.find(rest.slice(0, sizeAt.index));
    if (!item) return notFound(ctx, rest.slice(0, sizeAt.index));
    const dims = dimsFromText(rest.slice(sizeAt.index), ctx.scene.units, item.dims);
    ctx.actions.push({ type: "resize", itemId: item.id, dims });
    item.dims = { ...item.dims, ...dims };
    ctx.last = item.id;
    const words: Record<keyof Dims, string> = { w: "wide", h: "tall", d: "deep" };
    const desc = (Object.keys(dims) as Array<keyof Dims>).map((k) => `${formatLength(dims[k]!, ctx.scene.units)} ${words[k]}`).join(" and ");
    ctx.said.push(`Made the ${item.name.toLowerCase()} ${desc}.`);
    return true;
  }
  const scale = /^(.+?)\s+(?:a\s+(?:bit|little)\s+)?(bigger|larger|smaller|wider|narrower|taller|shorter)$/.exec(rest);
  if (scale) {
    const item = ctx.find(scale[1]);
    if (!item) return notFound(ctx, scale[1]);
    const f = /bigger|larger|wider|taller/.test(scale[2]) ? 1.25 : 0.8;
    const axes: Array<keyof Dims> = /wider|narrower/.test(scale[2]) ? ["w"] : /taller|shorter/.test(scale[2]) ? ["h"] : ["w", "h", "d"];
    const dims: Partial<Dims> = {};
    for (const a of axes) dims[a] = r3(item.dims[a] * f);
    ctx.actions.push({ type: "resize", itemId: item.id, dims });
    ctx.last = item.id;
    ctx.said.push(`Made the ${item.name.toLowerCase()} ${scale[2]}.`);
    return true;
  }
  const color = trailingColor(rest);
  if (color) {
    const phrase = rest
      .slice(0, rest.length - color.word.length)
      .replace(/\s+(?:to|be|in)\s*$/, "")
      .trim();
    const item = ctx.find(phrase);
    if (!item) return notFound(ctx, phrase || "that");
    ctx.actions.push({ type: "recolor", itemId: item.id, color: color.hex });
    ctx.last = item.id;
    ctx.said.push(`Made the ${item.name.toLowerCase()} ${color.word}.`);
    return true;
  }
  return false;
};

/** Split "monitor on the desk" into ["monitor", "on the desk"]. */
function splitPlacement(phrase: string): [string, string] {
  // Padded so a phrase that starts with a placement word ("on the desk") splits into ["", "on the desk"].
  const m = PLACE_START.exec(` ${phrase}`);
  if (!m) return [phrase.trim(), ""];
  return [phrase.slice(0, Math.max(0, m.index - 1)).trim(), phrase.slice(m.index).trim()];
}

/** "put/move X on/to Y": move an existing X, or add one when there is none (or it says "a X"). */
const handleMove: Handler = (clause, lc, ctx) => {
  const m = /^(?:please\s+|can you\s+|could you\s+)?(?:move|put|place|set|slide|push|drag|shift|bring|stand|hang)\s+(.+)$/.exec(lc);
  if (!m) return false;
  const [what, where] = splitPlacement(m[1]);
  if (!where) return false;
  const isNew = /^(?:a|an|another|some|one|two|three|four|\d)\s/.test(what);
  const item = isNew ? null : ctx.find(what);
  if (!item && ctx.suggestion) return notFound(ctx, what);
  if (!item) return addFrom(clause, `add ${what} ${where}`, ctx);
  const placed = settle(parsePlacement(where, ctx, item.id, keyOf(item.name)), ctx);
  if (placed.error) {
    ctx.said.push(`${placed.error}.`);
    return true;
  }
  if (!placed.placement) return false;
  if ((placed.placement.kind === "onTop" || placed.placement.kind === "under") && ctx.restsOn(placed.placement.targetId, item.id)) {
    const target = ctx.entries.find((e) => e.id === (placed.placement as { targetId: string }).targetId);
    ctx.said.push(`The ${target?.name.toLowerCase() ?? "other item"} is on the ${item.name.toLowerCase()}, so the ${item.name.toLowerCase()} can't go on it.`);
    return true;
  }
  if (placed.placement.kind === "onTop") {
    const target = ctx.entries.find((e) => e.id === (placed.placement as { targetId: string }).targetId);
    if (target && tooBigFor(item.dims, target.dims)) {
      ctx.said.push(`The ${item.name.toLowerCase()} is too big to go on the ${target.name.toLowerCase()}.`);
      return true;
    }
  }
  if (item.mount === "ceiling" && (placed.placement.kind === "onTop" || placed.placement.kind === "under")) {
    // A hanging lamp stays on the ceiling: "put the pendant over the desk" hangs it above the desk.
    const t = ctx.scene.items.find((e) => e.id === (placed.placement as { targetId: string }).targetId);
    if (t) {
      // The app hangs it above the target where the target is by then (an earlier step may move it).
      ctx.actions.push({ type: "move", itemId: item.id, placement: { kind: "onTop", targetId: t.id } });
      ctx.last = item.id;
      ctx.said.push(`The ${item.name.toLowerCase()} hangs from the ceiling, so I hung it above the ${t.name.toLowerCase()}.`);
      return true;
    }
  }
  item.supportId = placed.placement.kind === "onTop" || placed.placement.kind === "under" ? placed.placement.targetId : undefined;
  ctx.actions.push({ type: "move", itemId: item.id, placement: placed.placement });
  ctx.last = item.id;
  ctx.said.push(`Moved the ${item.name.toLowerCase()} ${placed.where?.replace(/^in the (\w+) corner$/, "to the $1 corner")}.`);
  return true;
};

const handleAdd: Handler = (clause, lc, ctx) => {
  if (!/^(?:please\s+|can you\s+|could you\s+|let'?s\s+|i (?:want|need|'d like)\s+(?:to add\s+)?)?(?:add|insert|create|place|put|drop|give me|i want|i need)\b/.test(lc)) return false;
  return addFrom(clause, lc, ctx);
};

function addFrom(_clause: string, lc: string, ctx: Ctx): boolean {
  const body = lc
    .replace(/^(?:please\s+|can you\s+|could you\s+|let'?s\s+|i (?:want|need|'d like)\s+(?:to add\s+)?)?(?:add|insert|create|place|put|drop|give me|i want|i need)\s+/, "")
    .replace(/[?.!]+$/, "")
    // Sizes use words that also start placements ("5 by 8", "30 in tall"): rewrite them first.
    .replace(/(\d(?:\.\d+)?\s*(?:ft|feet|foot|'|in|inch|inches|"|cm|mm|m|meters?|metres?)?)\s*\bby\s+(?=\d)/g, "$1 x ")
    .replace(/(\d)\s*in\b(?=\s+(?:wide|tall|high|deep|long)\b)/g, "$1 inch")
    .trim();
  const [whatRaw, where] = splitPlacement(body);
  let count = 1;
  let what = whatRaw;
  const q = /^(a|an|one|another|some|two|three|four|pair of|[1-4])\s+(?!(?:ft|feet|foot|in|inch|inches|cm|m|mm|by|x)\b)/.exec(what);
  if (q) {
    count = q[1] === "pair of" ? 2 : (NUMBER_WORDS[q[1]] ?? Number(q[1]));
    what = what.slice(q[0].length);
  }
  if (POINTER_WORDS.test(what.trim())) {
    // "add it next to the desk" while a search result is previewed in the room = that result.
    const idx = ctx.scene.lastSearch?.previewIndex;
    const r = idx === undefined ? undefined : ctx.scene.lastResults?.find((x) => x.index === idx);
    if (r) return addResult(ctx, r, lc, where);
    ctx.said.push('I\'m not sure what to add. Name it ("add a lamp next to the desk"), or preview a search result first and say "add it".');
    return true;
  }
  const thing = thingFor(what);
  const color = colorIn(what);
  const custom = !thing;
  // "a cozy reading corner" is a wish, not an object: the help reply (and Claude in live mode) handles that better
  // than a box named "Cozy Reading Corner".
  if (custom && (ABSTRACT_WORDS.test(what) || what.split(/\s+/).filter(Boolean).length > 3)) return false;
  const nameWords = what
    .replace(new RegExp(String.raw`${NUM}\s*${UNIT}\s*(?:by|x|×)\s*${NUM}\s*${UNIT}`, "g"), " ")
    .replace(new RegExp(String.raw`${NUM}\s*${UNIT}\s*(?:wide|width|tall|high|height|deep|depth|long|length)?`, "g"), " ")
    .split(/\s+/)
    .filter((w) => w && !colorFrom(w) && !["light", "dark", "new", "big", "small", "little", "large"].includes(w))
    .join(" ");
  if (custom && !nameWords) return false;
  const base: Thing = thing ?? {
    key: "item",
    name: title(nameWords).slice(0, 40),
    words: /$^/,
    dims: { w: 0.5, h: 0.5, d: 0.5 },
    mount: "floor",
    preset: "box",
  };
  const dims = { ...dimsFromText(what, ctx.scene.units, base.dims), ...screenDims(what, base) };
  const placed = settle(parsePlacement(where, ctx, null, base.key), ctx);
  if (placed.error) ctx.said.push(`${placed.error}, so I let the app pick a spot.`);
  let placement = placed.placement;
  let placedWhere = placed.where;
  if (placement && base.mount !== "floor" && (placement.kind === "onTop" || placement.kind === "under" || placement.kind === "nextTo")) placement = undefined;
  const label = (base.key === "lamp" && placement?.kind === "onTop" ? "table lamp" : base.name.toLowerCase()).replace(/^tv$/, "TV");
  if (placement?.kind === "onTop") {
    const target = ctx.entries.find((e) => e.id === (placement as { targetId: string }).targetId);
    if (target && tooBigFor({ ...base.dims, ...dims }, target.dims)) {
      ctx.said.push(`A ${label} is too big to go on the ${target.name.toLowerCase()}, so I let the app pick a spot.`);
      placement = undefined;
      placedWhere = undefined;
    }
  }
  for (let i = 0; i < Math.min(count, 4); i++) {
    let p = placement;
    if (p?.kind === "nextTo" && count > 1 && !p.side) p = { ...p, side: i % 2 ? "right" : "left" };
    addThing(ctx, base, { dims, color }, p);
  }
  const n = Math.min(count, 4);
  ctx.said.push(
    `Added ${n > 1 ? `${n} ${label}s` : `${/^[aeiou]/.test(label) ? "an" : "a"} ${label}`}${placedWhere ? ` ${placedWhere}` : ""}.` +
      (custom ? ` I don't have a shape for that, so it's a box; resize it with e.g. "make the ${label} 3 ft wide".` : ""),
  );
  if (SMALL_ON_SURFACES.has(base.key) && !placement && !placed.error) ctx.said.push("Tip: say \"put it on the desk\" to set it on a surface.");
  return true;
}

/**
 * A screen size is its diagonal: "27 inch monitor" = 16:9 screen 0.6 m wide, 0.34 m tall (plus a thin bezel). The
 * monitor / TV silhouette's screen is 70% of the item's height (the stand is below it).
 */
function screenDims(what: string, base: Thing): Partial<Dims> {
  if (base.key !== "monitor" && base.key !== "tv") return {};
  const m = /(\d+(?:\.\d+)?)\s*(?:"|''|-?\s*inch(?:es)?\b|in\b)/.exec(what);
  if (!m) return {};
  const diag = Number(m[1]) * M_PER_IN;
  if (!(diag > 0.2 && diag < 3)) return {};
  const w = diag * (16 / Math.hypot(16, 9)) + 0.02;
  const screenH = diag * (9 / Math.hypot(16, 9)) + 0.02;
  return { w: r3(w), h: r3(screenH / 0.7) };
}

const handleList: Handler = (_c, lc, ctx) => {
  if (!/\bwhat(?:'s| is)\s+in\s+(?:the|my|this)\s+room\b|^(?:list|show)\s+(?:all\s+)?(?:the\s+)?items\b/.test(lc)) return false;
  const visible = ctx.scene.items.filter((it) => !it.hidden);
  ctx.said.push(visible.length ? `In the room: ${visible.map((it) => it.name).join(", ")}.` : "The room is empty so far.");
  return true;
};

// ---------- design versions ----------

const VERSION_STOP = new Set(["the", "my", "our", "your", "to", "of", "from", "version", "versions", "saved", "one", "back"]);
const versionTokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !VERSION_STOP.has(t));

/** The saved version a phrase names ("option A", "the previous version", "the version from before the chat changes"). */
function findVersion(phrase: string, versions: NonNullable<ChatScene["versions"]>) {
  const p = phrase
    .toLowerCase()
    .replace(/^(?:the|my|our)\s+/, "")
    .replace(/\s+(?:version|one|snapshot)$/, "")
    .trim();
  if (/^(?:previous|last|latest|newest|most\s+recent|saved|earlier|last\s+saved)(?:\s+(?:version|snapshot|save|one|design|layout))?$|^(?:version|snapshot)$/.test(p)) return versions[0] ?? null;
  const exact = versions.find((v) => v.name.trim().toLowerCase() === p || v.name.trim().toLowerCase() === `version ${p}`);
  if (exact) return exact;
  const want = versionTokens(p);
  if (!want.length) return null;
  let best: (typeof versions)[number] | null = null;
  let bestScore = 0;
  for (const v of versions) {
    const have = versionTokens(v.name);
    const shared = want.filter((t) => have.includes(t)).length;
    const score = shared / Math.max(want.length, have.length);
    // Newest first: an equal score keeps the newer one.
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return bestScore >= 0.6 ? best : null;
}

const SAVE_VERSION_RE =
  /^(?:please\s+)?(?:save|snapshot|bookmark)\b(?:\s+(?:this|it|that|everything|(?:the\s+)?(?:current\s+)?(?:design|layout|room|plan|setup)|(?:a|another|the|this)\s+(?:new\s+)?(?:version|snapshot|copy)|version))?(?:\s+(?:as|called|named)\s+(.+))?$/;
const RESTORE_VERSION_RE =
  /^(?:please\s+)?(?:go\s+back\s+to|switch\s+(?:back\s+)?to|restore|revert\s+to|roll\s+back\s+to|load|bring\s+back|show\s+me)\s+(.+)$/;

const handleVersion: Handler = (clause, lc, ctx) => {
  const save = SAVE_VERSION_RE.exec(lc);
  if (save) {
    // The name keeps the user's own casing ("save this as option A" → "Option A").
    const raw = save[1] ? clause.slice(clause.length - save[1].length) : "";
    let name = raw.replace(/^["“'‘]+|["”'’]+$/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (name) name = name[0].toUpperCase() + name.slice(1);
    ctx.actions.push(name ? { type: "saveVersion", name } : { type: "saveVersion" });
    ctx.said.push(name ? `Saved this design as “${name}”.` : "Saved a version of this design.");
    return true;
  }
  const restore = RESTORE_VERSION_RE.exec(lc);
  if (!restore) return false;
  const phrase = restore[1];
  const aboutVersions = /\b(?:versions?|options?|snapshots?|saves?|autosave|layouts?|designs?)\b/.test(phrase);
  // "show me ..." / "load ..." only mean a version when they say so; "go back to" / "restore" also match by name.
  if (/^(?:show\s+me|load|bring\s+back)\b/.test(lc) && !aboutVersions) return false;
  const versions = ctx.scene.versions ?? [];
  const v = findVersion(phrase, versions);
  if (!v) {
    if (!aboutVersions) return false;
    ctx.said.push(versions.length ? `I couldn't find a saved version called "${phrase}". Open Versions in the toolbar to see them all.` : "There are no saved versions yet. Say \"save this as option A\" to keep one.");
    return true;
  }
  ctx.actions.push({ type: "restoreVersion", versionId: v.id });
  ctx.said.push(`Restored “${v.name}”. The design you had is still in Versions.`);
  return true;
};

const HANDLERS: Handler[] = [
  handleVersion,
  handleUndo,
  handleList,
  handleLighting,
  handleOpening,
  handleCandidate,
  handleSearch,
  handleRoom,
  handleCamera,
  handleRemove,
  handleRename,
  handleDuplicate,
  handleSelect,
  handleRotate,
  handleMake,
  handleSwap,
  handleHide,
  handleOff,
  handleHang,
  handleMove,
  handleAdd,
];

const CLAUSE_SPLIT =
  /\s*(?:;|\.\s+|,?\s+(?:and\s+)?then\s+|,\s*(?=(?:add|put|place|move|make|rotate|turn|delete|remove|paint|find|search|undo|rename|select|duplicate|switch|close|open|dim|save|hang)\b)|\s+and\s+(?=(?:add|put|place|move|make|rotate|turn|delete|remove|paint|color|colour|find|search|undo|rename|select|duplicate|also|switch|close|open|dim|save|hang)\b))\s*/i;

export function helpReply(): string {
  return (
    `I'm the demo parser (no AI in demo mode), so I understand simple commands like: ${MOCK_CHAT_EXAMPLES.map((e) => `"${e}"`).join(", ")}. ` +
    "Natural requests (\"make a cozy reading corner\", \"move everything away from the window\") need Claude: start the app with your Claude subscription or an API key (see the README)."
  );
}

/** Turn one chat message into actions + a short reply, deterministically. */
export function mockChatReply(req: Pick<ChatRequest, "message" | "scene">): MockChatResult {
  const ctx = new Ctx(req.scene);
  const clauses = req.message
    .trim()
    .split(CLAUSE_SPLIT)
    .map((c) => c.replace(/^(?:also|and|then|now|ok(?:ay)?|please)[, ]+/i, "").trim())
    .filter(Boolean);
  let understood = 0;
  for (const clause of clauses) {
    const c = clause.replace(/[?!.]+$/, "").trim();
    const lc = c.toLowerCase();
    if (!lc || /^(?:help|what can you do|hi|hello|hey)\b/.test(lc)) continue;
    if (HANDLERS.some((h) => h(c, lc, ctx))) understood++;
  }
  if (!understood) return { reply: helpReply(), actions: [] };
  return { reply: ctx.said.join(" "), actions: ctx.actions };
}
