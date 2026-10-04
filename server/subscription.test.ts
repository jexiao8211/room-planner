// Subscription provider, exercised offline with a fake query() that replays scripted SDK messages.
// No real Agent SDK call is ever made (server/test-setup.ts also stubs the SDK module for every test file).
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProductSearchRequest } from "../src/shared/types";
import { HttpError } from "./errors";
import type { ProductList, RoomEstimate } from "./schemas";
import { RESEARCH_SYSTEM, ROOM_SYSTEM, STRUCTURE_SYSTEM, roomUserPrompt } from "./prompts";
import {
  ACCOUNT_MESSAGE,
  AUTH_MESSAGE,
  BUDGET_USD,
  LIMIT_MESSAGE,
  RESEARCH_MAX_TURNS,
  RESEARCH_TOOLS,
  SUBSCRIPTION_MODEL,
  agentEnv,
  createSubscriptionProvider,
  extractAgentSources,
  type QueryFn,
  type SubscriptionProviderOptions,
} from "./subscription";

// ---------- fakes ----------

type Script = SDKMessage[] | ((options: Options) => AsyncGenerator<SDKMessage>);

interface Call {
  options: Options;
  prompt: SDKUserMessage[];
}

/** query() stand-in: each call takes the next script, records its options and drains the streamed prompt. */
function fakeQuery(scripts: Script[]): { query: QueryFn; calls: Call[] } {
  const queue = [...scripts];
  const calls: Call[] = [];
  const query: QueryFn = (params) => {
    const script = queue.shift();
    if (!script) throw new Error("unexpected extra query() call");
    const call: Call = { options: params.options ?? {}, prompt: [] };
    calls.push(call);
    return (async function* () {
      if (typeof params.prompt !== "string") for await (const m of params.prompt) call.prompt.push(m);
      if (typeof script === "function") yield* script(call.options);
      else yield* script;
    })();
  };
  return { query, calls };
}

const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage;

const init = () => msg({ type: "system", subtype: "init", apiKeySource: "none", session_id: "s" });

function success(extra: Record<string, unknown> = {}): SDKMessage {
  return msg({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    total_cost_usd: 0.1234,
    duration_ms: 10,
    duration_api_ms: 10,
    num_turns: 1,
    stop_reason: "end_turn",
    session_id: "s",
    ...extra,
  });
}

function errorResult(subtype: string, errors: string[] = [], extra: Record<string, unknown> = {}): SDKMessage {
  return msg({ type: "result", subtype, is_error: true, errors, total_cost_usd: 0.5, num_turns: 3, session_id: "s", ...extra });
}

const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
  msg({ type: "assistant", message: { role: "assistant", content }, parent_tool_use_id: null, session_id: "s", ...extra });
const toolUse = (id: string, name: string, input: unknown) => assistant([{ type: "tool_use", id, name, input }]);
const toolResult = (id: string, content: unknown, extra: Record<string, unknown> = {}, isError = false) =>
  msg({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
    parent_tool_use_id: null,
    session_id: "s",
    ...extra,
  });

const CWD = path.join(os.tmpdir(), "room-planner-agent-test");

function provider(query: QueryFn, extra: Partial<SubscriptionProviderOptions> = {}) {
  const lines: string[] = [];
  const p = createSubscriptionProvider({
    query,
    cwd: CWD,
    env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-must-not-leak", HOME: "/home/me" },
    verifyPages: false,
    log: (l) => lines.push(l),
    ...extra,
  });
  return { p, lines };
}

async function rejection(promise: Promise<unknown>): Promise<HttpError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
}

