// Chat wiring for the live providers and the HTTP route, all offline: the API client gets a stubbed fetch that
// replays a streamed response, the subscription provider a fake query(). No real Claude / Agent SDK call is made.
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChatRequest, ChatResponse } from "../src/shared/types";
import { MODEL, chatMessages, createClaudeProvider } from "./claude";
import { BUDGET_USD, SUBSCRIPTION_MODEL, createSubscriptionProvider, type QueryFn } from "./subscription";
import { CHAT_SYSTEM } from "./prompts";
import { HttpError } from "./errors";
import { createApp } from "./app";
import type { AiProvider } from "./provider";

const req: ChatRequest = {
  message: "put a monitor on the desk",
  history: [
    { role: "assistant", content: "Hi! What should we do?" },
    { role: "user", content: "add a desk" },
    { role: "assistant", content: "Added a desk." },
    { role: "user", content: "   " },
  ],
  scene: {
    units: "imperial",
    room: { name: "Bedroom", width: 3.66, depth: 3.35, height: 2.44, wallColor: "#e9e4dc", floorColor: "#b89874", openings: [] },
    items: [{ id: "desk_1", name: "Desk", dims: { w: 1.2, h: 0.75, d: 0.6 }, position: { x: 0, y: 0, z: 0 }, rotationY: 0, mount: "floor", color: "#9c7b57", origin: "shape" }],
    selectedId: "desk_1",
  },
};

/** A model answer with one good action, one on an invented id, and an off-case type. */
const answer = {
  reply: "Added a monitor on the desk.",
  actions: [
    { type: "addShape", ref: "mon1", name: "Monitor", dims: { w: 0.6, h: 0.4, d: 0.2 }, placement: { kind: "onTop", targetId: "desk_1" } },
    { type: "recolor", itemId: "item_that_does_not_exist", color: "#ff0000" },
    { type: "Rotate", itemId: "mon1", degrees: 10, relative: true },
  ],
};

const expectedActions = [
  { type: "addShape", ref: "mon1", name: "Monitor", dims: { w: 0.6, h: 0.4, d: 0.2 }, placement: { kind: "onTop", targetId: "desk_1" } },
  { type: "rotate", itemId: "mon1", degrees: 10, relative: true },
];

async function rejection(promise: Promise<unknown>): Promise<HttpError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
}

// ---------- API provider ----------

function sse(text: string, stopReason: string): string {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return (
    ev("message_start", {
      message: { id: "m", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } },
    }) +
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
    ev("content_block_stop", { index: 0 }) +
    ev("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 10 } }) +
    ev("message_stop", {})
  );
}

function stubApi(body: string) {
  const bodies: Array<Record<string, unknown>> = [];
  const f = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { fetch: f, bodies };
}

describe("API provider chat", () => {
  it("sends a low-effort structured-output call with history as turns and returns sanitized actions", async () => {
    const stub = stubApi(sse(JSON.stringify(answer), "end_turn"));
    const lines: string[] = [];
    const p = createClaudeProvider("sk-test-not-real", { fetch: stub.fetch, log: (l) => lines.push(l) });
    const res = await p.chat(req);
    expect(res).toEqual({
      reply: "Added a monitor on the desk. (I skipped 1 step I couldn't apply.)",
      actions: expectedActions,
      mock: false,
      skipped: [{ type: "recolor", reason: 'unknown item "item_that_does_not_exist"' }],
    });
    expect(lines.join("\n")).toContain("item_that_does_not_exist");

    expect(stub.bodies).toHaveLength(1);
    const body = stub.bodies[0] as {
      model: string;
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
      stream: boolean;
      messages: Array<{ role: string; content: string }>;
      output_config: { effort: string; format: { type: string; schema: Record<string, unknown> } };
    };
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.stream).toBe(true);
    // The stable system prompt is one text block with a cache breakpoint (the API only caches with one).
    expect(body.system).toEqual([{ type: "text", text: CHAT_SYSTEM, cache_control: { type: "ephemeral" } }]);
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(JSON.stringify(body.output_config.format.schema)).not.toContain("oneOf");
    // Leading assistant turn and the blank user turn are dropped; the scene rides on the final user turn.
    expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(body.messages[0].content).toBe("add a desk");
    const last = body.messages[2].content;
    expect(last).toContain('"id":"desk_1"');
    expect(last).toContain('"selectedId":"desk_1"');
    expect(last).toContain("<message>\nput a monitor on the desk\n</message>");
    // The system prompt never carries the scene (cache-friendly).
    expect(body.system[0].text).not.toContain("desk_1");
  });

  it("chatMessages keeps the final user turn even with no history", () => {
    const msgs = chatMessages({ ...req, history: [] });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
  });

  it("reports a refusal, truncation and non-JSON as 502s", async () => {
    for (const [text, stop, match] of [
      ["no", "refusal", /declined/],
      ['{"reply": "Add', "max_tokens", /ran out of room/],
      ["not json", "end_turn", /unusable chat answer/],
    ] as const) {
      const p = createClaudeProvider("sk-test-not-real", { fetch: stubApi(sse(text, stop)).fetch });
      const err = await rejection(p.chat(req));
      expect(err.status).toBe(502);
      expect(err.message).toMatch(match);
    }
  });
});

// ---------- subscription provider ----------

function fakeQuery(script: (options: Options) => SDKMessage[]) {
  const calls: Array<{ options: Options; prompt: SDKUserMessage[] }> = [];
  const query: QueryFn = (params) => {
    const call = { options: params.options ?? {}, prompt: [] as SDKUserMessage[] };
    calls.push(call);
    return (async function* () {
      if (typeof params.prompt !== "string") for await (const m of params.prompt) call.prompt.push(m);
      yield* script(call.options);
    })();
  };
  return { query, calls };
}

