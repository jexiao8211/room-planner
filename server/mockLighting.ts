// Demo-mode chat (mockChat.ts): lighting commands. "make it night", "turn off the pendant", "make the lamp warmer",
// "dim the floor lamp", "lights off", "close the blinds", "open the window by the desk".
import type { ChatAction, ChatScene, LightSettings, LightingMode, Opening, WallSide } from "../src/shared/types";
import { DEFAULT_LIGHT, LIGHT_STEP, clamp01, colorWarmth, isLampLike, lightingMode, warmthColor, windowCovering } from "../src/lib/lighting";

/** The bits of the mock parser's context this handler uses. */
export interface LightingCtx {
  readonly scene: ChatScene;
  readonly actions: ChatAction[];
  readonly said: string[];
  last: string | null;
  find(phrase: string): { id: string; name: string } | null;
}

const MODE_WORD: Record<string, LightingMode> = {
  day: "day",
  daytime: "day",
  daylight: "day",
  morning: "day",
  afternoon: "day",
  evening: "evening",
  dusk: "evening",
  sunset: "evening",
  night: "night",
  nighttime: "night",
  "night time": "night",
  dark: "night",
};
const MODE_RE = String.raw`(day(?:time|light)?|morning|afternoon|evening|dusk|sunset|night(?:\s?time)?|dark)`;
const WALL_WORD: Record<string, WallSide> = {
  north: "north",
  back: "north",
  south: "south",
  front: "south",
  east: "east",
  right: "east",
  west: "west",
  left: "west",
};
const ALL_LIGHTS = /^(?:all\s+(?:of\s+)?)?(?:the\s+|my\s+)?(?:lights|lamps|lighting|everything)$|^(?:all|every)\s+(?:the\s+)?(?:lights?|lamps?)$/;

const lc = (s: string) => s.toLowerCase();

/** "make it night", "night mode", "switch to evening", "set the lighting to day". */
function handleMode(text: string, ctx: LightingCtx): boolean {
  const m =
    new RegExp(String.raw`^(?:please\s+)?(?:make\s+it|switch(?:\s+it)?\s+to|change(?:\s+it)?\s+to|go\s+to|set\s+(?:the\s+)?(?:lighting|lights|light|mode|time(?:\s+of\s+day)?)\s+to|change\s+(?:the\s+)?(?:lighting|light|mode)\s+to|show(?:\s+me)?(?:\s+the\s+room)?(?:\s+(?:at|in))?)\s+(?:the\s+)?${MODE_RE}(?:\s+(?:mode|lighting|time|light))?$`).exec(text) ??
    new RegExp(String.raw`^${MODE_RE}\s*(?:mode|lighting|time|light)?$`).exec(text) ??
    new RegExp(String.raw`^(?:it'?s|it\s+is)\s+${MODE_RE}(?:\s+now)?$`).exec(text);
  if (!m) return false;
  const mode = MODE_WORD[m[1].replace(/\s+/g, " ")] ?? "day";
  ctx.actions.push({ type: "setLighting", mode });
  const now = lightingMode(ctx.scene.lighting);
  ctx.said.push(now === mode ? `It's already ${mode} lighting.` : `Switched to ${mode} lighting.`);
  return true;
}

/** Current light of an item, including changes made earlier in this message. */
function lightOf(ctx: LightingCtx, id: string): LightSettings | undefined {
  let light: LightSettings | undefined = ctx.scene.items.find((it) => it.id === id)?.light;
  for (const a of ctx.actions) {
    if (a.type !== "setLight" || a.itemId !== id) continue;
    light = { ...(light ?? DEFAULT_LIGHT) };
    if (a.on !== undefined) light.on = a.on;
    if (a.intensity !== undefined) light.intensity = a.intensity;
    if (a.color) light.color = a.color;
  }
  return light;
}

const LAMP_WORDS = /\b(?:lights?|lamps?|pendants?|sconces?|chandeliers?|lanterns?)\b/;

/** The lights a lamp-type phrase means when no item is named like it ("the pendant" for an item called "Hanging lamp"). */
function lightsOfKind(p: string, ctx: LightingCtx): string[] {
  const lights = ctx.scene.items.filter((it) => !!lightOf(ctx, it.id) || isLampLike(it.name));
  let pick = lights;
  if (/\b(?:pendants?|hanging|ceiling|chandeliers?)\b/.test(p)) pick = lights.filter((it) => it.mount === "ceiling");
  else if (/\b(?:floor|standing)\s+(?:lamps?|lights?)\b/.test(p)) pick = lights.filter((it) => it.mount === "floor" && it.dims.h > 1);
  else if (/\b(?:table|desk|bedside|reading|nightstand)\s+(?:lamps?|lights?)\b/.test(p)) pick = lights.filter((it) => it.mount === "floor" && it.dims.h <= 1);
  else if (/\b(?:sconces?|wall\s+(?:lamps?|lights?))\b/.test(p)) pick = lights.filter((it) => it.mount === "wall");
  else if (!/^(?:the\s+|my\s+|this\s+|that\s+)?(?:lamp|light)$/.test(p)) pick = [];
  return pick.length ? [pick[pick.length - 1].id] : [];
}

