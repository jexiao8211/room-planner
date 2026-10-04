// Chat request validation and the shape of the chat output schema sent to structured outputs.
import { describe, expect, it } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ChatAction } from "../src/shared/types";
import { CHAT_ACTION_TYPES, CHAT_LIMITS, ChatOutputSchema, ChatRequestSchema } from "./schemas";
import { jsonSchemaFor } from "./subscription";

const scene = {
  units: "imperial",
  room: { name: "Bedroom", width: 3.66, depth: 3.35, height: 2.44, wallColor: "#eeeeee", floorColor: "#aa8866", openings: [] },
  items: [
    { id: "desk_1", name: "Desk", dims: { w: 1.2, h: 0.75, d: 0.6 }, position: { x: 0, y: 0, z: 0 }, rotationY: 0, mount: "floor", color: "#9c7b57", origin: "shape" },
  ],
  selectedId: null,
};

const item = (i: number) => ({ ...scene.items[0], id: `it_${i}` });

describe("ChatRequestSchema", () => {
  it("accepts a normal request and fills defaults", () => {
    const parsed = ChatRequestSchema.parse({ message: "  add a desk  ", scene: { ...scene, selectedId: undefined } });
    expect(parsed.message).toBe("add a desk");
    expect(parsed.history).toEqual([]);
    expect(parsed.scene.selectedId).toBeNull();
  });

  it("accepts the documented maximums", () => {
    const ok = ChatRequestSchema.safeParse({
      message: "x".repeat(CHAT_LIMITS.message),
      history: Array.from({ length: CHAT_LIMITS.history }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "hi" })),
      scene: { ...scene, items: Array.from({ length: CHAT_LIMITS.items }, (_, i) => item(i)) },
    });
    expect(ok.success).toBe(true);
  });

  it.each([
    ["an empty message", { message: "   ", scene }, "message"],
    ["a message over 4000 characters", { message: "x".repeat(4001), scene }, "message"],
    ["more than 20 history turns", { message: "hi", history: Array.from({ length: 21 }, () => ({ role: "user", content: "x" })), scene }, "history"],
    ["a bad history role", { message: "hi", history: [{ role: "system", content: "x" }], scene }, "history"],
    ["more than 300 items", { message: "hi", scene: { ...scene, items: Array.from({ length: 301 }, (_, i) => item(i)) } }, "scene.items"],
    ["an unknown mount", { message: "hi", scene: { ...scene, items: [{ ...scene.items[0], mount: "table" }] } }, "scene.items"],
    ["a missing scene", { message: "hi" }, "scene"],
    ["a zero room width", { message: "hi", scene: { ...scene, room: { ...scene.room, width: 0 } } }, "scene.room.width"],
  ])("rejects %s", (_name, body, path) => {
    const res = ChatRequestSchema.safeParse(body);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues[0].path.join(".")).toContain(path);
  });
});

// ---------- structured-output schema ----------

type Node = Record<string, unknown>;

function walk(node: unknown, visit: (n: Node, key: string | null) => void, key: string | null = null): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit, key);
    return;
  }
  if (!node || typeof node !== "object") return;
  visit(node as Node, key);
  for (const [k, v] of Object.entries(node)) walk(v, visit, k);
}

/** The counts the API limits: optional properties (<= 24) and union-typed properties (<= 16). */
function complexity(schema: unknown) {
  let optional = 0;
  let unions = 0;
  const keywords = new Set<string>();
  walk(schema, (n) => {
    for (const k of Object.keys(n)) keywords.add(k);
    if (n.type === "object" && n.properties) {
      const required = new Set((n.required as string[] | undefined) ?? []);
      optional += Object.keys(n.properties as Node).filter((p) => !required.has(p)).length;
      expect(n.additionalProperties).toBe(false);
    }
    if (Array.isArray(n.anyOf) || Array.isArray(n.type)) unions++;
  });
  return { optional, unions, keywords };
}

describe("ChatOutputSchema as structured-output JSON schema", () => {
  const forApi = (() => {
    const { parse: _parse, ...format } = zodOutputFormat(ChatOutputSchema);
    return format.schema;
  })();
  const forAgentSdk = jsonSchemaFor(ChatOutputSchema);

  it.each([
    ["API (zodOutputFormat)", forApi],
    ["Agent SDK (jsonSchemaFor)", forAgentSdk],
  ])("%s: stays inside the documented limits and keywords", (_name, schema) => {
    const { optional, unions, keywords } = complexity(schema);
    expect(optional).toBeLessThanOrEqual(24);
    expect(unions).toBeLessThanOrEqual(16);
    for (const bad of ["oneOf", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "maxItems", "multipleOf"]) {
      expect(keywords.has(bad), bad).toBe(false);
    }
  });

  it("keeps the discriminator constants for the Agent SDK and lists every action type", () => {
    const consts: string[] = [];
    walk(forAgentSdk, (n, key) => {
      if (key === "type" && typeof n.const === "string") consts.push(n.const);
    });
    expect(new Set(consts)).toEqual(new Set(CHAT_ACTION_TYPES));
  });

  it("keeps field descriptions next to optional fields on the API path", () => {
    const text = JSON.stringify(forApi);
    expect(text).toContain("Short handle");
    expect(text).toContain("Placeholder item the product should replace");
  });

  it("covers exactly the ChatAction types of the shared contract", () => {
    const contract: Record<ChatAction["type"], true> = {
      addShape: true,
      move: true,
      rotate: true,
      resize: true,
      recolor: true,
      rename: true,
      remove: true,
      duplicate: true,
      setRoom: true,
      search: true,
      addCandidate: true,
      previewCandidate: true,
      select: true,
      camera: true,
      undo: true,
      setHidden: true,
      setMount: true,
      setHeight: true,
      setOpening: true,
      hang: true,
      saveVersion: true,
      restoreVersion: true,
      setLighting: true,
      setLight: true,
      setWindow: true,
    };
    expect([...CHAT_ACTION_TYPES].sort()).toEqual(Object.keys(contract).sort());
  });

  it("parses a typical answer", () => {
    const ok = ChatOutputSchema.safeParse({
      reply: "Added a monitor on the desk.",
      actions: [
        { type: "addShape", ref: "mon1", name: "Monitor", dims: { w: 0.6, h: 0.4, d: 0.2 }, placement: { kind: "onTop", targetId: "desk_1", level: "top" } },
        { type: "rotate", itemId: "mon1", degrees: 15, relative: true },
        { type: "setRoom", patch: { name: "", width: 3.66, depth: 0, height: 0, wallColor: "", floorColor: "" } },
      ],
    });
    expect(ok.success).toBe(true);
  });
});

describe("review round 4: schema additions", () => {
  it("accepts lastSearch.previewIndex in a request and the floor placement in an answer", () => {
    const req = ChatRequestSchema.safeParse({
      message: "add it",
      scene: { ...scene, lastResults: [{ index: 0, name: "N", retailer: "R", dims: { w: 0.5, h: 0.6, d: 0.4 }, mount: "floor" }], lastSearch: { query: "q", previewIndex: 0 } },
    });
    expect(req.success).toBe(true);
    if (req.success) expect(req.data.scene.lastSearch?.previewIndex).toBe(0);
    const out = ChatOutputSchema.safeParse({ reply: "ok", actions: [{ type: "move", itemId: "x", placement: { kind: "floor" } }] });
    expect(out.success).toBe(true);
  });
});
