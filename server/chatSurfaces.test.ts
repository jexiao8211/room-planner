// Round 3 chat additions (ROUND3-SPEC §3, §4, §7): placement "under", onTop.level, action "hang" — schema, sanitizer,
// mock parser; and the product / photo mount reader that let a pendant come back as Mount = Floor.
import { describe, expect, it } from "vitest";
import type { ChatScene } from "../src/shared/types";
import { mockChatReply } from "./mockChat";
import { sanitizeChatOutput } from "./sanitizeChat";
import { ChatOutputSchema } from "./schemas";
import { IdGen, mountFrom, sanitizeCandidate } from "./sanitize";

const scene: ChatScene = {
  units: "imperial",
  room: { name: "Bedroom", width: 3.66, depth: 3.35, height: 2.44, wallColor: "#e9e4dc", floorColor: "#b89874", openings: [] },
  items: [
    { id: "desk_1", name: "Desk", dims: { w: 1.2, h: 0.75, d: 0.6 }, position: { x: 1.2, y: 0, z: 1.3 }, rotationY: 0, mount: "floor", color: "#9c7b57", origin: "shape" },
    { id: "bin_1", name: "Bin", dims: { w: 0.3, h: 0.35, d: 0.3 }, position: { x: -1, y: 0, z: 1 }, rotationY: 0, mount: "floor", color: "#555555", origin: "shape" },
    { id: "tower_1", name: "Cat tower", dims: { w: 0.6, h: 1.5, d: 0.6 }, position: { x: -1.3, y: 0, z: -1.2 }, rotationY: 0, mount: "floor", color: "#cdbfa8", origin: "shape" },
    { id: "cat_1", name: "Cat", dims: { w: 0.25, h: 0.3, d: 0.45 }, position: { x: 0, y: 0, z: 0 }, rotationY: 0, mount: "floor", color: "#c98a4b", origin: "shape" },
    { id: "pend_1", name: "Pendant", dims: { w: 0.4, h: 0.9, d: 0.4 }, position: { x: 0.5, y: 1.54, z: -0.5 }, rotationY: 0, mount: "ceiling", color: "#f2e6c9", origin: "shape" },
    { id: "tlamp_1", name: "Table lamp", dims: { w: 0.3, h: 0.5, d: 0.3 }, position: { x: 1.2, y: 0.75, z: 1.3 }, rotationY: 0, mount: "floor", color: "#f2e6c9", origin: "shape", supportId: "desk_1" },
  ],
  selectedId: null,
};

function chat(message: string) {
  const raw = mockChatReply({ message, scene });
  const out = sanitizeChatOutput(raw, scene);
  expect(out.dropped, `sanitizer dropped steps for "${message}"`).toEqual([]);
  return out;
}

describe("mock parser: under, levels, hang", () => {
  it('"put the bin under the desk"', () => {
    expect(chat("put the bin under the desk").actions).toEqual([{ type: "move", itemId: "bin_1", placement: { kind: "under", targetId: "desk_1" } }]);
  });

  it('"put the cat on the middle level of the cat tower" (and the top / bottom levels)', () => {
    expect(chat("put the cat on the middle level of the cat tower").actions).toEqual([
      { type: "move", itemId: "cat_1", placement: { kind: "onTop", targetId: "tower_1", level: "middle" } },
    ]);
    expect(chat("put the cat on the bottom level of the cat tower").actions[0]).toMatchObject({ placement: { level: "bottom" } });
    expect(chat("put the cat on the top level of the cat tower").actions[0]).toEqual({ type: "move", itemId: "cat_1", placement: { kind: "onTop", targetId: "tower_1" } });
  });

  it('"add a cat on the middle level of the cat tower" adds one there; "add a bin under the desk"', () => {
    const out = chat("add a cat on the middle level of the cat tower");
    expect(out.actions[0]).toMatchObject({ type: "addShape", preset: "cat", placement: { kind: "onTop", targetId: "tower_1", level: "middle" } });
    expect(chat("add a bin under the desk").actions[0]).toMatchObject({ type: "addShape", name: "Bin", placement: { kind: "under", targetId: "desk_1" } });
  });

  it('"hang the lamp from the ceiling" uses the hang action', () => {
    expect(chat("hang the table lamp from the ceiling").actions).toEqual([{ type: "hang", itemId: "tlamp_1" }]);
  });

  it('"lower the pendant by 6 inches" / "raise it 10 cm" change its drop from the ceiling', () => {
    const lower = chat("lower the pendant by 6 inches").actions;
    expect(lower).toHaveLength(1);
    expect(lower[0]).toMatchObject({ type: "hang", itemId: "pend_1" });
    expect((lower[0] as { drop: number }).drop).toBeCloseTo(0.9 + 0.1524, 3);
    const raise = chat("raise the pendant 10 cm").actions[0] as { drop: number };
    expect(raise.drop).toBeCloseTo(0.8, 3);
  });

  it('"put the pendant on the desk" hangs it above the desk instead of making it a floor item', () => {
    const out = chat("put the pendant on the desk");
    // Kept as "on the desk": the app hangs it above the desk wherever the desk is when the step runs.
    expect(out.actions).toEqual([{ type: "move", itemId: "pend_1", placement: { kind: "onTop", targetId: "desk_1" } }]);
    expect(out.reply).toMatch(/hangs from the ceiling/);
  });
});