/** Items a phrase names as lights: "the lights" = every light, otherwise the matching item. */
function lightTargets(phrase: string, ctx: LightingCtx): { ids: string[]; all: boolean } | null {
  const p = lc(phrase).trim().replace(/[?.!,]+$/, "");
  if (ALL_LIGHTS.test(p)) {
    const ids = ctx.scene.items.filter((it) => lightOf(ctx, it.id) || isLampLike(it.name)).map((it) => it.id);
    return { ids, all: true };
  }
  const found = ctx.find(p);
  const isLight = (id: string) => !!lightOf(ctx, id) || isLampLike(nameOf(ctx, id));
  // "the desk lamp" must not land on the desk: a lamp word prefers a light of that kind.
  if (found && (isLight(found.id) || !LAMP_WORDS.test(p))) return { ids: [found.id], all: false };
  const kind = LAMP_WORDS.test(p) ? lightsOfKind(p, ctx) : [];
  if (kind.length) return { ids: kind, all: false };
  if (found) return { ids: [found.id], all: false };
  return null;
}

const nameOf = (ctx: LightingCtx, id: string) => lc(ctx.scene.items.find((it) => it.id === id)?.name ?? ctx.find(id)?.name ?? "light");

/** "turn off the pendant", "switch the lamp on", "lights off", "turn on all the lamps". */
function handleOnOff(text: string, ctx: LightingCtx): boolean {
  let state: string;
  let phrase: string;
  let m = /^(?:please\s+)?(?:turn|switch|flip)\s+(on|off)\s+(.+)$/.exec(text);
  if (m) [state, phrase] = [m[1], m[2]];
  else if ((m = /^(?:please\s+)?(?:turn|switch|flip)\s+(.+?)\s+(on|off)$/.exec(text))) [phrase, state] = [m[1], m[2]];
  else if ((m = /^(?:all\s+)?(?:the\s+)?(lights|lamps)\s+(on|off)$/.exec(text))) [phrase, state] = [m[1], m[2]];
  else return false;
  const targets = lightTargets(phrase, ctx);
  if (!targets) {
    // "turn on the TV" etc. is not a light we know about.
    if (!LAMP_WORDS.test(phrase)) return false;
    ctx.said.push(`I couldn't find "${phrase.replace(/^(?:the|a|my)\s+/, "")}" in the room.`);
    return true;
  }
  if (!targets.ids.length) {
    ctx.said.push('There are no lights in the room yet. Try "add a floor lamp next to the bed".');
    return true;
  }
  const id0 = targets.ids[0];
  if (!targets.all && !lightOf(ctx, id0) && !isLampLike(nameOf(ctx, id0))) {
    ctx.said.push(`The ${nameOf(ctx, id0)} isn't a light. (Select it and use "Make it a light source" in the inspector if it should be.)`);
    return true;
  }
  const on = state === "on";
  for (const id of targets.ids) ctx.actions.push({ type: "setLight", itemId: id, on });
  if (!targets.all) ctx.last = id0;
  ctx.said.push(targets.all ? `Turned ${state} all ${targets.ids.length} light${targets.ids.length === 1 ? "" : "s"}.` : `Turned ${state} the ${nameOf(ctx, id0)}.`);
  return true;
}

const ADJ = String.raw`(?:a\s+(?:bit|little)\s+|much\s+|slightly\s+)?(?:warmer|cooler|colder|brighter|dimmer|darker|softer)`;

/**
 * "make the lamp warmer / cooler / brighter / dimmer", "make the pendant cooler and brighter" (both), "dim the
 * pendant", "set the lamp to 40%".
 */
