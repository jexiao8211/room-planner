// The demo-mode chat parser (rule-based, deterministic), checked after the same sanitizer the server applies.
import { describe, expect, it } from "vitest";
import type { ChatAction, ChatScene } from "../src/shared/types";
import { MOCK_CHAT_EXAMPLES, helpReply, mockChatReply } from "./mockChat";
import { sanitizeChatOutput } from "./sanitizeChat";
import { createMockProvider } from "./mock";

const base: ChatScene = {
  units: "imperial",
  room: {
    name: "Bedroom",
    width: 3.66,
    depth: 3.35,
    height: 2.44,
    wallColor: "#e9e4dc",
    floorColor: "#b89874",
    openings: [{ id: "win_1", kind: "window", wall: "north", offset: 1.83, width: 1.2, height: 1.2, sill: 0.9 }],
  },
  items: [
    { id: "bed_1", name: "Queen bed", dims: { w: 1.6, h: 0.6, d: 2.1 }, position: { x: 0, y: 0, z: 0 }, rotationY: 0, mount: "floor", color: "#c9c2b6", origin: "existing" },
    { id: "desk_1", name: "Desk", dims: { w: 1.2, h: 0.75, d: 0.6 }, position: { x: 1.2, y: 0, z: 1.3 }, rotationY: 0, mount: "floor", color: "#9c7b57", origin: "shape" },
    { id: "mon_1", name: "Monitor", dims: { w: 0.6, h: 0.4, d: 0.2 }, position: { x: -1, y: 0, z: 1.2 }, rotationY: 0, mount: "floor", color: "#222222", origin: "shape" },
    { id: "lamp_old", name: "Lamp", dims: { w: 0.3, h: 0.5, d: 0.3 }, position: { x: -1.5, y: 0, z: -1.4 }, rotationY: 0, mount: "floor", color: "#ffffff", origin: "shape" },
    { id: "lamp_new", name: "Lamp", dims: { w: 0.3, h: 0.5, d: 0.3 }, position: { x: 1.5, y: 0, z: -1.4 }, rotationY: 0, mount: "floor", color: "#ffffff", origin: "shape" },
  ],
  selectedId: null,
  lastResults: [
    { index: 0, name: "Paper lantern", retailer: "A", price: 80, dims: { w: 0.4, h: 0.9, d: 0.4 }, mount: "ceiling", style: ["Japanese"], colors: ["white"] },
    { index: 1, name: "Oak side table", retailer: "B", price: 150, dims: { w: 0.5, h: 0.6, d: 0.5 }, mount: "floor", style: [], colors: [] },
    { index: 2, name: "Brass lamp", retailer: "C", price: 120, dims: { w: 0.3, h: 0.5, d: 0.3 }, mount: "floor", style: [], colors: [] },
  ],
};

const empty: ChatScene = { ...base, items: [], lastResults: undefined };

/** Parse + sanitize, exactly like the mock provider. */
function chat(message: string, scene: ChatScene = base) {
  const raw = mockChatReply({ message, scene });
  const out = sanitizeChatOutput(raw, scene);
  expect(out.dropped, `sanitizer dropped steps for "${message}"`).toEqual([]);
  return out;
}

const only = (actions: ChatAction[]) => {
  expect(actions).toHaveLength(1);
  return actions[0];
};

