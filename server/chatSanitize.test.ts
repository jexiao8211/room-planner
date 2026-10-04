// sanitizeChat: untrusted chat answers are cleaned against the scene before they reach the browser.
import { describe, expect, it } from "vitest";
import type { ChatScene } from "../src/shared/types";
import { chatResponseFrom, colorFrom, sanitizeChatActions, sanitizeChatOutput } from "./sanitizeChat";

const scene: ChatScene = {
  units: "imperial",
  room: { name: "Bedroom", width: 4, depth: 3, height: 2.5, wallColor: "#eeeeee", floorColor: "#aa8866", openings: [] },
  items: [
    { id: "desk_1", name: "Desk", dims: { w: 1.2, h: 0.75, d: 0.6 }, position: { x: 0, y: 0, z: 0 }, rotationY: 0, mount: "floor", color: "#9c7b57", origin: "shape" },
    { id: "mon_1", name: "Monitor", dims: { w: 0.6, h: 0.4, d: 0.2 }, position: { x: 0, y: 0.75, z: 0 }, rotationY: 0, mount: "floor", color: "#222222", origin: "shape", supportId: "desk_1" },
    { id: "art_1", name: "Wall art", dims: { w: 0.8, h: 0.6, d: 0.04 }, position: { x: 0, y: 1.5, z: -1.48 }, rotationY: 0, mount: "wall", color: "#5d6d7e", origin: "shape" },
    { id: "box_1", name: "Old box", dims: { w: 0.5, h: 0.5, d: 0.5 }, position: { x: 1, y: 0, z: 1 }, rotationY: 0, mount: "floor", color: "#888888", origin: "shape", hidden: true },
  ],
  selectedId: "desk_1",
  lastResults: [
    { index: 0, name: "Lantern", retailer: "A", price: 80, dims: { w: 0.4, h: 0.9, d: 0.4 }, mount: "ceiling", style: [], colors: [] },
    { index: 1, name: "Side table", retailer: "B", price: 120, dims: { w: 0.5, h: 0.6, d: 0.5 }, mount: "floor", style: [], colors: [] },
  ],
};

const clean = (actions: unknown[], s: ChatScene = scene) => sanitizeChatActions(actions, s);

describe("ids and refs", () => {
  it("drops actions that reference unknown ids", () => {
    const { actions, dropped } = clean([
      { type: "move", itemId: "nope", placement: { kind: "center" } },
      { type: "recolor", itemId: "desk_1", color: "#ff0000" },
      { type: "remove", itemId: "ghost" },
    ]);
    expect(actions).toEqual([{ type: "recolor", itemId: "desk_1", color: "#ff0000" }]);
    expect(dropped).toHaveLength(2);
    expect(dropped[0]).toContain('unknown item "nope"');
  });

  it("lets later actions use a ref created earlier in the same answer", () => {
    const { actions, dropped } = clean([
      { type: "addShape", ref: "lamp1", name: "Lamp", preset: "cylinder", placement: { kind: "onTop", targetId: "desk_1" } },
      { type: "recolor", itemId: "lamp1", color: "red" },
      { type: "addShape", ref: "plant1", name: "Plant", placement: { kind: "nextTo", targetId: "lamp1", side: "LEFT", gap: 9 } },
    ]);
    expect(dropped).toEqual([]);
    expect(actions[0]).toMatchObject({ type: "addShape", ref: "lamp1", preset: "cylinder", placement: { kind: "onTop", targetId: "desk_1" } });
    expect(actions[1]).toEqual({ type: "recolor", itemId: "lamp1", color: "#c0392b" });
    expect(actions[2]).toMatchObject({ placement: { kind: "nextTo", targetId: "lamp1", side: "left", gap: 2 } });
  });

  it("does not resolve a ref before it is created, and ignores refs that collide with ids", () => {
    const { actions, dropped } = clean([
      { type: "move", itemId: "later1", placement: { kind: "center" } },
      { type: "addShape", ref: "later1", name: "Box" },
      { type: "addShape", ref: "desk_1", name: "Shadow desk" },
    ]);
    expect(actions).toHaveLength(2);
    expect(actions[1]).not.toHaveProperty("ref");
    expect(dropped[0]).toContain("later1");
  });

  it("maps an exact item name used as an id to that item (most recent wins)", () => {
    const s: ChatScene = { ...scene, items: [...scene.items, { ...scene.items[0], id: "desk_2" }] };
    const { actions } = clean([{ type: "select", itemId: "desk" }], s);
    expect(actions).toEqual([{ type: "select", itemId: "desk_2" }]);
  });

  it("drops actions on an item removed earlier in the answer", () => {
    const { actions, dropped } = clean([
      { type: "remove", itemId: "desk_1" },
      { type: "rotate", itemId: "desk_1", degrees: 90, relative: true },
    ]);
    expect(actions).toEqual([{ type: "remove", itemId: "desk_1" }]);
    expect(dropped).toHaveLength(1);
  });

  it("accepts action types in any case and drops unknown ones", () => {
    const { actions, dropped } = clean([{ type: "UNDO", steps: 99 }, { type: "explode", itemId: "desk_1" }, "junk", null]);
    expect(actions).toEqual([{ type: "undo", steps: 20 }]);
    expect(dropped).toHaveLength(3);
  });
});