describe("sanitizer", () => {
  const clean = (actions: unknown[]) => sanitizeChatOutput({ reply: "ok", actions }, scene);

  it("keeps under / onTop.level, drops a bad level, hangs a hanging item above its target, refuses cycles", () => {
    const out = clean([
      { type: "move", itemId: "bin_1", placement: { kind: "under", targetId: "desk_1" } },
      { type: "move", itemId: "cat_1", placement: { kind: "onTop", targetId: "tower_1", level: "Middle" } },
      { type: "move", itemId: "cat_1", placement: { kind: "onTop", targetId: "tower_1", level: "attic" } },
      { type: "move", itemId: "pend_1", placement: { kind: "under", targetId: "desk_1" } },
      { type: "move", itemId: "desk_1", placement: { kind: "under", targetId: "tlamp_1" } },
    ]);
    expect(out.actions).toEqual([
      { type: "move", itemId: "bin_1", placement: { kind: "under", targetId: "desk_1" } },
      { type: "move", itemId: "cat_1", placement: { kind: "onTop", targetId: "tower_1", level: "middle" } },
      { type: "move", itemId: "cat_1", placement: { kind: "onTop", targetId: "tower_1" } },
      // A hanging lamp "under" / "on" the desk: kept; the app hangs it above the desk (it never becomes a floor item).
      { type: "move", itemId: "pend_1", placement: { kind: "under", targetId: "desk_1" } },
    ]);
    expect(out.skipped.map((s) => s.reason)).toEqual(["an item can't go under itself or under something resting on it"]);
    expect(clean([{ type: "move", itemId: "pend_1", placement: { kind: "onTop", targetId: "desk_1", level: "top" } }]).actions).toEqual([
      { type: "move", itemId: "pend_1", placement: { kind: "onTop", targetId: "desk_1" } },
    ]);
  });

  it("hang: drop clamped to the room; -1 / 0 = the app's default", () => {
    const out = clean([
      { type: "hang", itemId: "pend_1", drop: 1.05 },
      { type: "hang", itemId: "tlamp_1", drop: -1 },
      { type: "hang", itemId: "pend_1", drop: 9 },
      { type: "hang", itemId: "nope", drop: 1 },
    ]);
    expect(out.actions).toEqual([
      { type: "hang", itemId: "pend_1", drop: 1.05 },
      { type: "hang", itemId: "tlamp_1" },
      { type: "hang", itemId: "pend_1", drop: 2.14 },
    ]);
    expect(out.skipped).toEqual([{ type: "hang", reason: 'unknown item "nope"' }]);
  });

  it("the output schema accepts under, onTop.level and hang", () => {
    const ok = ChatOutputSchema.safeParse({
      reply: "ok",
      actions: [
        { type: "move", itemId: "bin_1", placement: { kind: "under", targetId: "desk_1" } },
        { type: "move", itemId: "cat_1", placement: { kind: "onTop", targetId: "tower_1", level: "middle" } },
        { type: "hang", itemId: "pend_1", drop: -1 },
      ],
    });
    expect(ok.success).toBe(true);
  });
});

describe("mount of a product / photo item (how the owner's pendant became Mount = Floor)", () => {
  it("reads mount words and pendant-like names", () => {
    expect(mountFrom("ceiling", "Lamp")).toBe("ceiling");
    expect(mountFrom("Ceiling (hanging)", "Lamp")).toBe("ceiling");
    expect(mountFrom("hanging", "Akari lamp")).toBe("ceiling");
    expect(mountFrom("pendant", "Lamp")).toBe("ceiling");
    expect(mountFrom("wall-mounted", "Sconce")).toBe("wall");
    expect(mountFrom("floor", "Rice paper pendant light")).toBe("ceiling");
    expect(mountFrom("wall", "Plug-in pendant")).toBe("wall");
    expect(mountFrom(undefined, "Chandelier")).toBe("ceiling");
    expect(mountFrom("tabletop", "Desk lamp")).toBe("floor");
    expect(mountFrom("???", "Oak dresser")).toBe("floor");
  });

  it("a candidate named like a pendant hangs from the ceiling even when the model wrote another mount", () => {
    const c = sanitizeCandidate({ name: "Paper Pendant Light", url: "https://shop.example/p", mount: "Hanging" as never, dims: { w: 0.4, h: 0.6, d: 0.4 } }, new IdGen());
    expect(c?.mount).toBe("ceiling");
  });
});