/** The options every call must carry to keep cost down and stay on the subscription. */
function expectCostSafeOptions(o: Options) {
  expect(o.model).toBe(SUBSCRIPTION_MODEL);
  expect(o.settingSources).toEqual([]);
  expect(o.strictMcpConfig).toBe(true);
  expect(o.mcpServers).toEqual({});
  expect(o.persistSession).toBe(false);
  expect(o.verbatimPrompts).toBe(true);
  expect(o.cwd).toBe(CWD);
  expect(o.abortController).toBeInstanceOf(AbortController);
  expect(o.env).toBeDefined();
  expect("ANTHROPIC_API_KEY" in o.env!).toBe(false);
  expect(o.env!.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
  expect(o.env!.PATH).toBe("/usr/bin"); // OS basics are passed through
  expect(o.env!.CLAUDE_CODE_ENTRYPOINT).toBe("sdk-ts");
  expect(typeof o.systemPrompt).toBe("string"); // custom prompt, not the Claude Code preset
}

// ---------- fixtures ----------

const PHOTO = { mediaType: "image/jpeg" as const, dataBase64: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U" };

const estimate: RoomEstimate = {
  room: { name: "Bedroom", width: 4, depth: 3.5, height: 2.5, wallColor: "#eeeeee", floorColor: "#aa8866" },
  photos: [{ photoIndex: 1, facingWall: "North", note: "bed wall" }],
  openings: [{ kind: "Door", wall: "south", offset: 0.7, width: 0.8, height: 2.0, sill: 0 }],
  items: [
    {
      name: "Queen bed",
      dims: { w: 1.6, h: 0.9, d: 2.03 },
      mount: "Floor",
      color: "#ccbbaa",
      position: { x: 0, y: 0, z: -0.7 },
      rotationYDegrees: 0,
      parts: [{ kind: "Box", center: { x: 0, y: 0.25, z: 0 }, size: { x: 1, y: 0.5, z: 1 }, color: null }],
    },
  ],
  knownMeasurementEstimateMeters: 2.03,
  confidence: "High",
  notes: "Scaled from the bed.",
};

const candidate = (over: Partial<ProductList["candidates"][number]>): ProductList["candidates"][number] => ({
  name: "Paper Pendant",
  retailer: "Shop A",
  url: "https://shop-a.example/p/paper-pendant",
  price: 120,
  currency: "USD",
  imageUrl: null,
  dims: { w: 0.45, h: 0.9, d: 0.45 },
  dimsSource: "listed",
  dimsText: '18" dia',
  colors: [{ name: "White", hex: "#ffffff" }],
  style: ["Japanese"],
  origin: "Japan",
  materials: ["paper"],
  mount: "ceiling",
  parts: [],
  summary: null,
  ...over,
});

const productList: ProductList = {
  candidates: [
    candidate({}),
    candidate({ name: "Gone Pendant", url: "https://shop-a.example/p/gone", price: 90 }),
    candidate({ name: "Floor Lamp B", retailer: "Shop B", url: "https://shop-b.example/lamp", price: 150 }),
    // Host never appeared in any tool result: likely invented, dropped by the grounding check.
    candidate({ name: "Invented Pendant", retailer: "Nowhere", url: "https://invented.example/p/1", price: 50 }),
    candidate({ name: "Pricey Pendant", url: "https://shop-a.example/p/pricey", price: 900 }),
  ],
  notes: "Found a few.",
};

const searchReq: ProductSearchRequest = {
  query: "paper pendant",
  mount: "ceiling",
  maxPrice: 200,
  room: { width: 3.66, depth: 3.35, height: 2.44 },
};

/** A research run: a search, a fetch, the model's own text (with a URL it made up), then the report. */
function researchScript(report: string): SDKMessage[] {
  return [
    init(),
    toolUse("t1", "WebSearch", { query: "paper pendant lamp" }),
    toolResult(
      "t1",
      'Web search results for query: "paper pendant lamp"\n\nLinks: [{"title":"Paper Pendant","url":"https://shop-a.example/p/paper-pendant"},{"title":"Lamp","url":"https://shop-b.example/lamp"}]',
      {
        tool_use_result: {
          query: "paper pendant lamp",
          results: [
            {
              tool_use_id: "srv1",
              content: [
                { title: "Paper Pendant", url: "https://shop-a.example/p/paper-pendant" },
                { title: "Lamp", url: "https://shop-b.example/lamp" },
                { title: "Pricey", url: "https://shop-a.example/p/pricey" },
              ],
            },
            "Commentary from the model: also try https://commentary.example/p/9",
          ],
          durationSeconds: 1,
        },
      },
    ),
    toolUse("t2", "WebFetch", { url: "https://shop-a.example/p/gone", prompt: "dimensions?" }),
    toolResult("t2", [{ type: "text", text: "Pendant, 18 in diameter. Also sold at https://summary-wrote.example/p/2" }], {
      tool_use_result: { url: "https://shop-a.example/p/gone", code: 200, codeText: "OK", bytes: 1, result: "", durationMs: 1 },
    }),
    assistant([{ type: "text", text: "Maybe also https://invented.example/p/1 (from memory)." }]),
    success({ result: report, total_cost_usd: 0.9876 }),
  ];
}

// ---------- room from photos ----------

describe("subscription: room from photos", () => {
  it("sends images + the room prompt with cost-safe options and post-processes like the API provider", async () => {
    const { query, calls } = fakeQuery([[init(), success({ structured_output: estimate })]]);
    const { p, lines } = provider(query);
    const res = await p.roomFromPhotos({ photos: [PHOTO], knownMeasurement: { label: "bed length", meters: 2.03 } });

    // Same post-processing as the API provider: enums normalized, no second rescale, notes.
    expect(res.mock).toBe(false);
    expect(res.room.width).toBeCloseTo(4, 3);
    expect(res.room.openings.map((o) => [o.kind, o.wall])).toEqual([["door", "south"]]);
    expect(res.existingItems[0].mount).toBe("floor");
    expect(res.notes).toMatch(/already matched/);
    expect(res.notes).toContain("Confidence: high.");

    expect(calls).toHaveLength(1);
    const o = calls[0].options;
    expectCostSafeOptions(o);
    expect(o.systemPrompt).toBe(ROOM_SYSTEM);
    expect(o.tools).toEqual([]);
    expect(o.allowedTools).toEqual([]);
    expect(o.permissionMode).toBeUndefined();
    expect(o.maxBudgetUsd).toBe(BUDGET_USD.room);
    expect(o.outputFormat?.type).toBe("json_schema");
    const schema = o.outputFormat!.schema as { $schema?: string; type: string; properties: Record<string, unknown> };
    expect(schema.$schema).toBeUndefined();
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties)).toContain("knownMeasurementEstimateMeters");

    // Streaming input: one user message, image block(s) before the text.
    expect(calls[0].prompt).toHaveLength(1);
    const content = calls[0].prompt[0].message.content as Array<{ type: string; source?: { data: string; media_type: string }; text?: string }>;
    expect(content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: PHOTO.dataBase64 } });
    expect(content[1]).toEqual({ type: "text", text: roomUserPrompt({ photos: [PHOTO], knownMeasurement: { label: "bed length", meters: 2.03 } }) });

    // One log line: phase, duration, cost. No prompt text, no image data, no key.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[subscription\] room: \d+\.\ds, \$0\.1234, success$/);
  });

  it("rejects structured output that doesn't match the schema", async () => {
    const { query } = fakeQuery([[success({ structured_output: { room: "nope" } })]]);
    const err = await rejection(provider(query).p.roomFromPhotos({ photos: [PHOTO] }));
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/unusable room analysis answer/);
  });

  it("falls back to JSON in the result text when structured_output is missing", async () => {
    const { query } = fakeQuery([[success({ result: JSON.stringify(estimate) })]]);
    const res = await provider(query).p.roomFromPhotos({ photos: [PHOTO] });
    expect(res.room.name).toBe("Bedroom");
  });
});