const result = (extra: Record<string, unknown>) =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    total_cost_usd: 0.0123,
    duration_ms: 5,
    duration_api_ms: 5,
    num_turns: 1,
    stop_reason: "end_turn",
    session_id: "s",
    ...extra,
  }) as unknown as SDKMessage;

function subscription(query: QueryFn) {
  const lines: string[] = [];
  const p = createSubscriptionProvider({ query, cwd: path.join(os.tmpdir(), "room-planner-agent-test"), env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-must-not-leak" }, log: (l) => lines.push(l) });
  return { p, lines };
}

describe("subscription provider chat", () => {
  it("runs with no tools, low effort, the chat budget and every cost-safety option", async () => {
    const { query, calls } = fakeQuery(() => [result({ structured_output: answer })]);
    const { p, lines } = subscription(query);
    const res = await p.chat(req);
    expect(res.actions).toEqual(expectedActions);
    expect(res.mock).toBe(false);

    expect(calls).toHaveLength(1);
    const o = calls[0].options;
    expect(o.model).toBe(SUBSCRIPTION_MODEL);
    expect(o.systemPrompt).toBe(CHAT_SYSTEM);
    expect(o.tools).toEqual([]);
    expect(o.allowedTools).toEqual([]);
    expect(o.permissionMode).toBeUndefined();
    expect(o.effort).toBe("low");
    expect(o.maxBudgetUsd).toBe(BUDGET_USD.chat);
    expect(BUDGET_USD.chat).toBeLessThanOrEqual(0.5);
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.mcpServers).toEqual({});
    expect(o.persistSession).toBe(false);
    expect(o.verbatimPrompts).toBe(true);
    expect("ANTHROPIC_API_KEY" in o.env!).toBe(false);
    expect(o.outputFormat?.type).toBe("json_schema");
    const schema = JSON.stringify((o.outputFormat as { schema: unknown }).schema);
    expect(schema).not.toContain("oneOf");
    expect(schema).toContain('"anyOf"');

    // One user turn: transcript of the history, then the scene and the message.
    const prompt = calls[0].prompt[0].message.content as string;
    expect(prompt).toContain("<conversation>");
    expect(prompt).toContain("User: add a desk");
    expect(prompt).toContain('"id":"desk_1"');
    expect(prompt.trim().endsWith("</message>")).toBe(true);

    expect(lines.some((l) => /^\[subscription\] chat: [\d.]+s, \$0\.0123, success$/.test(l))).toBe(true);
  });

  it("falls back to the JSON result text when there is no structured_output", async () => {
    const { query } = fakeQuery(() => [result({ result: JSON.stringify({ reply: "Undone.", actions: [{ type: "undo", steps: 1 }] }) })]);
    const res = await subscription(query).p.chat(req);
    expect(res).toEqual({ reply: "Undone.", actions: [{ type: "undo", steps: 1 }], mock: false });
  });

  it("explains the chat budget ceiling", async () => {
    const { query } = fakeQuery(() => [
      { type: "result", subtype: "error_max_budget_usd", is_error: true, errors: [], total_cost_usd: 0.5, num_turns: 1, session_id: "s" } as unknown as SDKMessage,
    ]);
    const err = await rejection(subscription(query).p.chat(req));
    expect(err.message).toContain(`cost ceiling ($${BUDGET_USD.chat})`);
    expect(err.message).toMatch(/shorter message/);
  });

  it("an empty answer is a 502", async () => {
    const { query } = fakeQuery(() => [result({ result: "" })]);
    const err = await rejection(subscription(query).p.chat(req));
    expect(err.status).toBe(502);
  });
});

// ---------- HTTP route ----------

describe("POST /api/chat", () => {
  let base = "";
  let server: Server;
  const seen: ChatRequest[] = [];

  beforeAll(async () => {
    const fake: AiProvider = {
      mode: "live",
      kind: "api",
      roomFromPhotos: () => Promise.reject(new Error("unused")),
      searchProducts: () => Promise.reject(new Error("unused")),
      chat: async (r) => {
        seen.push(r);
        return { reply: "ok", actions: [], mock: false };
      },
    };
    const app = createApp({ provider: fake });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const post = (body: unknown) => fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("passes a validated request (defaults filled) to the provider", async () => {
    const res = await post({ message: " hi ", scene: { ...req.scene, selectedId: undefined } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ChatResponse).reply).toBe("ok");
    expect(seen.at(-1)).toMatchObject({ message: "hi", history: [], scene: { selectedId: null } });
  });

  it("rejects oversized or malformed requests with 400", async () => {
    const tooLong = await post({ message: "x".repeat(4001), history: [], scene: req.scene });
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { error: string }).error).toMatch(/^message: /);
    const noScene = await post({ message: "hi" });
    expect(noScene.status).toBe(400);
  });

  it("works end to end in mock mode", async () => {
    const app = createApp({ env: { AI_PROVIDER: "mock" }, mock: { chatDelayMs: 0 } });
    const s = await new Promise<Server>((resolve) => {
      const x = app.listen(0, () => resolve(x));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...req, message: "add a monitor on the desk" }),
      });
      const body = (await res.json()) as ChatResponse;
      expect(body.mock).toBe(true);
      expect(body.actions).toEqual([expect.objectContaining({ type: "addShape", name: "Monitor", placement: { kind: "onTop", targetId: "desk_1" } })]);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});