describe("mock chat parser", () => {
  it('"put the monitor on the desk" moves the existing monitor on top of the desk', () => {
    const { actions, reply } = chat("put the monitor on the desk");
    expect(only(actions)).toEqual({ type: "move", itemId: "mon_1", placement: { kind: "onTop", targetId: "desk_1" } });
    expect(reply).toMatch(/monitor.*desk/i);
  });

  it('"add a monitor on the desk" adds a monitor silhouette resting on the desk', () => {
    const a = only(chat("add a monitor on the desk").actions);
    expect(a).toMatchObject({ type: "addShape", name: "Monitor", dims: { w: 0.6, h: 0.4, d: 0.2 }, placement: { kind: "onTop", targetId: "desk_1" } });
    expect((a as { parts: unknown[] }).parts.length).toBeGreaterThanOrEqual(3);
  });

  it('"Put a monitor on the desk" in an empty room adds the desk first, then the monitor on it', () => {
    const { actions, reply } = chat("Put a monitor on the desk", empty);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ type: "addShape", preset: "desk", ref: "desk1" });
    expect(actions[1]).toMatchObject({ type: "addShape", name: "Monitor", placement: { kind: "onTop", targetId: "desk1" } });
    expect(reply).toMatch(/added one first/);
  });

  it('"move the bed to the north wall"', () => {
    expect(only(chat("move the bed to the north wall").actions)).toEqual({
      type: "move",
      itemId: "bed_1",
      placement: { kind: "wall", wall: "north" },
    });
  });

  it('"find a japanese hanging lamp under $200" starts a ceiling search with a budget', () => {
    const { actions, reply } = chat("find a japanese hanging lamp under $200");
    expect(only(actions)).toEqual({ type: "search", query: "japanese hanging lamp under $200", maxPrice: 200, mount: "ceiling" });
    expect(reply).toMatch(/1-3 minutes/);
  });

  it('"Find a Japanese hanging lamp under $200 for the corner" keeps the corner wish in the query', () => {
    const a = only(chat("Find a Japanese hanging lamp under $200 for the corner").actions);
    expect(a).toMatchObject({ type: "search", maxPrice: 200, mount: "ceiling" });
    expect((a as { query: string }).query).toContain("corner");
    expect(a).not.toHaveProperty("forItemId");
  });

  it('"add the second one" adds result #1', () => {
    expect(only(chat("add the second one").actions)).toEqual({ type: "addCandidate", index: 1 });
  });

  it('"add the second one on the desk" places the product on the desk', () => {
    expect(only(chat("add the second one on the desk").actions)).toEqual({
      type: "addCandidate",
      index: 1,
      placement: { kind: "onTop", targetId: "desk_1" },
    });
  });

  it('"add the first one on the desk" skips the placement for a hanging lamp', () => {
    const { actions, reply } = chat("add the first one on the desk");
    expect(only(actions)).toEqual({ type: "addCandidate", index: 0 });
    expect(reply).toMatch(/ceiling item/);
  });

  it('"show me the third one" previews it, "replace the desk with the second one" swaps', () => {
    expect(only(chat("show me the third one").actions)).toEqual({ type: "previewCandidate", index: 2 });
    expect(only(chat("replace the desk with the second one").actions)).toEqual({ type: "addCandidate", index: 1, replaceItemId: "desk_1" });
  });

  it('"add the first one" without results explains instead of acting', () => {
    const { actions, reply } = chat("add the first one", empty);
    expect(actions).toEqual([]);
    expect(reply).toMatch(/no search results/);
  });

  it('"undo" and "undo the last 2"', () => {
    expect(only(chat("undo").actions)).toEqual({ type: "undo", steps: 1 });
    expect(only(chat("undo the last 2").actions)).toEqual({ type: "undo", steps: 2 });
  });

  it('"make it red" / "make this red" use the selected item', () => {
    const scene = { ...base, selectedId: "bed_1" };
    expect(only(chat("make it red", scene).actions)).toEqual({ type: "recolor", itemId: "bed_1", color: "#c0392b" });
    expect(only(chat("make this red", scene).actions)).toEqual({ type: "recolor", itemId: "bed_1", color: "#c0392b" });
  });

  it('"make it red" with nothing selected asks which item', () => {
    const { actions, reply } = chat("make it red");
    expect(actions).toEqual([]);
    expect(reply).toMatch(/couldn't find/);
  });

  it('"Add a desk against the west wall"', () => {
    expect(only(chat("Add a desk against the west wall", empty).actions)).toMatchObject({
      type: "addShape",
      preset: "desk",
      name: "Desk",
      placement: { kind: "wall", wall: "west" },
    });
  });

  it('"Make the room 12 by 14 feet" sets width and depth in meters', () => {
    expect(only(chat("Make the room 12 by 14 feet").actions)).toEqual({ type: "setRoom", patch: { width: 3.658, depth: 4.267 } });
  });

  it('"make the room 4 by 5 m by 2.6 m" sets all three', () => {
    expect(only(chat("make the room 4 by 5 m by 2.6 m").actions)).toEqual({ type: "setRoom", patch: { width: 4, depth: 5, height: 2.6 } });
  });

  it('"add a lamp in the NW corner" and "add a hanging lamp in the north-east corner"', () => {
    expect(only(chat("add a lamp in the NW corner").actions)).toMatchObject({ type: "addShape", name: "Lamp", placement: { kind: "corner", corner: "nw" } });
    expect(only(chat("add a hanging lamp in the north-east corner").actions)).toMatchObject({
      type: "addShape",
      preset: "pendant",
      placement: { kind: "corner", corner: "ne" },
    });
  });

  it('"add a lamp on the desk" becomes a table lamp', () => {
    expect(only(chat("add a lamp on the desk").actions)).toMatchObject({ type: "addShape", name: "Table lamp", dims: { h: 0.5 }, placement: { kind: "onTop" } });
  });

  it('"add two nightstands next to the bed" puts one on each side', () => {
    const { actions } = chat("add two nightstands next to the bed");
    expect(actions.map((a) => (a as { placement?: { side?: string } }).placement?.side)).toEqual(["left", "right"]);
  });

  it('"move the lamp next to the bed" picks the most recent lamp', () => {
    expect(only(chat("move the lamp next to the bed").actions)).toEqual({ type: "move", itemId: "lamp_new", placement: { kind: "nextTo", targetId: "bed_1" } });
  });

  it('"put the desk to the left of the bed"', () => {
    expect(only(chat("put the desk to the left of the bed").actions)).toEqual({
      type: "move",
      itemId: "desk_1",
      placement: { kind: "nextTo", targetId: "bed_1", side: "left" },
    });
  });

  it('"move the bed to the NW corner" / "move the desk to the middle"', () => {
    expect(only(chat("move the bed to the NW corner").actions)).toEqual({ type: "move", itemId: "bed_1", placement: { kind: "corner", corner: "nw" } });
    expect(only(chat("move the desk to the middle").actions)).toEqual({ type: "move", itemId: "desk_1", placement: { kind: "center" } });
  });

  it('"rotate the bed 90" / "rotate it 45 degrees clockwise" / "turn the desk around"', () => {
    expect(only(chat("rotate the bed 90").actions)).toEqual({ type: "rotate", itemId: "bed_1", degrees: 90, relative: true });
    expect(only(chat("rotate it 45 degrees clockwise", { ...base, selectedId: "desk_1" }).actions)).toEqual({
      type: "rotate",
      itemId: "desk_1",
      degrees: -45,
      relative: true,
    });
    expect(only(chat("turn the desk around").actions)).toMatchObject({ degrees: 180 });
  });

  it('"delete the monitor" / "remove the queen bed"', () => {
    expect(only(chat("delete the monitor").actions)).toEqual({ type: "remove", itemId: "mon_1" });
    expect(only(chat("remove the queen bed").actions)).toEqual({ type: "remove", itemId: "bed_1" });
  });

  it('"make the desk 4 ft wide" / "make the bed 30 inches tall" / "make the desk 150 cm long"', () => {
    expect(only(chat("make the desk 4 ft wide").actions)).toEqual({ type: "resize", itemId: "desk_1", dims: { w: 1.219 } });
    expect(only(chat("make the bed 30 inches tall").actions)).toEqual({ type: "resize", itemId: "bed_1", dims: { h: 0.762 } });
    expect(only(chat("make the desk 150 cm long").actions)).toEqual({ type: "resize", itemId: "desk_1", dims: { w: 1.5 } });
  });

  it('"make the bed bigger" scales it', () => {
    expect(only(chat("make the bed bigger").actions)).toEqual({ type: "resize", itemId: "bed_1", dims: { w: 2, h: 0.75, d: 2.625 } });
  });

  it('"top view" / "eye level view" / "back to the 3d view"', () => {
    expect(only(chat("top view").actions)).toEqual({ type: "camera", preset: "top" });
    expect(only(chat("eye level view").actions)).toEqual({ type: "camera", preset: "eye" });
    expect(only(chat("back to the 3d view").actions)).toEqual({ type: "camera", preset: "iso" });
  });

  it('"paint the walls sage" / "make the floor dark brown"', () => {
    expect(only(chat("paint the walls sage").actions)).toEqual({ type: "setRoom", patch: { wallColor: "#9caf88" } });
    expect(only(chat("make the floor dark brown").actions)).toMatchObject({ type: "setRoom", patch: { floorColor: expect.stringMatching(/^#[0-9a-f]{6}$/) } });
  });

  it('"rename the desk to Work desk" keeps the user\'s capitalization', () => {
    expect(only(chat("rename the desk to Work desk").actions)).toEqual({ type: "rename", itemId: "desk_1", name: "Work desk" });
  });

  it('"add a desk against the west wall and put a monitor on it" chains with a ref', () => {
    const { actions } = chat("add a desk against the west wall and put a monitor on it", empty);
    expect(actions).toHaveLength(2);
    const ref = (actions[0] as { ref: string }).ref;
    expect(actions[1]).toMatchObject({ type: "addShape", name: "Monitor", placement: { kind: "onTop", targetId: ref } });
  });

  it('"add a red box 2 ft wide in the corner" reads color, size and a free corner', () => {
    const a = only(chat("add a red box 2 ft wide in the corner").actions);
    expect(a).toMatchObject({ type: "addShape", preset: "box", color: "#c0392b", dims: { w: 0.61 } });
    expect(a).toMatchObject({ placement: { kind: "corner", corner: "sw" } }); // nw and ne are taken by the lamps
  });

  it('"add a 5 by 8 rug in the middle" reads feet', () => {
    expect(only(chat("add a 5 by 8 rug in the middle").actions)).toMatchObject({ type: "addShape", name: "Rug", dims: { w: 1.524, d: 2.438 }, placement: { kind: "center" } });
  });

  it('"add a plant by the window" stands it against the window wall', () => {
    expect(only(chat("add a plant by the window").actions)).toMatchObject({ placement: { kind: "wall", wall: "north" } });
  });

  it('"add a fridge" falls back to a named box', () => {
    const { actions, reply } = chat("add a fridge", empty);
    expect(only(actions)).toMatchObject({ type: "addShape", name: "Fridge", preset: "box" });
    expect(reply).toMatch(/box/);
  });

  it('"select the bed" and "duplicate the lamp next to the bed"', () => {
    expect(only(chat("select the bed").actions)).toEqual({ type: "select", itemId: "bed_1" });
    expect(only(chat("duplicate the lamp next to the bed").actions)).toMatchObject({
      type: "duplicate",
      itemId: "lamp_new",
      placement: { kind: "nextTo", targetId: "bed_1" },
    });
  });

  it("works in metric: bare numbers are meters", () => {
    expect(only(chat("make the room 4 by 5", { ...base, units: "metric" }).actions)).toEqual({ type: "setRoom", patch: { width: 4, depth: 5 } });
  });

  it("unknown messages get a friendly list of examples and no actions", () => {
    for (const msg of ["what's the weather like?", "hello", "asdf qwerty"]) {
      const { actions, reply } = chat(msg);
      expect(actions).toEqual([]);
      expect(reply).toBe(helpReply());
    }
    expect(helpReply()).toContain(MOCK_CHAT_EXAMPLES[0]);
  });

  it("every advertised example does something", () => {
    for (const ex of MOCK_CHAT_EXAMPLES) {
      const { actions, reply } = chat(ex, { ...base, selectedId: "desk_1" });
      expect(actions.length, ex).toBeGreaterThan(0);
      expect(reply).not.toBe(helpReply());
    }
  });
});

describe("mock provider chat", () => {
  it("returns sanitized actions with mock: true", async () => {
    const provider = createMockProvider({ chatDelayMs: 0 });
    const res = await provider.chat({ message: "put the monitor on the desk", history: [], scene: base });
    expect(res).toEqual({
      reply: expect.stringMatching(/monitor/i),
      actions: [{ type: "move", itemId: "mon_1", placement: { kind: "onTop", targetId: "desk_1" } }],
      mock: true,
    });
  });
});

describe("review round 3: mock parser", () => {
  const withChair: ChatScene = {
    ...base,
    items: [
      ...base.items.filter((it) => it.id !== "desk_1"),
      { id: "chair_1", name: "Desk chair", dims: { w: 0.6, h: 1, d: 0.6 }, position: { x: 0, y: 0, z: 1 }, rotationY: 0, mount: "floor", color: "#333333", origin: "existing" },
    ],
  };
  const stacked: ChatScene = {
    ...base,
    items: base.items.map((it) => (it.id === "mon_1" ? { ...it, position: { x: 1.2, y: 0.75, z: 1.3 }, supportId: "desk_1" } : it)),
  };

  it("wall placements leave the spot to the app (no along)", () => {
    expect(only(chat("move the bed to the east wall").actions)).toEqual({ type: "move", itemId: "bed_1", placement: { kind: "wall", wall: "east" } });
  });

  it('"the desk" doesn\'t match a "Desk chair": it asks instead', () => {
    const out = chat("move the desk to the east wall", withChair);
    expect(out.actions).toEqual([]);
    expect(out.reply).toMatch(/couldn't find "desk".*Did you mean the desk chair\?/);
    // The full name still works.
    expect(only(chat("move the desk chair to the east wall", withChair).actions)).toMatchObject({ itemId: "chair_1" });
  });

  it.each(["put the monitor on the floor", "take the monitor off the desk", "put the monitor down", "take off the monitor"])("%s → the floor placement", (msg) => {
    const out = chat(msg, stacked);
    expect(only(out.actions)).toEqual({ type: "move", itemId: "mon_1", placement: { kind: "floor" } });
    expect(out.reply).toMatch(/on the floor in front of the desk/);
  });

  it("an item already on the floor stays put", () => {
    const out = chat("put the monitor on the floor");
    expect(out.actions).toEqual([]);
    expect(out.reply).toMatch(/already on the floor/);
  });

  it('"move the monitor to the desk" puts it ON the desk; a chair "at the desk" goes in front of it', () => {
    expect(only(chat("move the monitor to the desk").actions)).toEqual({ type: "move", itemId: "mon_1", placement: { kind: "onTop", targetId: "desk_1" } });
    expect(chat("add a chair at the desk").actions[0]).toMatchObject({ placement: { kind: "nextTo", targetId: "desk_1", side: "front" } });
  });

  it("refuses to put the desk on the monitor that sits on it", () => {
    const out = chat("put the desk on the monitor", stacked);
    expect(out.actions).toEqual([]);
    expect(out.reply).toBe("The monitor is on the desk, so the desk can't go on it.");
  });

  it('"swap the lamp for something mid-century" searches for a replacement for that lamp', () => {
    const a = only(chat("swap the lamp for something mid-century").actions);
    expect(a).toMatchObject({ type: "search", forItemId: "lamp_new" });
    expect((a as { query: string }).query).toMatch(/mid-century.*lamp/i);
  });

  it("after a search for an item, 'add the second one' replaces that item unless they ask for another", () => {
    const s: ChatScene = { ...base, lastSearch: { query: "brass lamp", forItemId: "lamp_old" } };
    expect(only(chat("add the second one", s).actions)).toEqual({ type: "addCandidate", index: 1, replaceItemId: "lamp_old" });
    expect(only(chat("add another one, the second one", s).actions)).toEqual({ type: "addCandidate", index: 1 });
  });

  it("reads a screen size as its diagonal", () => {
    const add = chat("add a 27 inch monitor on the desk").actions[0] as { dims: { w: number; h: number; d: number } };
    expect(add.dims.w).toBeCloseTo(0.62, 2);
    expect(add.dims.h).toBeGreaterThan(0.45);
  });

  it("a wish rather than an object gets the help reply (which says natural requests need Claude), not a junk box", () => {
    const out = chat("I want a cozy reading corner");
    expect(out.actions).toEqual([]);
    expect(out.reply).toBe(helpReply());
    expect(helpReply()).toMatch(/need Claude/);
    // A single unknown noun is still a box.
    expect(only(chat("add an ottoman", empty).actions)).toMatchObject({ type: "addShape", name: "Ottoman", preset: "box" });
  });

  it("the monitor's stand meets its screen and the screen takes the item color", () => {
    const a = chat("add a monitor", empty).actions[0] as { parts: Array<{ center: { z: number }; size: { z: number }; color?: string }> };
    const [, stand, screen] = a.parts;
    expect(stand.center.z + stand.size.z / 2).toBeGreaterThanOrEqual(screen.center.z - screen.size.z / 2);
    expect(screen.color).toBeUndefined();
  });
});

describe("review round 3: sizes", () => {
  const withNs: ChatScene = {
    ...base,
    items: [...base.items, { id: "ns_1", name: "Nightstand", dims: { w: 0.5, h: 0.6, d: 0.4 }, position: { x: -1.5, y: 0, z: 1.4 }, rotationY: 0, mount: "floor", color: "#8b6f4e", origin: "shape" }],
  };
  it("won't put a desk on a nightstand, and adds a bed asked for 'on the nightstand' where it fits", () => {
    const move = chat("put the desk on the nightstand", withNs);
    expect(move.actions).toEqual([]);
    expect(move.reply).toBe("The desk is too big to go on the nightstand.");
    const add = chat("add a bed on the nightstand", withNs);
    expect(only(add.actions)).not.toHaveProperty("placement");
    expect(add.reply).toMatch(/too big to go on the nightstand/);
  });
  it("uses 'an' before a vowel", () => {
    expect(chat("add an armchair", empty).reply).toMatch(/^Added an armchair\./);
  });
});

describe("review round 3: hide / hang / doors and windows", () => {
  const withArt: ChatScene = {
    ...base,
    items: [
      ...base.items,
      { id: "art_1", name: "Wall art", dims: { w: 0.6, h: 0.45, d: 0.03 }, position: { x: 0, y: 1.5, z: -1.66 }, rotationY: 0, mount: "wall", color: "#5d6d7e", origin: "shape" },
      { id: "mir_1", name: "Mirror", dims: { w: 0.6, h: 0.9, d: 0.03 }, position: { x: 1, y: 0, z: 1 }, rotationY: 0, mount: "floor", color: "#c8d6df", origin: "shape" },
    ],
  };
  it("hides and shows an item", () => {
    expect(only(chat("hide the bed").actions)).toEqual({ type: "setHidden", itemId: "bed_1", hidden: true });
    expect(only(chat("show the bed again").actions)).toEqual({ type: "setHidden", itemId: "bed_1", hidden: false });
  });
  it("hangs things: on the wall, on a given wall, at a height", () => {
    expect(only(chat("hang the mirror on the wall", withArt).actions)).toEqual({ type: "setMount", itemId: "mir_1", mount: "wall" });
    expect(chat("hang the mirror on the east wall", withArt).actions).toEqual([
      { type: "setMount", itemId: "mir_1", mount: "wall" },
      { type: "move", itemId: "mir_1", placement: { kind: "wall", wall: "east" } },
    ]);
    const h = only(chat("hang the art at 5 ft", withArt).actions) as { type: string; bottom: number };
    expect(h.type).toBe("setHeight");
    expect(h.bottom).toBeCloseTo(1.524, 3);
  });
  it("adds, resizes and removes doors and windows", () => {
    expect(only(chat("add a window on the east wall").actions)).toEqual({ type: "setOpening", op: "add", kind: "window", wall: "east" });
    expect(only(chat("make the window 4 ft wide").actions)).toMatchObject({ type: "setOpening", op: "update", openingId: "win_1", width: 1.219 });
    expect(only(chat("remove the window").actions)).toEqual({ type: "setOpening", op: "remove", openingId: "win_1" });
  });
});

describe("review round 4: mock parser", () => {
  it.each([
    ["add a desk chair against the north wall", "Chair"],
    ["add an office chair", "Chair"],
    ["add a TV stand", "TV stand"],
    ["add a desk lamp", "Table lamp"],
    ["add a coffee table", "Coffee table"],
    ["add a bed with two nightstands", "Bed"],
  ])('"%s" adds a %s (the head noun wins)', (msg, name) => {
    const a = chat(msg, empty).actions[0];
    expect(a).toMatchObject({ type: "addShape", name });
  });

  it('"on the left of the bed" / "on the right side of the desk" is beside it, not on it', () => {
    expect(only(chat("add a nightstand on the left of the bed").actions)).toMatchObject({ placement: { kind: "nextTo", targetId: "bed_1", side: "left" } });
    expect(only(chat("add a plant on the right side of the desk").actions)).toMatchObject({ placement: { kind: "nextTo", targetId: "desk_1", side: "right" } });
    const either = chat("add two nightstands on either side of the bed").actions;
    expect(either.map((a) => (a as { placement?: { side?: string } }).placement?.side)).toEqual(["left", "right"]);
    expect(chat("add a nightstand on the left of the bed").reply).toMatch(/to the left of the queen bed/);
  });

  it('"to the left of / to the front of the desk" stays beside the desk for small things too', () => {
    expect(only(chat("move the monitor to the left of the desk").actions)).toEqual({ type: "move", itemId: "mon_1", placement: { kind: "nextTo", targetId: "desk_1", side: "left" } });
    expect(only(chat("move the monitor to the front of the desk").actions)).toEqual({ type: "move", itemId: "mon_1", placement: { kind: "nextTo", targetId: "desk_1", side: "front" } });
    expect(only(chat("move the monitor to the back of the desk").actions)).toEqual({ type: "move", itemId: "mon_1", placement: { kind: "nextTo", targetId: "desk_1", side: "behind" } });
    // ...while "to the desk" still means onto it.
    expect(only(chat("move the monitor to the desk").actions)).toEqual({ type: "move", itemId: "mon_1", placement: { kind: "onTop", targetId: "desk_1" } });
  });

  it("a lamp on a nightstand on a bed comes down in front of the bed", () => {
    const scene: ChatScene = {
      ...base,
      items: [
        ...base.items.filter((it) => !it.id.startsWith("lamp")),
        { id: "ns_1", name: "Nightstand", dims: { w: 0.5, h: 0.6, d: 0.4 }, position: { x: 0, y: 0.6, z: 0 }, rotationY: 0, mount: "floor", color: "#8b6f4e", origin: "shape", supportId: "bed_1" },
        { id: "tl_1", name: "Table lamp", dims: { w: 0.3, h: 0.5, d: 0.3 }, position: { x: 0, y: 1.2, z: 0 }, rotationY: 0, mount: "floor", color: "#ffffff", origin: "shape", supportId: "ns_1" },
      ],
    };
    const out = chat("take the lamp off the nightstand", scene);
    expect(only(out.actions)).toEqual({ type: "move", itemId: "tl_1", placement: { kind: "floor" } });
    expect(out.reply).toBe("Put the table lamp on the floor in front of the queen bed.");
  });

  it('"add it" while a result is previewed adds that result, never an item called "It"', () => {
    const previewing: ChatScene = { ...base, lastSearch: { query: "walnut nightstand", previewIndex: 1 } };
    const out = chat("add it next to the desk", previewing);
    expect(only(out.actions)).toEqual({ type: "addCandidate", index: 1, placement: { kind: "nextTo", targetId: "desk_1" } });
    expect(out.reply).toBe("Added Oak side table next to the desk.");
    expect(only(chat("add this one", previewing).actions)).toEqual({ type: "addCandidate", index: 1 });
    // Nothing selected, so "put it ..." also means the preview.
    expect(only(chat("put it next to the bed", previewing).actions)).toMatchObject({ type: "addCandidate", index: 1 });
    // No preview: ask instead of adding a box named "It".
    const none = chat("add it next to the desk");
    expect(none.actions).toEqual([]);
    expect(none.reply).toMatch(/not sure what to add/);
  });
});
