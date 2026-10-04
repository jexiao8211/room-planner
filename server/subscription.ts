// Subscription provider: real Claude calls through the Claude Agent SDK, billed to the Claude Pro/Max plan that
// Claude Code on this machine is signed in with (the plan's Agent SDK credit). No API key involved.
//
// Every call runs the bundled Claude Code CLI as a child process, so the options below matter for cost: no
// settings files, no MCP servers (not even the account's claude.ai connectors), no session files, a custom
// system prompt instead of Claude Code's own, an empty working directory, and a hard dollar ceiling per call.
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Options, SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ChatRequest,
  ChatResponse,
  ProductSearchRequest,
  ProductSearchResponse,
  RoomFromPhotosRequest,
  RoomFromPhotosResponse,
} from "../src/shared/types";
import type { AiProvider } from "./provider";
import { HttpError } from "./errors";
import { ChatOutputSchema, ProductListSchema, RoomEstimateSchema, zodMessage } from "./schemas";
import {
  CHAT_SYSTEM,
  RESEARCH_SYSTEM,
  ROOM_SYSTEM,
  STRUCTURE_SYSTEM,
  chatUserPrompt,
  researchUserPrompt,
  roomUserPrompt,
  structureUserPrompt,
} from "./prompts";
import { productResponseFromList, roomResponseFromEstimate } from "./postprocess";
import { chatResponseFrom } from "./sanitizeChat";

export const SUBSCRIPTION_MODEL = "claude-opus-5-5";

/** Per-call dollar ceilings (sanity caps, not targets). The SDK stops the call with error_max_budget_usd. */
export const BUDGET_USD = { room: 1.5, research: 3, structure: 1, chat: 0.5 } as const;
export const RESEARCH_MAX_TURNS = 25;
export const RESEARCH_TOOLS = ["WebSearch", "WebFetch"];

export type Phase = keyof typeof BUDGET_USD;

/** The SDK's query(), narrowed to what this provider uses so tests can pass a fake. */
export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => AsyncIterable<SDKMessage>;

export interface SubscriptionProviderOptions {
  /** Inject query() (tests). Defaults to the real SDK, loaded on first use. */
  query?: QueryFn;
  /** Environment the child env is filtered from (see agentEnv). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Working directory for the agent. Defaults to an empty folder under the OS temp dir. */
  cwd?: string;
  /** Skip fetching candidate product pages (tests). */
  verifyPages?: boolean;
  /** fetch for the product-page check (tests). */
  fetch?: typeof fetch;
  /** One line per call (phase, duration, cost). Defaults to console.log. */
  log?: (line: string) => void;
}

// ---------- user-facing errors ----------

// With AI_PROVIDER=subscription set explicitly an API key alone does nothing, so the hint names both settings.
const API_KEY_HINT = "or set ANTHROPIC_API_KEY with AI_PROVIDER=auto or api";

export const AUTH_MESSAGE = `Claude subscription login not found or expired — run \`claude\` in a terminal and sign in (${API_KEY_HINT}).`;
export const LIMIT_MESSAGE = `Your plan's Agent SDK credit or usage limit is used up. Wait for it to reset, turn on usage credits in your Claude account settings, ${API_KEY_HINT}.`;
export const ACCOUNT_MESSAGE = `Your Claude account needs attention (on hold or awaiting verification). Sign in at claude.ai to resolve it, ${API_KEY_HINT}.`;

const PHASE_NAME: Record<Phase, string> = {
  room: "room analysis",
  research: "product research",
  structure: "product structuring",
  chat: "chat reply",
};

/** What to try after a phase hits its cost ceiling. */
const BUDGET_HINT: Record<Phase, string> = {
  room: "Try fewer photos.",
  research: "Try a narrower, more specific query (e.g. one product type, a style or a budget).",
  structure: "Try a narrower, more specific query (e.g. one product type, a style or a budget).",
  chat: "Try a shorter message, or ask for fewer changes at once.",
};