function handleAdjust(text: string, ctx: LightingCtx): boolean {
  let phrase: string | null = null;
  let how: string | null = null;
  let percent: number | null = null;
  const make = new RegExp(String.raw`^(?:please\s+)?(?:make|set|turn)\s+(.+?)\s+(${ADJ}(?:\s*(?:,\s*(?:and\s+)?|and\s+|&\s*)${ADJ})*)(?:\s+(?:light|please))?$`).exec(text);
  const verb = /^(?:please\s+)?(dim|brighten|warm\s+up|cool\s+down)\s+(.+?)(?:\s+(?:a\s+bit|a\s+little|down|up))?(?:\s+to\s+(\d{1,3})\s*%)?$/.exec(text);
  const pct = /^(?:please\s+)?(?:set|dim|turn|make)\s+(.+?)\s+(?:to|at)\s+(\d{1,3})\s*%(?:\s+(?:brightness|bright))?$/.exec(text);
  if (make) [phrase, how] = [make[1], make[2].replace(/\b(?:a\s+(?:bit|little)|much|slightly)\s+/g, "")];
  else if (pct) [phrase, how, percent] = [pct[1], "set", Number(pct[2])];
  else if (verb) [phrase, how, percent] = [verb[2], verb[1].replace(/\s+/g, " "), verb[3] ? Number(verb[3]) : null];
  if (!phrase || !how) return false;
  const targets = lightTargets(phrase, ctx);
  if (!targets || !targets.ids.length) return false;
  // Only lights: "make the desk darker" is about its color (handleMake), not a light.
  const ids = targets.ids.filter((id) => lightOf(ctx, id) || isLampLike(nameOf(ctx, id)));
  if (!ids.length) return false;
  // One or more adjustments ("cooler and brighter": a color and a brightness change in one setLight).
  const hows = percent !== null ? ["set"] : how.split(/\s*(?:,\s*(?:and\s+)?|\band\s+|&\s*)/).map((h) => h.trim()).filter(Boolean);
  const words: string[] = [];
  for (const id of ids) {
    const cur = lightOf(ctx, id) ?? DEFAULT_LIGHT;
    const action: Extract<ChatAction, { type: "setLight" }> = { type: "setLight", itemId: id };
    words.length = 0;
    for (const h of hows) {
      if (percent !== null) {
        action.intensity = clamp01(percent / 100);
        words.push(`${Math.round(action.intensity * 100)}% brightness`);
      } else if (h === "warmer" || h === "warm up") {
        action.color = warmthColor(colorWarmth(cur.color) + LIGHT_STEP);
        words.push("warmer");
      } else if (h === "cooler" || h === "colder" || h === "cool down") {
        action.color = warmthColor(colorWarmth(cur.color) - LIGHT_STEP);
        words.push("cooler");
      } else if (h === "brighter" || h === "brighten") {
        action.intensity = clamp01(Math.round((cur.intensity + LIGHT_STEP) * 100) / 100);
        words.push("brighter");
      } else {
        action.intensity = clamp01(Math.round((cur.intensity - LIGHT_STEP) * 100) / 100);
        words.push("dimmer");
      }
    }
    if (action.intensity !== undefined && action.intensity > 0 && !cur.on) action.on = true;
    ctx.actions.push(action);
  }
  if (!targets.all) ctx.last = ids[0];
  const said = [...new Set(words)].join(" and ");
  const sentence = said.endsWith("brightness") ? `Set the ${targets.all ? "lights" : nameOf(ctx, ids[0])} to ${said}` : `Made the ${targets.all ? "lights" : nameOf(ctx, ids[0])} ${said}`;
  ctx.said.push(`${sentence}.`);
  return true;
}

function windowCenter(o: Opening, room: ChatScene["room"]): { x: number; z: number } {
  const hw = room.width / 2;
  const hd = room.depth / 2;
  switch (o.wall) {
    case "north":
      return { x: -hw + o.offset, z: -hd };
    case "south":
      return { x: -hw + o.offset, z: hd };
    case "west":
      return { x: -hw, z: -hd + o.offset };
    case "east":
      return { x: hw, z: -hd + o.offset };
  }
}