// ---------- product search ----------

describe("subscription: product search", () => {
  it("researches with WebSearch/WebFetch, structures with a schema, and applies the shared filters", async () => {
    const report = "1. Paper Pendant https://shop-a.example/p/paper-pendant\n2. Lamp https://shop-b.example/lamp";
    const { query, calls } = fakeQuery([researchScript(report), [init(), success({ structured_output: productList, total_cost_usd: 0.05 })]]);
    const fetchStub = (async (input: string | URL | Request) => {
      const url = String(input);
      return url.endsWith("/gone")
        ? new Response("gone", { status: 404 })
        : new Response('<html><head><meta property="og:image" content="/img/x.jpg"></head></html>', {
            status: 200,
            headers: { "content-type": "text/html" },
          });
    }) as typeof fetch;
    const { p, lines } = provider(query, { verifyPages: true, fetch: fetchStub });
    const res = await p.searchProducts(searchReq);

    // Invented host dropped (grounding), over-budget dropped, dead page dropped, image filled from og:image.
    expect(res.mock).toBe(false);
    expect(res.candidates.map((c) => c.name)).toEqual(["Paper Pendant", "Floor Lamp B"]);
    expect(res.candidates[0].imageUrl).toBe("https://shop-a.example/img/x.jpg");
    expect(res.notes).toMatch(/unverified source/);
    expect(res.notes).toMatch(/no longer exists/);

    expect(calls).toHaveLength(2);
    const research = calls[0].options;
    expectCostSafeOptions(research);
    expect(research.systemPrompt).toBe(RESEARCH_SYSTEM);
    expect(research.tools).toEqual(RESEARCH_TOOLS);
    expect(research.allowedTools).toEqual(RESEARCH_TOOLS);
    expect(research.permissionMode).toBe("dontAsk");
    expect(research.maxTurns).toBe(RESEARCH_MAX_TURNS);
    expect(research.maxBudgetUsd).toBe(BUDGET_USD.research);
    expect(research.outputFormat).toBeUndefined();
    expect(calls[0].prompt[0].message.content).toMatch(/Find 4-6 real, currently-sold products matching: "paper pendant"/);

    const structure = calls[1].options;
    expectCostSafeOptions(structure);
    expect(structure.systemPrompt).toBe(STRUCTURE_SYSTEM);
    expect(structure.tools).toEqual([]);
    expect(structure.maxBudgetUsd).toBe(BUDGET_USD.structure);
    expect(structure.outputFormat?.type).toBe("json_schema");
    expect(Object.keys((structure.outputFormat!.schema as { properties: object }).properties)).toEqual(["candidates", "notes"]);
    const structurePrompt = String(calls[1].prompt[0].message.content);
    expect(structurePrompt).toContain(report);
    expect(structurePrompt).toContain("- https://shop-a.example/p/pricey"); // from the structured search hits
    expect(structurePrompt).not.toContain("invented.example"); // the model's own text is not a source
    expect(structurePrompt).not.toContain("commentary.example"); // nor the search commentary
    expect(structurePrompt).not.toContain("summary-wrote.example"); // nor links in the WebFetch summary

    expect(lines.map((l) => l.replace(/\d+\.\ds/, "Ns"))).toEqual([
      "[subscription] research: Ns, $0.9876, success",
      "[subscription] research sources: 4 URL(s) from 1 search(es), 2 structured tool result(s), 0 search error(s)",
      "[subscription] structure: Ns, $0.0500, success",
    ]);
  });

  it("an empty research report stops before the structuring call", async () => {
    const { query, calls } = fakeQuery([[success({ result: "  " })]]);
    const err = await rejection(provider(query).p.searchProducts(searchReq));
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/came back empty/);
    expect(calls).toHaveLength(1);
  });
});

