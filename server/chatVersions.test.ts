// Design versions in chat: request schema, output schema, sanitizer, prompt and the demo parser.
import { describe, expect, it } from "vitest";
import type { ChatScene } from "../src/shared/types";
import { ChatOutputSchema, ChatRequestSchema } from "./schemas";
import { sanitizeChatOutput } from "./sanitizeChat";
import { mockChatReply } from "./mockChat";
import { CHAT_SYSTEM, chatSceneJson } from "./prompts";

const versions: NonNullable<ChatScene["versions"]> = [
  { id: "ver_new", name: "Before chat changes", createdAt: Date.now() - 60_000, auto: true },
  { id: "ver_b", name: "Option B", createdAt: Date.now() - 120_000, auto: false },
  { id: "ver_a", name: "Option A", createdAt: Date.now() - 600_000, auto: false },
];

const scene: ChatScene = {
  units: "imperial",
  room: { name: "Bedroom", width: 3.66, depth: 3.35, height: 2.44, wallColor: "#e9e4dc", floorColor: "#b89874", openings: [] },
  items: [
    { id: "desk_1", name: "Desk", dims: { w: 1.2, h: 0.75, d: 0.6 }, position: { x: 0, y: 0, z: 0 }, rotationY: 0, mount: "floor", color: "#9c7b57", origin: "shape" },
  ],
  selectedId: null,
  versions,
};

function chat(message: string, s: ChatScene = scene) {
  const raw = mockChatReply({ message, scene: s });
  return { raw, out: sanitizeChatOutput(raw, s) };
}

describe("schemas", () => {
  it("the chat request accepts scene.versions (and requests without it)", () => {
    const ok = ChatRequestSchema.safeParse({ message: "go back to option A", scene });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.scene.versions).toEqual(versions);
    const { versions: _v, ...noVersions } = scene;
    expect(ChatRequestSchema.safeParse({ message: "hi", scene: noVersions }).success).toBe(true);
    const bad = ChatRequestSchema.safeParse({ message: "hi", scene: { ...scene, versions: [{ id: "", name: "x", createdAt: 1, auto: false }] } });
    expect(bad.success).toBe(false);
  });

  it("the output schema has saveVersion / restoreVersion with required fields", () => {
    const ok = ChatOutputSchema.safeParse({
      reply: "Saved.",
      actions: [
        { type: "saveVersion", name: "Option A" },
        { type: "restoreVersion", versionId: "ver_a" },
      ],
    });
    expect(ok.success).toBe(true);
    expect(ChatOutputSchema.safeParse({ reply: "x", actions: [{ type: "restoreVersion" }] }).success).toBe(false);
  });
});

describe("sanitizer", () => {
  const clean = (actions: unknown[], s: ChatScene = scene) => sanitizeChatOutput({ reply: "ok", actions }, s);

  it("keeps a known version id and a clipped name", () => {
    const out = clean([
      { type: "saveVersion", name: `  Option   C ${"x".repeat(200)}` },
      { type: "saveVersion", name: "" },
      { type: "restoreVersion", versionId: "ver_b" },
    ]);
    expect(out.actions[0]).toEqual({ type: "saveVersion", name: expect.stringMatching(/^Option C x+$/) });
    expect((out.actions[0] as { name: string }).name.length).toBe(80);
    expect(out.actions[1]).toEqual({ type: "saveVersion" });
    expect(out.actions[2]).toEqual({ type: "restoreVersion", versionId: "ver_b" });
    expect(out.skipped).toEqual([]);
  });

  it("drops an unknown version id (with a reason) but maps an exact name to its id", () => {
    const out = clean([
      { type: "restoreVersion", versionId: "ver_made_up" },
      { type: "restoreVersion", versionId: "option a" },
    ]);
    expect(out.actions).toEqual([{ type: "restoreVersion", versionId: "ver_a" }]);
    expect(out.skipped).toEqual([{ type: "restoreVersion", reason: 'unknown version "ver_made_up"' }]);
  });

  it("says so when there are no versions at all", () => {
    const out = clean([{ type: "restoreVersion", versionId: "ver_a" }], { ...scene, versions: undefined });
    expect(out.actions).toEqual([]);
    expect(out.reply).toBe("I couldn't do that: there are no saved versions yet.");
  });
});

describe("prompt", () => {
  it("teaches both actions and lists the versions in the scene JSON", () => {
    expect(CHAT_SYSTEM).toContain("- saveVersion:");
    expect(CHAT_SYSTEM).toContain("- restoreVersion:");
    const json = JSON.parse(chatSceneJson(scene));
    expect(json.versions).toEqual([
      { id: "ver_new", name: "Before chat changes", auto: true, savedMinutesAgo: 1 },
      { id: "ver_b", name: "Option B", auto: false, savedMinutesAgo: 2 },
      { id: "ver_a", name: "Option A", auto: false, savedMinutesAgo: 10 },
    ]);
    expect(JSON.parse(chatSceneJson({ ...scene, versions: [] })).versions).toBeUndefined();
  });
});

describe("demo parser", () => {
  it.each([
    ["save this as option A", { type: "saveVersion", name: "Option A" }],
    ["Save this as Option A", { type: "saveVersion", name: "Option A" }],
    ['save the design as "Cozy layout"', { type: "saveVersion", name: "Cozy layout" }],
    ["save a version", { type: "saveVersion" }],
    ["save", { type: "saveVersion" }],
    ["please save the current layout", { type: "saveVersion" }],
  ])("%s", (msg, action) => {
    const { out } = chat(msg);
    expect(out.actions).toEqual([action]);
    expect(out.reply).toMatch(/^Saved/);
  });

  it.each([
    ["go back to option A", "ver_a"],
    ["go back to Option B", "ver_b"],
    ["restore option a", "ver_a"],
    ["restore the previous version", "ver_new"],
    ["go back to the last saved version", "ver_new"],
    ["show me the version from before the chat changes", "ver_new"],
    ["revert to the option A version", "ver_a"],
  ])("%s", (msg, id) => {
    const { out } = chat(msg);
    expect(out.actions).toEqual([{ type: "restoreVersion", versionId: id }]);
    expect(out.reply).toMatch(/^Restored “/);
  });

  it("a version that doesn't exist gets an answer, not an undo", () => {
    expect(chat("go back to option Z").out).toMatchObject({ actions: [], reply: expect.stringContaining("couldn't find a saved version") });
    expect(chat("go back to option A", { ...scene, versions: undefined }).out).toMatchObject({
      actions: [],
      reply: expect.stringContaining("no saved versions yet"),
    });
  });

  it("leaves other commands alone", () => {
    expect(chat("go back").out.actions).toEqual([{ type: "undo", steps: 1 }]);
    expect(chat("undo").out.actions).toEqual([{ type: "undo", steps: 1 }]);
    expect(chat("show me the desk").out.actions.every((a) => a.type !== "restoreVersion")).toBe(true);
    // "save this as option A and add a desk" saves first, then adds.
    const two = chat("save this as option A and add a lamp").out.actions.map((a) => a.type);
    expect(two).toEqual(["saveVersion", "addShape"]);
  });
});