describe("placements", () => {
  it("clamps absolute positions into the room and along into 0..1", () => {
    const { actions } = clean([
      { type: "move", itemId: "desk_1", placement: { kind: "at", x: 99, z: -99 } },
      { type: "move", itemId: "desk_1", placement: { kind: "wall", wall: "NORTH", along: 7 } },
      { type: "move", itemId: "desk_1", placement: { kind: "corner", corner: "north-west" } },
      { type: "move", itemId: "desk_1", placement: { kind: "middle" } },
    ]);
    expect(actions.map((a) => (a as { placement: unknown }).placement)).toEqual([
      { kind: "at", x: 2, z: -1.5 },
      { kind: "wall", wall: "north", along: 1 },
      { kind: "corner", corner: "nw" },
      { kind: "center" },
    ]);
  });

  it("refuses to stack an item on itself or on something resting on it", () => {
    const { actions, dropped } = clean([
      { type: "move", itemId: "desk_1", placement: { kind: "onTop", targetId: "desk_1" } },
      { type: "move", itemId: "desk_1", placement: { kind: "onTop", targetId: "mon_1" } },
    ]);
    expect(actions).toEqual([]);
    expect(dropped.every((d) => d.includes("can't rest on itself"))).toBe(true);
  });

  it("only floor items rest on visible floor items", () => {
    const { actions, dropped } = clean([
      { type: "move", itemId: "art_1", placement: { kind: "onTop", targetId: "desk_1" } },
      { type: "move", itemId: "mon_1", placement: { kind: "onTop", targetId: "art_1" } },
      { type: "move", itemId: "mon_1", placement: { kind: "onTop", targetId: "box_1" } },
    ]);
    expect(actions).toEqual([]);
    expect(dropped).toHaveLength(3);
  });

  it("keeps an addShape whose placement is invalid, without the placement", () => {
    const res = sanitizeChatOutput({ reply: "Added a box.", actions: [{ type: "addShape", name: "Box", placement: { kind: "onTop", targetId: "nope" } }] }, scene);
    expect(res.actions).toEqual([{ type: "addShape", name: "Box" }]);
    expect(res.dropped[0]).toContain("placement dropped");
    // The reply doesn't pretend the box went where asked.
    expect(res.reply).toBe("Added a box. (I couldn't place 1 item where asked, so the app picked a spot.)");
  });
});