/** Broad match for the CLI's own error text in a result (result.result / result.errors). */
const AUTH_TEXT = /not logged in|please (?:run \/)?log ?in|\/login|authenticat|oauth|invalid api key|\b401\b|unauthori[sz]ed/i;
const LIMIT_TEXT = /credit|usage limit|rate.?limit|\b429\b|quota|billing|limit reached|out of (?:extra )?usage/i;
/**
 * Narrow match for process-exit messages and stderr, where unrelated log lines can mention words like "oauth"
 * or "credit": only the CLI's specific login / limit phrases count.
 */
const STDERR_AUTH = /please run \/login|not logged in|invalid api key|oauth token (?:has )?(?:expired|been revoked)|authentication_error/i;
const STDERR_LIMIT = /credit balance is too low|usage limit reached|out of extra usage|rate_limit_error|you(?:'|’)ve hit your (?:usage )?limit/i;

type Problem = "auth" | "limit" | "account";

function classifyText(text: string): Problem | null {
  if (AUTH_TEXT.test(text)) return "auth";
  if (LIMIT_TEXT.test(text)) return "limit";
  return null;
}

function classifyStderr(text: string): Problem | null {
  if (STDERR_AUTH.test(text)) return "auth";
  if (STDERR_LIMIT.test(text)) return "limit";
  return null;
}

function problemError(p: Problem): HttpError {
  return new HttpError(502, p === "auth" ? AUTH_MESSAGE : p === "limit" ? LIMIT_MESSAGE : ACCOUNT_MESSAGE);
}

function short(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** The client went away (or the request was otherwise cancelled). Not a server fault. */
export function cancelledError(): HttpError {
  return new HttpError(499, "Request cancelled.");
}

/** HTTP status of the failed API request, when the result carries one. */
function problemFromStatus(status: number | null | undefined): Problem | null {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 429) return "limit";
  return null;
}

const ASSISTANT_ERROR: Partial<Record<string, Problem>> = {
  authentication_failed: "auth",
  oauth_org_not_allowed: "auth",
  account_on_hold: "account",
  verification_required: "account",
  billing_error: "limit",
  rate_limit: "limit",
};

/**
 * Structured auth / account / limit signals the CLI streams before (or instead of) a result. Only the latest
 * state counts: an earlier rate-limit error the CLI retried past, or a rejected window the run continued past on
 * overage, says nothing about why the run finally failed.
 */
function problemFromMessages(messages: SDKMessage[]): Problem | null {
  let lastAssistant: SDKMessage | undefined;
  let lastRateLimit: Extract<SDKMessage, { type: "rate_limit_event" }> | undefined;
  for (const m of messages) {
    if (m.type === "assistant") lastAssistant = m;
    else if (m.type === "rate_limit_event") lastRateLimit = m;
    else if (m.type === "auth_status" && m.error) return "auth";
  }
  if (lastAssistant?.type === "assistant" && lastAssistant.error) {
    const p = ASSISTANT_ERROR[lastAssistant.error];
    if (p) return p;
  }
  const info = lastRateLimit?.rate_limit_info;
  if (info?.status === "rejected") {
    const onOverage = info.isUsingOverage === true || info.overageStatus === "allowed" || info.overageStatus === "allowed_warning";
    if (!onOverage) return "limit";
  }
  return null;
}

/** Turn a non-successful result (or a missing one) into a user-facing error. */
export function resultError(phase: Phase, result: SDKResultMessage | undefined, messages: SDKMessage[]): HttpError {
  const what = PHASE_NAME[phase];
  if (result?.subtype === "error_max_budget_usd") {
    return new HttpError(502, `The ${what} hit its cost ceiling ($${BUDGET_USD[phase]}) before finishing. ${BUDGET_HINT[phase]}`);
  }
  if (result?.subtype === "error_max_turns") {
    return new HttpError(
      502,
      `The ${what} ran out of steps before finishing. Try a narrower, more specific query (e.g. one product type, a style or a budget).`,
    );
  }
  if (result?.subtype === "error_max_structured_output_retries") {
    return new HttpError(502, `Claude could not produce a valid ${what} answer. Please try again.`);
  }
  const detail = !result ? "" : result.subtype === "success" ? result.result : result.errors.join("; ");
  const status = result?.subtype === "success" ? result.api_error_status : undefined;
  const problem = problemFromStatus(status) ?? problemFromMessages(messages) ?? classifyText(detail);
  if (problem) return problemError(problem);
  if (!result) return new HttpError(502, `Claude Code ended the ${what} without an answer. Please try again.`);
  return new HttpError(502, `The ${what} failed in the Claude Agent SDK${detail.trim() ? `: ${short(detail)}` : "."}`);
}

/** Map an exception thrown while running query() (spawn failure, process exit, abort). */
export function thrownError(phase: Phase, err: unknown, stderrTail = ""): HttpError {
  if (err instanceof HttpError) return err;
  const e = err as { name?: string; code?: string; message?: string };
  if (e?.name === "AbortError") return cancelledError();
  if (e?.code === "ENOENT") {
    return new HttpError(502, `Could not start Claude Code for the Agent SDK. Run npm install, ${API_KEY_HINT} to use the API instead.`);
  }
  const message = typeof e?.message === "string" ? e.message : String(err);
  const problem = classifyStderr(`${message}\n${stderrTail}`);
  if (problem) return problemError(problem);
  return new HttpError(502, `The ${PHASE_NAME[phase]} failed in the Claude Agent SDK: ${short(message) || "unknown error"}`);
}

// ---------- research sources ----------

export interface AgentSources {
  /** http(s) URLs from WebSearch hits and successfully fetched WebFetch pages, deduped, in order of appearance. */
  sourceUrls: string[];
  /** Failed web searches (shown in the notes, like the API provider's web_search errors). */
  searchErrors: string[];
  searchCount: number;
  /** Tool results whose URLs came from the CLI's structured tool output (vs. the text fallback). For the log. */
  structuredResults: number;
}

const MAX_SOURCE_URLS = 300;

type Block = { type?: string; [k: string]: unknown };

function blocksOf(content: unknown): Block[] {
  return Array.isArray(content) ? (content.filter((b) => b && typeof b === "object") as Block[]) : [];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return blocksOf(content)
    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("\n");
}

/**
 * The machine-written hit list in a WebSearch tool result's text (`Links: [{"title":…,"url":…}, …]`), which the
 * CLI renders from the search API's hits. Any commentary around it is model text and is ignored.
 */
function searchLinksFromText(text: string): string[] {
  const urls: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*Links:\s*(\[.*\])\s*$/.exec(line);
    if (!m) continue;
    try {
      const hits = JSON.parse(m[1]) as unknown;
      if (Array.isArray(hits)) {
        for (const h of hits) {
          const url = h && typeof h === "object" ? (h as { url?: unknown }).url : undefined;
          if (typeof url === "string") urls.push(url);
        }
      }
    } catch {
      // not the CLI's hit list
    }
  }
  return urls;
}

