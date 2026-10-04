// Lighting in chat: the sanitizer's setLighting / setLight / setWindow, the demo parser's lighting commands, and what
// the prompt's scene JSON tells the model about lights, blinds and the mode.
import { describe, expect, it } from "vitest";
import type { ChatAction, ChatScene } from "../src/shared/types";
import { mockChatReply } from "./mockChat";
import { sanitizeChatOutput } from "./sanitizeChat";
import { ChatOutputSchema, ChatRequestSchema } from "./schemas";
import { CHAT_SYSTEM, chatSceneJson } from "./prompts";
import { colorWarmth } from "../src/lib/lighting";

const scene: ChatScene = {
  units: "imperial",
  room: {
    name: "Bedroom",
    width: 3.66,
    depth: 3.35,
    height: 2.44,
    wallColor: "#e9e4dc",
    floorColor: "#b89874",
    openings: [
      { id: "door_1", kind: "door", wall: "south", offset: 0.6, width: 0.81, height: 2.03, sill: 0 },
      { id: "win_n", kind: "window", wall: "north", offset: 1.83, width: 1.2, height: 1.2, sill: 0.9 },
      { id: "win_e", kind: "window", wall: "east", offset: 2.2, width: 0.9, height: 1.2, sill: 0.9, covering: "closed" },
    ],
  },
  items: [
    { id: "desk_1", name: "Desk", dims: { w: 1.2, h: 0.75, d: 0.6 }, position: { x: 1.5, y: 0, z: 0.4 }, rotationY: -Math.PI / 2, mount: "floor", color: "#9c7b57", origin: "shape" },
    { id: "pend_1", name: "Hanging lamp", dims: { w: 0.4, h: 0.9, d: 0.4 }, position: { x: 0, y: 1.54, z: 0 }, rotationY: 0, mount: "ceiling", color: "#f2e6c9", origin: "shape", light: { on: true, color: "#ffd8a8", intensity: 0.7 } },
    { id: "flamp_1", name: "Floor lamp", dims: { w: 0.4, h: 1.6, d: 0.4 }, position: { x: -1.4, y: 0, z: 1.3 }, rotationY: 0, mount: "floor", color: "#f2e6c9", origin: "shape", light: { on: false, color: "#ffd8a8", intensity: 0.5 } },
    { id: "bed_1", name: "Bed", dims: { w: 1.6, h: 0.6, d: 2.1 }, position: { x: -0.8, y: 0, z: 0 }, rotationY: 0, mount: "floor", color: "#c9c2b6", origin: "shape" },
  ],
  selectedId: null,
  lighting: "day",
};

function chat(message: string, s: ChatScene = scene) {
  const raw = mockChatReply({ message, scene: s });
  const out = sanitizeChatOutput(raw, s);
  expect(out.dropped, `sanitizer dropped steps for "${message}"`).toEqual([]);
  return { reply: out.reply, actions: out.actions };
}

const sanitize = (actions: unknown[], s: ChatScene = scene) => sanitizeChatOutput({ reply: "ok", actions }, s);