describe("extractAgentSources", () => {
  it("takes URLs from the structured tool output, never from model-written text", () => {
    const sources = extractAgentSources([
      toolUse("a", "WebSearch", { query: "x" }),
      toolResult("a", 'Links: [{"title":"One","url":"https://one.example/p/1"}]\nThe model adds https://comment.example/x', {
        tool_use_result: {
          query: "x",
          results: [{ tool_use_id: "s", content: [{ title: "One", url: "https://one.example/p/1" }] }, "See also https://comment.example/x"],
        },
      }),
      toolUse("b", "WebSearch", { query: "y" }),
      toolResult("b", "Search failed: rate limited", {}, true),
      // A fetched real page whose model-written summary mentions a made-up shop: only the fetched URL counts.
      toolUse("c", "WebFetch", { url: "https://real.example/a", prompt: "dims?" }),
      toolResult("c", "18 in wide. Cheaper at https://made-up-shop.example/p/1", {
        tool_use_result: { url: "https://real.example/a", code: 200, codeText: "OK", result: "18 in wide. Cheaper at https://made-up-shop.example/p/1" },
      }),
      toolUse("d", "WebFetch", { url: "https://dead.example/p" }),
      toolResult("d", "Not found", { tool_use_result: { url: "https://dead.example/p", code: 404 } }),
      toolUse("e", "WebFetch", { url: "https://moved.example/p" }),
      toolResult("e", "REDIRECT DETECTED", { tool_use_result: { url: "https://moved.example/p", code: 301 } }),
      toolUse("f", "Read", { file_path: "x" }),
      toolResult("f", "https://not-a-web-tool.example/file", {}),
      assistant([{ type: "text", text: "see https://model-wrote.example/x" }]),
      assistant([{ type: "web_search_tool_result", content: [{ url: "https://server-search.example/hit" }] }]),
    ]);
    expect(sources.sourceUrls).toEqual(["https://one.example/p/1", "https://real.example/a", "https://server-search.example/hit"]);
    expect(sources.searchErrors).toEqual(["search error"]);
    expect(sources.searchCount).toBe(3);
    expect(sources.structuredResults).toBe(4);
  });

  it("without structured output, falls back to the CLI's Links list and the fetched URL only", () => {
    const sources = extractAgentSources([
      toolUse("a", "WebSearch", { query: "x" }),
      toolResult(
        "a",
        'Web search results for query: "x"\n\nLinks: [{"title":"A","url":"https://a.example/1"},{"title":"B","url":"https://b.example/2"}]\n\nI think https://guess.example/3 sells it too.',
      ),
      toolUse("c", "WebFetch", { url: "https://real.example/a", prompt: "dims?" }),
      toolResult("c", [{ type: "text", text: "Also at https://made-up-shop.example/p/1" }]),
      toolUse("d", "WebFetch", { url: "https://moved.example/p" }),
      toolResult("d", "REDIRECT DETECTED: The URL redirects to a different host."),
    ]);
    expect(sources.sourceUrls).toEqual(["https://a.example/1", "https://b.example/2", "https://real.example/a"]);
    expect(sources.structuredResults).toBe(0);
  });
});