const isOk = (code: unknown) => typeof code === "number" && code >= 200 && code < 300;

/**
 * URLs the research agent actually reached, never URLs a model wrote: WebSearch hits from the search API and
 * the URL of each WebFetch that returned a 2xx page. The *text* of a WebFetch result is a model's summary of the
 * page, and WebSearch results can carry model commentary, so links mentioned inside them are not sources. These
 * feed the same "host appeared in the research" check the API provider applies.
 */
export function extractAgentSources(messages: SDKMessage[]): AgentSources {
  const toolUses = new Map<string, { name: string; input: unknown }>();
  const urls: string[] = [];
  const errors: string[] = [];
  let searchCount = 0;
  let structuredResults = 0;
  const add = (u: unknown) => {
    if (typeof u !== "string" || urls.length >= MAX_SOURCE_URLS) return;
    const clean = u.trim();
    if (/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(clean) && !urls.includes(clean)) urls.push(clean);
  };

  for (const m of messages) {
    if (m.type === "assistant") {
      for (const b of blocksOf(m.message.content)) {
        if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          toolUses.set(b.id, { name: b.name, input: b.input });
        }
        // Server-side search results, in case the CLI surfaces them directly (hits from the search API).
        if (b.type === "web_search_tool_result") {
          searchCount++;
          if (Array.isArray(b.content)) for (const r of b.content as Array<{ url?: unknown }>) add(r?.url);
        }
      }
      continue;
    }
    if (m.type !== "user") continue;
    const results = blocksOf(m.message.content).filter((b) => b.type === "tool_result");
    // The CLI's structured tool output, attached to the message that carries a single tool's result.
    const out = ("tool_use_result" in m ? m.tool_use_result : undefined) as
      | { results?: unknown; url?: unknown; code?: unknown }
      | undefined;
    const structured = results.length === 1 && out && typeof out === "object" ? out : undefined;
    for (const b of results) {
      const use = toolUses.get(String(b.tool_use_id));
      const name = use?.name;
      if (name !== "WebSearch" && name !== "WebFetch") continue;
      if (name === "WebSearch") searchCount++;
      if (b.is_error) {
        if (name === "WebSearch") errors.push("search error");
        continue;
      }
      if (structured) {
        structuredResults++;
        if (name === "WebSearch" && Array.isArray(structured.results)) {
          for (const r of structured.results) {
            const hits = r && typeof r === "object" ? (r as { content?: unknown }).content : undefined;
            if (Array.isArray(hits)) for (const hit of hits as Array<{ url?: unknown }>) add(hit?.url);
          }
        }
        if (name === "WebFetch" && isOk(structured.code)) add(structured.url);
        continue;
      }
      // Fallback when no structured output is attached.
      const text = textOf(b.content);
      if (name === "WebSearch") {
        for (const u of searchLinksFromText(text)) add(u);
      } else if (!/redirect detected|redirects? to a different host/i.test(text)) {
        // A fetch that didn't error: the URL the agent fetched (not any link the summary mentions).
        add((use?.input as { url?: unknown } | undefined)?.url);
      }
    }
  }
  return { sourceUrls: urls, searchErrors: errors, searchCount, structuredResults };
}