describe("sanitizer: lighting actions", () => {
  it("setLighting accepts the three modes (and a few words for them), nothing else", () => {
    expect(sanitize([{ type: "setLighting", mode: "Night" }]).actions).toEqual([{ type: "setLighting", mode: "night" }]);
    expect(sanitize([{ type: "setlighting", mode: "sunset" }]).actions).toEqual([{ type: "setLighting", mode: "evening" }]);
    const bad = sanitize([{ type: "setLighting", mode: "disco" }]);
    expect(bad.actions).toEqual([]);
    expect(bad.skipped[0].reason).toContain("disco");
  });

  it("setLight: on/off from the keep sentinel or a boolean, brightness 0..1 (or a percentage), light color words", () => {
    expect(sanitize([{ type: "setLight", itemId: "pend_1", on: "off", intensity: -1, color: "" }]).actions).toEqual([{ type: "setLight", itemId: "pend_1", on: false }]);
    expect(sanitize([{ type: "setLight", itemId: "Floor lamp", on: true }]).actions).toEqual([{ type: "setLight", itemId: "flamp_1", on: true }]);
    expect(sanitize([{ type: "setLight", itemId: "pend_1", on: "keep", intensity: 80, color: "warm white" }]).actions).toEqual([
      { type: "setLight", itemId: "pend_1", intensity: 0.8, color: "#ffd8a8" },
    ]);
    expect(sanitize([{ type: "setLight", itemId: "pend_1", on: "keep", intensity: 1.7, color: "#C8DCFF" }]).actions).toEqual([
      { type: "setLight", itemId: "pend_1", intensity: 0.017, color: "#c8dcff" },
    ]);
    expect(sanitize([{ type: "setLight", itemId: "pend_1", on: "keep", intensity: -1, color: "" }]).skipped[0].reason).toContain("nothing to change");
    expect(sanitize([{ type: "setLight", itemId: "nope", on: "on" }]).skipped[0].reason).toContain("unknown item");
  });

  it("setWindow: a window id or * for all, open / closed; doors and unknown ids are refused", () => {
    expect(sanitize([{ type: "setWindow", openingId: "win_n", covering: "closed" }]).actions).toEqual([{ type: "setWindow", openingId: "win_n", covering: "closed" }]);
    expect(sanitize([{ type: "setWindow", openingId: "*", covering: "shut" }]).actions).toEqual([{ type: "setWindow", openingId: "*", covering: "closed" }]);
    expect(sanitize([{ type: "setWindow", openingId: "all", covering: "up" }]).actions).toEqual([{ type: "setWindow", openingId: "*", covering: "open" }]);
    expect(sanitize([{ type: "setWindow", openingId: "door_1", covering: "closed" }]).skipped[0].reason).toContain("door");
    expect(sanitize([{ type: "setWindow", openingId: "win_x", covering: "closed" }]).skipped[0].reason).toContain("unknown window");
    expect(sanitize([{ type: "setWindow", openingId: "win_n", covering: "ajar" }]).skipped[0].reason).toContain("ajar");
    const noWindows = { ...scene, room: { ...scene.room, openings: [scene.room.openings[0]] } };
    expect(sanitize([{ type: "setWindow", openingId: "*", covering: "closed" }], noWindows).skipped[0].reason).toContain("no windows");
  });

  it("the output schema takes the new actions with their sentinels", () => {
    const ok = ChatOutputSchema.safeParse({
      reply: "Night it is.",
      actions: [
        { type: "setLighting", mode: "night" },
        { type: "setLight", itemId: "pend_1", on: "off", intensity: -1, color: "" },
        { type: "setWindow", openingId: "*", covering: "closed" },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("the request schema keeps lights, blinds and the mode (and still accepts a scene without them)", () => {
    const parsed = ChatRequestSchema.parse({ message: "hi", scene });
    expect(parsed.scene.lighting).toBe("day");
    expect(parsed.scene.items.find((it) => it.id === "pend_1")?.light).toEqual({ on: true, color: "#ffd8a8", intensity: 0.7 });
    expect(parsed.scene.room.openings.find((o) => o.id === "win_e")?.covering).toBe("closed");
    const old = { ...scene, lighting: undefined, items: scene.items.map(({ light: _l, ...it }) => it) };
    expect(ChatRequestSchema.safeParse({ message: "hi", scene: old }).success).toBe(true);
  });
});

describe("prompt: lighting in the scene JSON", () => {
  it("lists the mode, each light and closed blinds", () => {
    const json = JSON.parse(chatSceneJson(scene));
    expect(json.lighting).toBe("day");
    expect(json.items.find((it: { id: string }) => it.id === "pend_1").light).toEqual({ on: true, intensity: 0.7, color: "#ffd8a8" });
    expect(json.items.find((it: { id: string }) => it.id === "desk_1").light).toBeUndefined();
    expect(json.room.openings.find((o: { id: string }) => o.id === "win_e").covering).toBe("closed");
    expect(json.room.openings.find((o: { id: string }) => o.id === "win_n").covering).toBeUndefined();
    expect(CHAT_SYSTEM).toContain("setLighting");
    expect(CHAT_SYSTEM).toContain("setWindow");
  });
});

describe("demo parser: lighting commands", () => {
  it.each([
    ["make it night", "night"],
    ["switch to evening", "evening"],
    ["night mode", "night"],
    ["set the lighting to day", "day"],
    ["show me the room at night", "night"],
    ["it's evening", "evening"],
  ])("%s → %s", (msg, mode) => {
    const { actions, reply } = chat(msg);
    expect(actions).toEqual([{ type: "setLighting", mode }]);
    expect(reply.toLowerCase()).toContain(mode);
  });

  it("turns lights on and off by name, or all of them", () => {
    expect(chat("turn off the pendant").actions).toEqual([{ type: "setLight", itemId: "pend_1", on: false }]);
    expect(chat("turn the floor lamp on").actions).toEqual([{ type: "setLight", itemId: "flamp_1", on: true }]);
    expect(chat("switch off the hanging lamp").actions).toEqual([{ type: "setLight", itemId: "pend_1", on: false }]);
    const all = chat("turn off all the lights");
    expect(all.actions).toEqual([
      { type: "setLight", itemId: "pend_1", on: false },
      { type: "setLight", itemId: "flamp_1", on: false },
    ]);
    expect(all.reply).toContain("all 2 lights");
    expect(chat("lights on").actions).toHaveLength(2);
  });

  it("doesn't treat other things as lights", () => {
    const desk = chat("turn off the desk");
    expect(desk.actions).toEqual([]);
    expect(desk.reply).toContain("isn't a light");
    // Not lighting at all: falls through to the other handlers.
    expect(chat("turn the desk 90").actions[0]?.type).not.toBe("setLight");
  });

  it("makes a light warmer / cooler / brighter / dimmer from its current settings", () => {
    const warmer = chat("make the pendant warmer").actions[0] as Extract<ChatAction, { type: "setLight" }>;
    expect(warmer.itemId).toBe("pend_1");
    expect(colorWarmth(warmer.color!)).toBeGreaterThan(colorWarmth("#ffd8a8") + 0.1);
    const cooler = chat("make the lamp a bit cooler", { ...scene, selectedId: null }).actions[0] as Extract<ChatAction, { type: "setLight" }>;
    expect(colorWarmth(cooler.color!)).toBeLessThan(colorWarmth("#ffd8a8") - 0.1);
    expect(chat("make the pendant brighter").actions).toEqual([{ type: "setLight", itemId: "pend_1", intensity: 0.95 }]);
    expect(chat("dim the pendant").actions).toEqual([{ type: "setLight", itemId: "pend_1", intensity: 0.45 }]);
    // Brightening a light that is off turns it on.
    expect(chat("make the floor lamp brighter").actions).toEqual([{ type: "setLight", itemId: "flamp_1", intensity: 0.75, on: true }]);
    expect(chat("set the pendant to 30%").actions).toEqual([{ type: "setLight", itemId: "pend_1", intensity: 0.3 }]);
    // "it" = the selected lamp.
    expect(chat("make it warmer", { ...scene, selectedId: "flamp_1" }).actions[0]).toMatchObject({ type: "setLight", itemId: "flamp_1" });
  });

  it("leaves color requests for non-lights to the other handlers", () => {
    expect(chat("make the desk darker").actions.every((a) => a.type !== "setLight")).toBe(true);
    expect(chat("make the desk red").actions).toEqual([{ type: "recolor", itemId: "desk_1", color: "#c0392b" }]);
  });

  it("closes / opens the blinds: all windows, one wall, or the window by an item", () => {
    expect(chat("close the blinds").actions).toEqual([{ type: "setWindow", openingId: "*", covering: "closed" }]);
    expect(chat("draw the curtains").actions).toEqual([{ type: "setWindow", openingId: "*", covering: "closed" }]);
    expect(chat("open all the windows").actions).toEqual([{ type: "setWindow", openingId: "*", covering: "open" }]);
    expect(chat("close the north window").actions).toEqual([{ type: "setWindow", openingId: "win_n", covering: "closed" }]);
    expect(chat("open the blinds on the east wall").actions).toEqual([{ type: "setWindow", openingId: "win_e", covering: "open" }]);
    const byDesk = chat("open the window by the desk");
    expect(byDesk.actions).toEqual([{ type: "setWindow", openingId: "win_e", covering: "open" }]);
    expect(byDesk.reply).toContain("by the desk");
    expect(chat("close the window by the bed").actions).toEqual([{ type: "setWindow", openingId: "win_n", covering: "closed" }]);
  });

  it("handles several lighting steps in one message", () => {
    const { actions } = chat("make it night and turn off the pendant, then close the blinds");
    expect(actions.map((a) => a.type)).toEqual(["setLighting", "setLight", "setWindow"]);
  });

  it("adds a floor lamp by the bed as before (the app gives it a light)", () => {
    const { actions } = chat("add a floor lamp next to the bed");
    expect(actions[0]).toMatchObject({ type: "addShape", name: "Floor lamp", placement: { kind: "nextTo", targetId: "bed_1" } });
  });
});

describe("demo parser: review round 3 (two changes in one lamp command, moods, cat tower levels)", () => {
  it("“make the pendant cooler and brighter” changes both, and says both", () => {
    const { reply, actions } = chat("make the pendant cooler and brighter");
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<ChatAction, { type: "setLight" }>;
    expect(a).toMatchObject({ type: "setLight", itemId: "pend_1", intensity: 0.95 });
    expect(colorWarmth(a.color!)).toBeLessThan(colorWarmth("#ffd8a8"));
    expect(reply).toMatch(/cooler and brighter/);
  });

  it("“movie night” is lighting: night, every lamp on and low, blinds closed; no furniture", () => {
    const { actions } = chat("movie night");
    expect(actions[0]).toEqual({ type: "setLighting", mode: "night" });
    expect(actions.filter((a) => a.type === "setLight")).toEqual([
      { type: "setLight", itemId: "pend_1", on: true, intensity: 0.3 },
      { type: "setLight", itemId: "flamp_1", on: true, intensity: 0.3 },
    ]);
    expect(actions).toContainEqual({ type: "setWindow", openingId: "*", covering: "closed" });
    expect(actions.some((a) => a.type === "addShape")).toBe(false);
    const cozy = chat("cozy evening vibe").actions;
    expect(cozy[0]).toEqual({ type: "setLighting", mode: "evening" });
    expect(cozy.filter((a) => a.type === "setLight")).toHaveLength(2);
  });

  it("cat tower levels: “the cat tower's base”, “the lower platform” (no “of …” with one multi-level item)", () => {
    const s: ChatScene = {
      ...scene,
      items: [
        ...scene.items,
        {
          id: "tower_1", name: "Cat tower", dims: { w: 0.6, h: 1.5, d: 0.6 }, position: { x: -0.6, y: 0, z: -0.4 }, rotationY: 0, mount: "floor", color: "#cdbfa8", origin: "shape",
          levels: [{ name: "top", y: 1.5, kind: "platform" }, { name: "middle level", y: 0.945, kind: "platform" }, { name: "bottom level", y: 0.675, kind: "box" }],
        },
        { id: "cat_1", name: "Cat", dims: { w: 0.25, h: 0.3, d: 0.45 }, position: { x: 1, y: 0, z: 1 }, rotationY: 0, mount: "floor", color: "#c98a4b", origin: "shape" },
      ],
    };
    expect(chat("put the cat on the cat tower's base", s).actions).toEqual([{ type: "move", itemId: "cat_1", placement: { kind: "onTop", targetId: "tower_1", level: "bottom" } }]);
    // The lower PLATFORM is the platform below the top (the condo box roof is not a platform).
    expect(chat("put the cat on the lower platform", s).actions).toEqual([{ type: "move", itemId: "cat_1", placement: { kind: "onTop", targetId: "tower_1", level: "middle" } }]);
    expect(chat("put the cat on the middle level", s).actions).toEqual([{ type: "move", itemId: "cat_1", placement: { kind: "onTop", targetId: "tower_1", level: "middle" } }]);
    // The model sees the levels too.
    expect(chatSceneJson(s)).toContain('"levels":[{"name":"top","y":1.5,"kind":"platform"}');
    expect(ChatRequestSchema.safeParse({ message: "hi", history: [], scene: { ...s, now: "Sat, Oct 3, 6:40 PM" } }).success).toBe(true);
  });
});