// ---------- errors ----------

describe("subscription: error mapping", () => {
  it.each<[string, Script, RegExp | string]>([
    ["budget ceiling", [errorResult("error_max_budget_usd")], /hit its cost ceiling \(\$1\.5\).*fewer photos/],
    ["max turns", [errorResult("error_max_turns")], /ran out of steps.*narrower/],
    ["structured output retries", [errorResult("error_max_structured_output_retries")], /could not produce a valid room analysis/],
    ["not logged in (result errors)", [errorResult("error_during_execution", ["Not logged in · Please run /login"])], AUTH_MESSAGE],
    [
      "auth failure (assistant error field)",
      [assistant([{ type: "text", text: "Invalid API key" }], { error: "authentication_failed" }), success({ is_error: true, result: "Invalid API key" })],
      AUTH_MESSAGE,
    ],
    ["credit exhausted (result text)", [success({ is_error: true, result: "Credit balance is too low" })], LIMIT_MESSAGE],
    [
      "usage limit (rate_limit_event rejected)",
      [msg({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }), errorResult("error_during_execution")],
      LIMIT_MESSAGE,
    ],
    ["billing error (assistant error field)", [assistant([], { error: "billing_error" }), errorResult("error_during_execution")], LIMIT_MESSAGE],
    ["auth failure (api_error_status 401)", [success({ is_error: true, result: "API Error", api_error_status: 401 })], AUTH_MESSAGE],
    ["usage limit (api_error_status 429)", [success({ is_error: true, result: "API Error", api_error_status: 429 })], LIMIT_MESSAGE],
    ["account on hold (assistant error field)", [assistant([], { error: "account_on_hold" }), errorResult("error_during_execution")], ACCOUNT_MESSAGE],
    [
      "verification required (assistant error field)",
      [assistant([], { error: "verification_required" }), errorResult("error_during_execution")],
      ACCOUNT_MESSAGE,
    ],
    [
      "a rejected window the run continued past on overage is not a limit problem",
      [
        msg({ type: "rate_limit_event", rate_limit_info: { status: "rejected", overageStatus: "allowed", isUsingOverage: true } }),
        errorResult("error_during_execution", ["tool crashed"]),
      ],
      /room analysis failed in the Claude Agent SDK: tool crashed/,
    ],
    [
      "an earlier rate-limit error the CLI retried past is not the reason for a later failure",
      [assistant([], { error: "rate_limit" }), assistant([{ type: "text", text: "ok" }]), errorResult("error_during_execution", ["tool crashed"])],
      /room analysis failed in the Claude Agent SDK: tool crashed/,
    ],
    ["no result at all", [init()], /ended the room analysis without an answer/],
    ["other execution error", [errorResult("error_during_execution", ["something odd"])], /room analysis failed in the Claude Agent SDK: something odd/],
  ])("%s", async (_name, script, expected) => {
    const { query } = fakeQuery([script]);
    const { p, lines } = provider(query);
    const err = await rejection(p.roomFromPhotos({ photos: [PHOTO] }));
    expect(err.status).toBe(502);
    if (typeof expected === "string") expect(err.message).toBe(expected);
    else expect(err.message).toMatch(expected);
    expect(lines).toHaveLength(1); // still logged, with the cost so far
  });

  it("the research budget message suggests narrowing the query", async () => {
    const { query } = fakeQuery([[errorResult("error_max_budget_usd")]]);
    const err = await rejection(provider(query).p.searchProducts(searchReq));
    expect(err.message).toMatch(/product research hit its cost ceiling \(\$3\).*narrower/);
  });

  it("maps thrown errors, using the CLI's stderr to recognize a missing login", async () => {
    const { query } = fakeQuery([
      async function* (options) {
        options.stderr?.("Invalid API key · Please run /login\n");
        throw new Error("Claude Code process exited with code 1");
      },
    ]);
    expect((await rejection(provider(query).p.roomFromPhotos({ photos: [PHOTO] }))).message).toBe(AUTH_MESSAGE);

    const other = fakeQuery([
      async function* () {
        throw new Error("Claude Code process exited with code 3");
      },
    ]);
    const err = await rejection(provider(other.query).p.roomFromPhotos({ photos: [PHOTO] }));
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/failed in the Claude Agent SDK: Claude Code process exited with code 3/);
  });

  it("unrelated stderr lines mentioning oauth or credit don't turn a crash into a login / limit error", async () => {
    const { query } = fakeQuery([
      async function* (options) {
        options.stderr?.("[debug] oauth scopes loaded; credit display enabled; 401 retries=0\n");
        throw new Error("Claude Code process exited with code 1");
      },
    ]);
    const err = await rejection(provider(query).p.roomFromPhotos({ photos: [PHOTO] }));
    expect(err.message).toMatch(/failed in the Claude Agent SDK: Claude Code process exited with code 1/);

    const limit = fakeQuery([
      async function* (options) {
        options.stderr?.("Error: Credit balance is too low\n");
        throw new Error("Claude Code process exited with code 1");
      },
    ]);
    expect((await rejection(provider(limit.query).p.roomFromPhotos({ photos: [PHOTO] }))).message).toBe(LIMIT_MESSAGE);
  });

  it("login / limit messages name AI_PROVIDER alongside the API key", () => {
    for (const m of [AUTH_MESSAGE, LIMIT_MESSAGE, ACCOUNT_MESSAGE]) expect(m).toMatch(/ANTHROPIC_API_KEY with AI_PROVIDER=auto or api/);
  });

  it("a missing executable is reported as such", async () => {
    const { query } = fakeQuery([
      async function* () {
        throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      },
    ]);
    expect((await rejection(provider(query).p.roomFromPhotos({ photos: [PHOTO] }))).message).toMatch(/Could not start Claude Code/);
  });
});

