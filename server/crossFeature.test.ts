// Round 3 integration checks on the chat path: one demo-mode message that touches several round-3 features at once
// (lighting mode + blinds + a lamp + a version), and the size of the scene a 30-item room sends with every message.
import { describe, expect, it } from "vitest";
import type { ChatScene, PlacedItem, ProductCandidate } from "../src/shared/types";
import { buildChatScene } from "../src/ui/chat/buildScene";
import { SHAPE_PRESETS, defaultRoom } from "../src/lib/presets";
import { mockChatReply } from "./mockChat";
import { sanitizeChatOutput } from "./sanitizeChat";
import { ChatRequestSchema } from "./schemas";
import { chatSceneJson } from "./prompts";

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
      { id: "win_e", kind: "window", wall: "east", offset: 2.2, width: 0.9, height: 1.2, sill: 0.9 },
    ],
  },
  items: [
    { id: "desk_1", name: "Desk", dims: { w: 1.2, h: 0.75, d: 0.6 }, position: { x: 1.5, y: 0, z: 0.4 }, rotationY: 0, mount: "floor", color: "#9c7b57", origin: "shape" },
    { id: "pend_1", name: "Hanging lamp", dims: { w: 0.4, h: 0.9, d: 0.4 }, position: { x: 0, y: 1.54, z: 0 }, rotationY: 0, mount: "ceiling", color: "#f2e6c9", origin: "shape", light: { on: false, color: "#ffd8a8", intensity: 0.7 } },
    { id: "tower", name: "Cat tower", dims: { w: 0.6, h: 1.5, d: 0.6 }, position: { x: -1, y: 0, z: -1 }, rotationY: 0, mount: "floor", color: "#c8b79a", origin: "shape" },
    { id: "cat", name: "Cat", dims: { w: 0.25, h: 0.3, d: 0.45 }, position: { x: 1, y: 0, z: -1 }, rotationY: 0, mount: "floor", color: "#d08a3c", origin: "shape" },
  ],
  selectedId: null,
  lighting: "day",
  versions: [{ id: "ver_a", name: "Option A", createdAt: Date.now() - 60_000, auto: false }],
};

function chat(message: string) {
  const out = sanitizeChatOutput(mockChatReply({ message, scene }), scene);
  expect(out.dropped, `sanitizer dropped steps for "${message}"`).toEqual([]);
  return out;
}

describe("demo chat: several round-3 features in one message", () => {
  it("make it night, close the blinds and turn on the pendant", () => {
    const out = chat("make it night, close the blinds and turn on the pendant");
    expect(out.actions).toEqual([
      { type: "setLighting", mode: "night" },
      { type: "setWindow", openingId: "*", covering: "closed" },
      { type: "setLight", itemId: "pend_1", on: true },
    ]);
    expect(out.reply).toMatch(/night/i);
    expect(out.reply).toMatch(/blinds/i);
  });

  it("…and save this as option B (a version step after the lighting steps)", () => {
    const out = chat("make it night, close the blinds, turn on the pendant and save this as option B");
    expect(out.actions.map((a) => a.type)).toEqual(["setLighting", "setWindow", "setLight", "saveVersion"]);
    expect(out.actions[3]).toEqual({ type: "saveVersion", name: "Option B" });
  });

  it("a level on the cat tower plus a lighting mode; then going back to a version", () => {
    expect(chat("put the cat on the middle level of the cat tower and make it evening").actions).toEqual([
      { type: "move", itemId: "cat", placement: { kind: "onTop", targetId: "tower", level: "middle" } },
      { type: "setLighting", mode: "evening" },
    ]);
    expect(chat("go back to option A").actions).toEqual([{ type: "restoreVersion", versionId: "ver_a" }]);
  });
});

describe("scene size", () => {
  it("a 30-item room (products, lamps, stacks, 20 versions, 20 search results) stays well under 20 KB", () => {
    const room = { ...defaultRoom(), lighting: "evening" as const };
    room.openings = room.openings.map((o) => (o.kind === "window" ? { ...o, covering: "closed" as const } : o));
    const presets = SHAPE_PRESETS;
    const product = (i: number): ProductCandidate => ({
      id: `prod_${i}`,
      name: `Mid-century walnut lounge chair with linen cushion, model ${i}`,
      retailer: "Example Furniture Co.",
      url: `https://www.example-furniture.com/products/mid-century-walnut-lounge-chair-linen-cushion-${i}?variant=1234567890&utm_source=planner`,
      price: 349.99,
      currency: "USD",
      dims: { w: 0.71, h: 0.79, d: 0.76 },
      dimsSource: "listed",
      colors: [{ name: "Walnut", hex: "#5b3a29" }, { name: "Oatmeal", hex: "#d8cfc0" }],
      style: ["mid-century modern", "Scandinavian"],
      materials: ["walnut", "linen"],
      mount: "floor",
      parts: [{ kind: "box", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } }],
    });
    const items: PlacedItem[] = Array.from({ length: 30 }, (_, i) => {
      const p = presets[i % presets.length];
      const it: PlacedItem = {
        id: `item_${Math.random().toString(36).slice(2, 10)}`,
        name: i % 3 === 0 ? product(i).name : `${p.label} ${i}`,
        position: { x: -1.6 + (i % 6) * 0.61234, y: 0, z: -1.5 + Math.floor(i / 6) * 0.70123 },
        rotationY: (i * Math.PI) / 7,
        dims: { ...p.dims },
        color: p.color,
        mount: p.mount,
        parts: p.parts,
        origin: i % 3 === 0 ? "product" : "shape",
      };
      if (i % 3 === 0) it.product = product(i);
      if (i % 5 === 0) it.light = { on: true, color: "#ffd8a8", intensity: 0.7 };
      return it;
    });
    // A few stacks, incl. under a support and on a level.
    items[1].supportId = items[0].id;
    items[2].supportId = items[0].id;
    items[2].supportSurfaceY = 0;
    items[4].supportId = items[3].id;
    items[4].supportSurfaceY = 0.945;
    const versions = Array.from({ length: 25 }, (_, i) => ({ id: `ver_${Math.random().toString(36).slice(2, 12)}`, name: i % 2 ? `Before chat changes ${i}` : `Option ${i}`, createdAt: Date.now() - i * 60_000, auto: i % 2 === 1 }));
    const results = Array.from({ length: 20 }, (_, i) => product(100 + i));

    const s = buildChatScene({ units: "imperial", room, items, selectedId: items[0].id }, results, "walnut lounge chair under $400", versions);
    expect(s.items).toHaveLength(30);
    // Every named version (13), the 10 newest autos, then one older auto per hour (the last 2 share an hour): 24.
    expect(s.versions).toHaveLength(24);
    // Valid for the server, with every round-3 field.
    const parsed = ChatRequestSchema.safeParse({ message: "make it night", history: [], scene: s });
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);

    const requestBytes = Buffer.byteLength(JSON.stringify(s));
    const promptBytes = Buffer.byteLength(chatSceneJson(s));
    const part = (k: keyof ChatScene) => Buffer.byteLength(JSON.stringify(s[k] ?? null));
    console.log(`30-item scene: request JSON ${requestBytes} B (items ${part("items")}, versions ${part("versions")}, lastResults ${part("lastResults")}, room ${part("room")}), prompt scene JSON ${promptBytes} B`);
    expect(requestBytes).toBeLessThan(20_000);
    expect(promptBytes).toBeLessThan(20_000);
  });
});