// ---------- plumbing ----------

/** JSON Schema for the SDK's outputFormat, from the same zod schema the result is validated with. */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const json = anyOfForOneOf(z.toJSONSchema(schema)) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/** zod writes discriminated unions as `oneOf`; structured outputs support `anyOf` (same meaning here). */
function anyOfForOneOf(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(anyOfForOneOf);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k === "oneOf" ? "anyOf" : k] = anyOfForOneOf(v);
  return out;
}

/**
 * Variables the Claude Code child may inherit (matched case-insensitively: Windows names are). Everything else is
 * dropped, in particular every ANTHROPIC_* / CLAUDE_* variable, so a server started from inside a Claude Code
 * session (or with ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_BASE_URL in .env) can't route,
 * label or authenticate the call as anything but this machine's subscription login via the Agent SDK.
 */
const ENV_ALLOW = new Set(
  [
    ...["PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"],
    ...["USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USER", "LOGNAME", "SHELL"],
    ...["APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES"],
    ...["TEMP", "TMP", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"],
    ...["LANG", "LC_ALL", "LC_CTYPE", "TZ"],
    ...["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"],
    // Where this user's own Claude Code login lives, and the Git Bash Claude Code uses on Windows.
    ...["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_GIT_BASH_PATH"],
  ].map((k) => k.toUpperCase()),
);

/** Child-process environment: an allowlist of OS basics, the subscription login only, no claude.ai MCP connectors. */
export function agentEnv(base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && ENV_ALLOW.has(k.toUpperCase())) env[k] = v;
  env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "room-planner/0.1.0";
  return env;
}