describe("subscription: abort", () => {
  it("aborting the request aborts the SDK call and rejects as cancelled", async () => {
    let seen: AbortController | undefined;
    const { query } = fakeQuery([
      async function* (options) {
        seen = options.abortController;
        yield init();
        await new Promise<void>((resolve) => options.abortController!.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw Object.assign(new Error("Claude Code process aborted by user"), { name: "AbortError" });
      },
    ]);
    const ctrl = new AbortController();
    const { p, lines } = provider(query);
    const pending = p.roomFromPhotos({ photos: [PHOTO] }, ctrl.signal);
    setTimeout(() => ctrl.abort(), 5);
    const err = await rejection(pending);
    expect(err.status).toBe(499);
    expect(err.message).toMatch(/cancelled/);
    expect(seen?.signal.aborted).toBe(true);
    expect(lines[0]).toMatch(/cancelled$/);
  });

  it("an already-aborted request never starts a call", async () => {
    const { query, calls } = fakeQuery([[success({ structured_output: estimate })]]);
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await rejection(provider(query).p.searchProducts(searchReq, ctrl.signal));
    expect(err.status).toBe(499);
    expect(calls).toHaveLength(0);
  });
});

describe("agentEnv", () => {
  it("passes only OS basics: drops the API key and every host Claude Code / Anthropic variable, case-insensitively", () => {
    const env = agentEnv({
      ANTHROPIC_API_KEY: "sk-x",
      anthropic_api_key: "sk-lower",
      ANTHROPIC_AUTH_TOKEN: "tok",
      ANTHROPIC_BASE_URL: "https://proxy.example",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_SESSION_ID: "host-session",
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: "1",
      CLAUDE_CODE_MESSAGING_SOCKET: "sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "mtok",
      CLAUDE_EFFORT: "max",
      ENABLE_CLAUDEAI_MCP_SERVERS: "true",
      SOME_APP_SECRET: "s",
      Path: "p",
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\me",
      TEMP: "t",
      https_proxy: "http://corp-proxy:3128",
      CLAUDE_CONFIG_DIR: "C:\\cfg",
    });
    expect(env).toEqual({
      Path: "p",
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\me",
      TEMP: "t",
      https_proxy: "http://corp-proxy:3128",
      CLAUDE_CONFIG_DIR: "C:\\cfg",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_AGENT_SDK_CLIENT_APP: "room-planner/0.1.0",
    });
  });
});