describe("values", () => {
  it("clamps dims, keeps valid presets / colors / mounts and drops the rest", () => {
    const { actions } = clean([
      { type: "addShape", name: "  Big   thing ", preset: "DESK", dims: { w: 99, h: 0.001, d: 0 }, color: "nope", mount: "tabletop" },
      { type: "addShape", name: "", preset: "spaceship", color: "#ABC", mount: "Wall", parts: [{ kind: "box", center: { x: 0, y: 0.5, z: 0 }, size: { x: 2, y: 1, z: 1 } }] },
    ]);
    expect(actions[0]).toEqual({ type: "addShape", name: "Big thing", preset: "desk", dims: { w: 5, h: 0.02, d: 0.6 } });
    expect(actions[1]).toMatchObject({ type: "addShape", name: "Item", color: "#aabbcc", mount: "wall" });
    expect((actions[1] as { parts: Array<{ size: { x: number } }> }).parts[0].size.x).toBe(1);
  });

  it("resize keeps only positive dims (0 = keep) and drops empty resizes", () => {
    const { actions, dropped } = clean([
      { type: "resize", itemId: "desk_1", dims: { w: 1.5, h: 0, d: -1 } },
      { type: "resize", itemId: "desk_1", dims: { w: 0, h: 0, d: 0 } },
    ]);
    expect(actions).toEqual([{ type: "resize", itemId: "desk_1", dims: { w: 1.5 } }]);
    expect(dropped[0]).toContain("no size");
  });

  it("normalizes rotation and defaults to relative", () => {
    const { actions } = clean([
      { type: "rotate", itemId: "desk_1", degrees: 450 },
      { type: "rotate", itemId: "desk_1", degrees: -90, relative: false },
    ]);
    expect(actions).toEqual([
      { type: "rotate", itemId: "desk_1", degrees: 90, relative: true },
      { type: "rotate", itemId: "desk_1", degrees: -90, relative: false },
    ]);
  });

  it("setRoom treats 0 / empty as keep, clamps sizes and drops an empty patch", () => {
    const { actions, dropped } = clean([
      { type: "setRoom", patch: { name: "", width: 40, depth: 0, height: 1, wallColor: "sage", floorColor: "" } },
      { type: "setRoom", patch: { name: "", width: 0, depth: 0, height: 0, wallColor: "", floorColor: "" } },
    ]);
    expect(actions).toEqual([{ type: "setRoom", patch: { width: 15, height: 1.8, wallColor: "#9caf88" } }]);
    expect(dropped).toHaveLength(1);
  });

  it("search keeps sane filters and drops an unknown forItemId", () => {
    const { actions, dropped } = clean([
      { type: "search", query: "japanese pendant lamp", mount: "Ceiling", maxPrice: -5, forItemId: "ghost", style: "" },
      { type: "search", query: " " },
    ]);
    expect(actions).toEqual([{ type: "search", query: "japanese pendant lamp", mount: "ceiling" }]);
    expect(dropped).toHaveLength(1);
  });

  it("candidates must exist in lastResults; a hanging product 'on' something hangs above it instead", () => {
    const { actions, dropped } = clean([
      { type: "addCandidate", index: 1, placement: { kind: "onTop", targetId: "desk_1" } },
      { type: "addCandidate", index: 0, placement: { kind: "onTop", targetId: "desk_1" } },
      { type: "addCandidate", index: 5 },
      { type: "previewCandidate", index: 1.5 },
      { type: "addCandidate", index: 1, replaceItemId: "mon_1" },
      { type: "recolor", itemId: "mon_1", color: "#000000" },
    ]);
    expect(actions).toEqual([
      { type: "addCandidate", index: 1, placement: { kind: "onTop", targetId: "desk_1" } },
      { type: "addCandidate", index: 0, placement: { kind: "onTop", targetId: "desk_1" } },
      { type: "addCandidate", index: 1, replaceItemId: "mon_1" },
    ]);
    expect(dropped).toHaveLength(3);
    const none = clean([{ type: "addCandidate", index: 0 }], { ...scene, lastResults: undefined });
    expect(none.actions).toEqual([]);
    expect(none.dropped[0]).toContain("no search results");
  });

  it("caps the list at 20 actions", () => {
    const many = Array.from({ length: 30 }, () => ({ type: "camera", preset: "top" }));
    const { actions, dropped } = clean(many);
    expect(actions).toHaveLength(20);
    expect(dropped).toContain("more than 20 actions");
  });

  it("reads color words", () => {
    expect(colorFrom("Red")).toBe("#c0392b");
    expect(colorFrom("light blue")).toMatch(/^#[0-9a-f]{6}$/);
    expect(colorFrom("#123")).toBe("#112233");
    expect(colorFrom("blurple")).toBeNull();
  });
});

describe("the whole answer", () => {
  it("fills a missing reply and says when steps were skipped", () => {
    expect(sanitizeChatOutput({ actions: [{ type: "undo", steps: 1 }] }, scene).reply).toBe("Done.");
    const res = sanitizeChatOutput(
      { reply: "Moved it.", actions: [{ type: "camera", preset: "top" }, { type: "move", itemId: "x", placement: { kind: "center" } }] },
      scene,
    );
    expect(res.reply).toBe("Moved it. (I skipped 1 step I couldn't apply.)");
    expect(res.skipped).toEqual([{ type: "move", reason: 'unknown item "x"' }]);
    expect(sanitizeChatOutput("garbage", scene)).toMatchObject({ actions: [] });
  });

  it("never claims a change when every step was dropped: the reply says why instead", () => {
    const res = sanitizeChatOutput({ reply: "Moved the desk on top of the monitor.", actions: [{ type: "move", itemId: "x", placement: { kind: "center" } }] }, scene);
    expect(res.actions).toEqual([]);
    expect(res.reply).toBe('I couldn\'t do that: unknown item "x".');
  });

  it("chatResponseFrom logs what was skipped and returns it as short reasons, never as actions", () => {
    const lines: string[] = [];
    const res = chatResponseFrom({ reply: "ok", actions: [{ type: "remove", itemId: "zzz" }] }, scene, false, (l) => lines.push(l));
    expect(res).toEqual({ reply: 'I couldn\'t do that: unknown item "zzz".', actions: [], mock: false, skipped: [{ type: "remove", reason: 'unknown item "zzz"' }] });
    expect(lines[0]).toContain("[chat] skipped");
    // Nothing skipped: no field.
    expect(chatResponseFrom({ reply: "ok", actions: [{ type: "undo", steps: 1 }] }, scene, true)).toEqual({ reply: "ok", actions: [{ type: "undo", steps: 1 }], mock: true });
  });
});

describe("review round 3", () => {
  it("a name refers to the item created earlier in this answer before an older one from the scene", () => {
    const { actions } = clean([
      { type: "addShape", name: "Desk", preset: "desk", ref: "d1" },
      { type: "recolor", itemId: "Desk", color: "red" },
    ]);
    expect(actions[1]).toMatchObject({ type: "recolor", itemId: "d1" });
  });

  it("a removed item is skipped when resolving a name, so the older match is used", () => {
    const s: ChatScene = { ...scene, items: [...scene.items, { ...scene.items[0], id: "desk_2" }] };
    const { actions } = clean(
      [
        { type: "remove", itemId: "desk_2" },
        { type: "recolor", itemId: "Desk", color: "red" },
      ],
      s,
    );
    expect(actions[1]).toMatchObject({ itemId: "desk_1" });
  });

  it("along -1 means 'let the app pick'", () => {
    const { actions } = clean([{ type: "move", itemId: "desk_1", placement: { kind: "wall", wall: "north", along: -1 } }]);
    expect(actions[0]).toEqual({ type: "move", itemId: "desk_1", placement: { kind: "wall", wall: "north" } });
  });

  it("drops (silently) a move of a monitor whose desk moves in the same answer: the desk carries it", () => {
    const out = sanitizeChatOutput(
      {
        reply: "Moved everything away from the window.",
        actions: [
          { type: "move", itemId: "mon_1", placement: { kind: "wall", wall: "south", along: 0.5 } },
          { type: "move", itemId: "desk_1", placement: { kind: "wall", wall: "south", along: 0.5 } },
        ],
      },
      scene,
    );
    expect(out.actions).toEqual([{ type: "move", itemId: "desk_1", placement: { kind: "wall", wall: "south", along: 0.5 } }]);
    expect(out.skipped).toEqual([]);
    expect(out.reply).toBe("Moved everything away from the window.");
    // Moving the monitor onto something else is still its own move.
    const onto = clean([
      { type: "move", itemId: "mon_1", placement: { kind: "onTop", targetId: "box_1" } },
      { type: "move", itemId: "desk_1", placement: { kind: "center" } },
    ]);
    expect(onto.dropped.some((d) => d.includes("moves with"))).toBe(false);
  });

  it("cleans the new hide / mount / height / opening actions", () => {
    const s: ChatScene = { ...scene, room: { ...scene.room, openings: [{ id: "win_1", kind: "window", wall: "north", offset: 2, width: 1.2, height: 1.2, sill: 0.9 }] } };
    const { actions, dropped } = clean(
      [
        { type: "setHidden", itemId: "box_1", hidden: false },
        { type: "setMount", itemId: "art_1", mount: "Floor" },
        { type: "setHeight", itemId: "art_1", bottom: 99 },
        { type: "setOpening", op: "add", openingId: "", kind: "door", wall: "east", offset: -1, width: 0.9, height: 0, sill: -1 },
        { type: "setOpening", op: "update", openingId: "win_1", kind: "window", wall: "north", offset: 1, width: 0, height: 0, sill: -1 },
        { type: "setOpening", op: "remove", openingId: "nope", kind: "window", wall: "north", offset: -1, width: 0, height: 0, sill: -1 },
        { type: "setHidden", itemId: "desk_1", hidden: "yes" },
      ],
      s,
    );
    expect(actions).toEqual([
      { type: "setHidden", itemId: "box_1", hidden: false },
      { type: "setMount", itemId: "art_1", mount: "floor" },
      { type: "setHeight", itemId: "art_1", bottom: 2.5 },
      { type: "setOpening", op: "add", kind: "door", wall: "east", width: 0.9 },
      { type: "setOpening", op: "update", openingId: "win_1", kind: "window", wall: "north", offset: 1 },
    ]);
    expect(dropped).toHaveLength(2);
  });
});

describe("stacking size rule", () => {
  it("drops an onTop that the app would refuse (too big for the support), so the reply never claims it", () => {
    const s: ChatScene = {
      ...scene,
      items: [...scene.items, { id: "ns_1", name: "Nightstand", dims: { w: 0.5, h: 0.6, d: 0.4 }, position: { x: -1, y: 0, z: 1 }, rotationY: 0, mount: "floor", color: "#8b6f4e", origin: "shape" }],
    };
    const out = sanitizeChatOutput({ reply: "Put the desk on the nightstand.", actions: [{ type: "move", itemId: "desk_1", placement: { kind: "onTop", targetId: "ns_1" } }] }, s);
    expect(out.actions).toEqual([]);
    expect(out.reply).toBe('I couldn\'t do that: it is too big to go on "Nightstand".');
    // A new bed with an onTop placement keeps the bed, without the placement; a lamp fits.
    const add = sanitizeChatOutput(
      {
        reply: "Added.",
        actions: [
          { type: "addShape", name: "Bed", preset: "bed", placement: { kind: "onTop", targetId: "ns_1" } },
          { type: "addShape", name: "Lamp", dims: { w: 0.3, h: 0.5, d: 0.3 }, placement: { kind: "onTop", targetId: "ns_1" } },
        ],
      },
      s,
    );
    expect(add.actions[0]).not.toHaveProperty("placement");
    expect(add.actions[1]).toMatchObject({ placement: { kind: "onTop", targetId: "ns_1" } });
    expect(add.reply).toContain("couldn't place 1 item");
  });
});

describe("review round 4: sanitizer", () => {
  it("a name refers to an item added earlier in the same answer even without a ref", () => {
    const out = sanitizeChatOutput(
      { reply: "Added a desk and made it red.", actions: [{ type: "addShape", preset: "desk", name: "Desk" }, { type: "recolor", itemId: "Desk", color: "#ff0000" }] },
      scene,
    );
    expect(out.actions).toEqual([
      { type: "addShape", name: "Desk", preset: "desk", ref: "new_1" },
      { type: "recolor", itemId: "new_1", color: "#ff0000" },
    ]);
    expect(out.reply).toBe("Added a desk and made it red.");
    // ...also as a placement target, and our handle never takes a ref the answer uses itself.
    const empty: ChatScene = { ...scene, items: [] };
    const stack = sanitizeChatOutput(
      {
        reply: "ok",
        actions: [
          { type: "addShape", preset: "desk", name: "Desk" },
          { type: "addShape", name: "Lamp", ref: "new_1" },
          { type: "addShape", name: "Monitor", placement: { kind: "onTop", targetId: "Desk" } },
        ],
      },
      empty,
    );
    expect(stack.dropped).toEqual([]);
    expect(stack.actions[0]).toMatchObject({ ref: "new_2" });
    expect(stack.actions[2]).toMatchObject({ placement: { kind: "onTop", targetId: "new_2" } });
    // An add nothing refers to stays without a ref.
    expect(clean([{ type: "addShape", preset: "desk", name: "Desk" }]).actions).toEqual([{ type: "addShape", name: "Desk", preset: "desk" }]);
  });

  it("keeps a move the user asked for of an item whose support also moves; skips only a redundant one", () => {
    const withBed: ChatScene = {
      ...scene,
      items: [...scene.items, { id: "bed_1", name: "Bed", dims: { w: 1.6, h: 0.6, d: 2.1 }, position: { x: -1, y: 0, z: 0.5 }, rotationY: 0, mount: "floor", color: "#ffffff", origin: "shape" }],
    };
    const out = chatResponseFrom(
      {
        reply: "Moved the monitor next to the bed and the desk to the east wall.",
        actions: [
          { type: "move", itemId: "mon_1", placement: { kind: "nextTo", targetId: "bed_1" } },
          { type: "move", itemId: "desk_1", placement: { kind: "wall", wall: "east" } },
        ],
      },
      withBed,
      false,
    );
    expect(out.actions).toEqual([
      { type: "move", itemId: "mon_1", placement: { kind: "nextTo", targetId: "bed_1" } },
      { type: "move", itemId: "desk_1", placement: { kind: "wall", wall: "east" } },
    ]);
    expect(out.skipped).toBeUndefined();
    // A point on the desk's new spot is what the desk does anyway.
    const carried = clean([
      { type: "move", itemId: "desk_1", placement: { kind: "at", x: 1, z: 1 } },
      { type: "move", itemId: "mon_1", placement: { kind: "at", x: 1.2, z: 1.1 } },
    ]);
    expect(carried.actions).toEqual([{ type: "move", itemId: "desk_1", placement: { kind: "at", x: 1, z: 1 } }]);
    expect(carried.skipped).toEqual([]);
  });

  it("passes the floor placement through", () => {
    const { actions, dropped } = clean([
      { type: "move", itemId: "mon_1", placement: { kind: "Floor" } },
      { type: "move", itemId: "mon_1", placement: { kind: "onTop", targetId: "desk_1" } },
    ]);
    expect(dropped).toEqual([]);
    expect(actions[0]).toEqual({ type: "move", itemId: "mon_1", placement: { kind: "floor" } });
  });
});