export function defaultAgentCwd(): string {
  return path.join(os.tmpdir(), "room-planner-agent");
}

/** A single user turn as streaming input (required for images). */
async function* userTurn(content: SDKUserMessage["message"]["content"]): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

interface RunSpec {
  phase: Phase;
  system: string;
  content: SDKUserMessage["message"]["content"];
  tools: string[];
  effort: "low" | "medium" | "high";
  maxTurns?: number;
  schema?: z.ZodType;
}

export function createSubscriptionProvider(opts: SubscriptionProviderOptions = {}): AiProvider {
  const log = opts.log ?? ((line: string) => console.log(line));
  const cwd = opts.cwd ?? defaultAgentCwd();
  let cwdReady = false;
  let queryFn: QueryFn | undefined = opts.query;

  async function loadQuery(): Promise<QueryFn> {
    if (!queryFn) queryFn = (await import("@anthropic-ai/claude-agent-sdk")).query as QueryFn;
    return queryFn;
  }

  function buildOptions(spec: RunSpec, abortController: AbortController, onStderr: (d: string) => void): Options {
    const options: Options = {
      model: SUBSCRIPTION_MODEL,
      systemPrompt: spec.system,
      cwd,
      tools: spec.tools,
      allowedTools: spec.tools,
      // Cost safety: nothing from ~/.claude or the project, no MCP servers, no transcript files.
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      persistSession: false,
      // Prompt text includes what the user typed: deliver it as-is (no @file expansion, no slash commands).
      verbatimPrompts: true,
      env: agentEnv(opts.env ?? process.env),
      abortController,
      maxBudgetUsd: BUDGET_USD[spec.phase],
      effort: spec.effort,
      stderr: onStderr,
    };
    if (spec.tools.length) options.permissionMode = "dontAsk";
    if (spec.maxTurns) options.maxTurns = spec.maxTurns;
    if (spec.schema) options.outputFormat = { type: "json_schema", schema: jsonSchemaFor(spec.schema) };
    return options;
  }

  /** Run one query() to completion. Returns the successful result and every message (for source URLs). */
  async function run(spec: RunSpec, signal?: AbortSignal): Promise<{ result: Extract<SDKResultMessage, { subtype: "success" }>; messages: SDKMessage[] }> {
    if (signal?.aborted) throw cancelledError();
    const query = await loadQuery();
    if (!cwdReady) {
      mkdirSync(cwd, { recursive: true });
      cwdReady = true;
    }
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    // Last few KB of the CLI's stderr: only to recognize login / limit failures, never logged or returned.
    let stderrTail = "";
    const onStderr = (d: string) => {
      stderrTail = (stderrTail + d).slice(-4000);
    };

    const started = Date.now();
    const messages: SDKMessage[] = [];
    let result: SDKResultMessage | undefined;
    try {
      for await (const m of query({ prompt: userTurn(spec.content), options: buildOptions(spec, abortController, onStderr) })) {
        messages.push(m);
        if (m.type === "result") result = m;
      }
    } catch (err) {
      if (signal?.aborted) throw cancelledError();
      throw thrownError(spec.phase, err, stderrTail);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const cost = typeof result?.total_cost_usd === "number" ? `$${result.total_cost_usd.toFixed(4)}` : "cost n/a";
      const outcome = signal?.aborted ? "cancelled" : result ? `${result.subtype}${result.is_error ? " (is_error)" : ""}` : "no result";
      log(`[subscription] ${spec.phase}: ${secs}s, ${cost}, ${outcome}`);
    }
    if (signal?.aborted) throw cancelledError();
    if (!result || result.subtype !== "success" || result.is_error) throw resultError(spec.phase, result, messages);
    return { result, messages };
  }

  /** Validate the structured answer with the same zod schema the API provider uses. */
  function parseStructured<S extends z.ZodType>(schema: S, result: { structured_output?: unknown; result: string }, phase: Phase): z.infer<S> {
    let value = result.structured_output;
    if (value === undefined || value === null) {
      try {
        value = JSON.parse(result.result);
      } catch {
        throw new HttpError(502, `Claude returned an empty ${PHASE_NAME[phase]} answer. Please try again.`);
      }
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new HttpError(502, `Claude returned an unusable ${PHASE_NAME[phase]} answer: ${zodMessage(parsed.error)}`);
    return parsed.data;
  }

  async function roomFromPhotos(req: RoomFromPhotosRequest, signal?: AbortSignal): Promise<RoomFromPhotosResponse> {
    const { result } = await run(
      {
        phase: "room",
        system: ROOM_SYSTEM,
        content: [
          ...req.photos.map((p) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: p.mediaType, data: p.dataBase64 },
          })),
          { type: "text" as const, text: roomUserPrompt(req) },
        ],
        tools: [],
        effort: "high",
        schema: RoomEstimateSchema,
      },
      signal,
    );
    return roomResponseFromEstimate(parseStructured(RoomEstimateSchema, result, "room"), req);
  }

  async function searchProducts(req: ProductSearchRequest, signal?: AbortSignal): Promise<ProductSearchResponse> {
    // Step 1: research with Claude Code's WebSearch / WebFetch tools; the final answer is the report.
    const research = await run(
      {
        phase: "research",
        system: RESEARCH_SYSTEM,
        content: researchUserPrompt(req),
        tools: RESEARCH_TOOLS,
        effort: "medium",
        maxTurns: RESEARCH_MAX_TURNS,
      },
      signal,
    );
    const report = research.result.result.trim();
    const sources = extractAgentSources(research.messages);
    log(
      `[subscription] research sources: ${sources.sourceUrls.length} URL(s) from ${sources.searchCount} search(es), ` +
        `${sources.structuredResults} structured tool result(s), ${sources.searchErrors.length} search error(s)`,
    );
    if (!report) {
      const why = sources.searchErrors.length ? ` (${sources.searchErrors.length} web search error(s))` : "";
      throw new HttpError(502, `Product research came back empty${why}. Please try again.`);
    }

    // Step 2: structure the report (no tools), validated with the shared schema.
    const structured = await run(
      {
        phase: "structure",
        system: STRUCTURE_SYSTEM,
        content: structureUserPrompt(req, report, sources.sourceUrls),
        tools: [],
        effort: "medium",
        schema: ProductListSchema,
      },
      signal,
    );
    const list = parseStructured(ProductListSchema, structured.result, "structure");

    // Step 3: the same sanitize / grounding / budget / page check as the API provider.
    return productResponseFromList(list, req, sources, { verifyPages: opts.verifyPages, fetch: opts.fetch, signal });
  }

  /**
   * One chat turn: no tools, low effort, the chat budget cap. The earlier conversation goes into the single user
   * turn as a transcript. The answer is checked action by action in sanitizeChat (not all-or-nothing).
   */
  async function chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const { result } = await run(
      {
        phase: "chat",
        system: CHAT_SYSTEM,
        content: chatUserPrompt(req, { transcript: true }),
        tools: [],
        effort: "low",
        schema: ChatOutputSchema,
      },
      signal,
    );
    let raw = result.structured_output;
    if (raw === undefined || raw === null) {
      try {
        raw = JSON.parse(result.result);
      } catch {
        throw new HttpError(502, "Claude returned an empty chat reply. Please try again.");
      }
    }
    return chatResponseFrom(raw, req.scene, false, log);
  }

  return { mode: "live", kind: "subscription", roomFromPhotos, searchProducts, chat };
}