/** "close the blinds", "open the curtains", "open the window by the desk", "close the east window". */
function handleBlinds(text: string, ctx: LightingCtx): boolean {
  const m =
    /^(?:please\s+)?(open(?:\s+up)?|close|shut|draw|raise|lower|pull\s+(?:down|up)|put\s+(?:down|up))\s+(?:all\s+(?:of\s+)?)?(?:the\s+|my\s+)?(?:(north|south|east|west|back|front|left|right)(?:ern)?\s+)?(blinds?|curtains?|shades?|drapes?|windows?)(?:\s+(.+))?$/.exec(text);
  if (!m) return false;
  const covering: "open" | "closed" = /^(?:open|raise|pull\s+up|put\s+up)/.test(m[1]) ? "open" : "closed";
  const windows = ctx.scene.room.openings.filter((o) => o.kind === "window");
  if (!windows.length) {
    ctx.said.push("This room has no windows. Try \"add a window on the north wall\".");
    return true;
  }
  const qualifier = (m[4] ?? "").trim();
  let wall = m[2] ? WALL_WORD[m[2]] : undefined;
  const onWall = /^(?:on|in|of)\s+(?:the\s+)?(north|south|east|west|back|front|left|right)(?:ern)?\s+(?:wall|side)$/.exec(qualifier);
  if (onWall) wall = WALL_WORD[onWall[1]];
  let targets: Opening[] = wall ? windows.filter((o) => o.wall === wall) : windows;
  let where = wall ? ` on the ${wall} wall` : "";
  const near = /^(?:by|near|next\s+to|beside|behind|over|above|closest\s+to|nearest(?:\s+to)?)\s+(.+)$/.exec(qualifier);
  if (near) {
    const it = ctx.find(near[1]);
    const item = it ? ctx.scene.items.find((x) => x.id === it.id) : undefined;
    if (!it || !item) {
      ctx.said.push(`I couldn't find "${near[1].replace(/^(?:the|a|my)\s+/, "")}" in the room.`);
      return true;
    }
    const d = (o: Opening) => {
      const c = windowCenter(o, ctx.scene.room);
      return Math.hypot(c.x - item.position.x, c.z - item.position.z);
    };
    targets = [[...targets].sort((a, b) => d(a) - d(b))[0]];
    where = ` by the ${lc(item.name)}`;
  } else if (qualifier && !onWall && !/^(?:please|now|again|too|as well)$/.test(qualifier)) {
    return false;
  }
  if (!targets.length) {
    ctx.said.push(`There's no window on the ${wall} wall.`);
    return true;
  }
  const all = targets.length === windows.length && targets.length > 1;
  const id = all ? "*" : targets.length === 1 ? targets[0].id : null;
  if (id) ctx.actions.push({ type: "setWindow", openingId: id, covering });
  else for (const o of targets) ctx.actions.push({ type: "setWindow", openingId: o.id, covering });
  const already = targets.every((o) => windowCovering(o) === covering);
  const what = targets.length === 1 ? `the window${where || ` on the ${targets[0].wall} wall`}` : `all ${targets.length} windows${where}`;
  ctx.said.push(already ? `The blinds on ${what} are already ${covering}.` : `${covering === "closed" ? "Closed" : "Opened"} the blinds on ${what}.`);
  return true;
}

/**
 * Mood requests are about light first: "movie night" = night, blinds closed, lamps on and dimmed to 30%; "cozy (evening)"
 * = evening, lamps on, warmer, at 50%. No furniture is added; the reply suggests it instead.
 */
function handleMood(text: string, ctx: LightingCtx): boolean {
  const movie =
    /^(?:let'?s\s+(?:have\s+)?(?:a\s+)?|make\s+it\s+(?:a\s+)?|set\s+(?:it\s+|the\s+room\s+)?up\s+for\s+(?:a\s+)?|it'?s\s+)?movie\s+night(?:\s+(?:mode|vibes?|lighting))?$/.test(text) ||
    /^close\s+everything,?\s+it'?s\s+movie\s+night$/.test(text);
  const cozy =
    /^(?:(?:make\s+it|give\s+me|set\s+up)\s+(?:a\s+|the\s+room\s+)?)?(?:cozy|cosy)(?:\s+(?:evening|night))?(?:\s+(?:vibes?|mood|lighting|feel|atmosphere))?$/.test(text) ||
    /^make\s+(?:it|the\s+room)\s+(?:feel\s+)?(?:cozy|cosy)$/.test(text);
  if (!movie && !cozy) return false;
  const mode: LightingMode = movie ? "night" : "evening";
  ctx.actions.push({ type: "setLighting", mode });
  const lamps = ctx.scene.items.filter((it) => !it.hidden && (lightOf(ctx, it.id) || isLampLike(it.name)));
  for (const it of lamps) {
    const cur = lightOf(ctx, it.id) ?? DEFAULT_LIGHT;
    const action: Extract<ChatAction, { type: "setLight" }> = { type: "setLight", itemId: it.id, on: true, intensity: movie ? 0.3 : 0.5 };
    if (cozy) action.color = warmthColor(colorWarmth(cur.color) + LIGHT_STEP);
    ctx.actions.push(action);
  }
  if (movie && ctx.scene.room.openings.some((o) => o.kind === "window")) ctx.actions.push({ type: "setWindow", openingId: "*", covering: "closed" });
  const noLamps = ' There are no lamps yet: try "add a floor lamp next to the bed".';
  const lampWords = lamps.length === 1 ? "the lamp" : `all ${lamps.length} lamps`;
  ctx.said.push(
    movie
      ? `Movie night: night lighting, blinds closed${lamps.length ? `, ${lampWords} on and dimmed low` : ""}.${lamps.length ? "" : noLamps}`
      : `Cozy evening: evening light${lamps.length ? `, ${lampWords} on, warmer and softer` : ""}.${lamps.length ? " A rug or a plant would warm it up too, just ask." : noLamps}`,
  );
  return true;
}

/** One clause of a chat message (lowercase, no trailing punctuation). True when it was a lighting command. */
export function handleLighting(_clause: string, text: string, ctx: LightingCtx): boolean {
  return handleMood(text, ctx) || handleMode(text, ctx) || handleOnOff(text, ctx) || handleBlinds(text, ctx) || handleAdjust(text, ctx);
}
