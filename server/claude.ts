// Live provider: real Claude calls via @anthropic-ai/sdk.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type {
  ChatRequest,
  ChatResponse,
  ProductSearchRequest,
  ProductSearchResponse,
  RoomFromPhotosRequest,
  RoomFromPhotosResponse,
} from "../src/shared/types";
import type { AiProvider } from "./provider";
import { HttpError, toUpstreamError } from "./errors";
import { ChatOutputSchema, ProductListSchema, RoomEstimateSchema } from "./schemas";
import type { z } from "zod";
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
import { extractResearch } from "./convert";
import { productResponseFromList, roomResponseFromEstimate } from "./postprocess";
import { chatResponseFrom } from "./sanitizeChat";

export const MODEL = "claude-opus-5-5";
const MAX_CONTINUATIONS = 4;

export interface ClaudeProviderOptions {
  /** Custom fetch for the Anthropic client AND the product-page check (tests stub it). */
  fetch?: typeof fetch;
  /** Skip fetching candidate product pages (tests). */
  verifyPages?: boolean;
  /** Where skipped chat actions are logged. Defaults to console.log. */
  log?: (line: string) => void;
}

/**
 * The chat as Messages API turns: earlier turns as real user / assistant messages (empty ones dropped, and the
 * list starts with a user turn), then the scene + new message as the final user turn.
 */
export function chatMessages(req: ChatRequest): Anthropic.MessageParam[] {
  const turns = req.history.filter((t) => t.content.trim());
  while (turns.length && turns[0].role !== "user") turns.shift();
  return [...turns.map((t): Anthropic.MessageParam => ({ role: t.role, content: t.content })), { role: "user", content: chatUserPrompt(req) }];
}

/** Throw a user-facing error when the model declined. Call before reading content. */
export function assertNotRefused(msg: Pick<Anthropic.Message, "stop_reason" | "stop_details">, what: string): void {
  if (msg.stop_reason !== "refusal") return;
  const category = msg.stop_details?.category;
  throw new HttpError(502, `Claude declined the ${what} request${category ? ` (${category})` : ""}. Try rephrasing it.`);
}

export function createClaudeProvider(apiKey: string, opts: ClaudeProviderOptions = {}): AiProvider {
  // maxRetries covers 429/5xx/connection errors with backoff.
  const client = new Anthropic({ apiKey, maxRetries: 2, ...(opts.fetch ? { fetch: opts.fetch } : {}) });

  /**
   * One structured-output call, returning the raw JSON text. Streams (large max_tokens on a non-streaming call
   * trips the SDK's long-request guard) and reads the text itself AFTER checking stop_reason: the SDK's own
   * parsing (messages.parse, or a format with `parse` on a stream) runs first and turns a refusal or a truncated
   * answer into a generic "Failed to parse" error.
   */
  async function structuredText(
    schema: z.ZodType,
    params: { max_tokens: number; system: string; messages: Anthropic.MessageParam[]; effort: "low" | "medium" | "high"; cacheSystem?: boolean },
    what: { name: string; truncated: string },
    signal?: AbortSignal,
  ): Promise<{ text: string; parse: (text: string) => unknown }> {
    const { parse, ...format } = zodOutputFormat(schema);
    const msg = await client.messages
      .stream(
        {
          model: MODEL,
          max_tokens: params.max_tokens,
          // A cache breakpoint on a prompt that every turn repeats (the chat): the API only caches with one.
          system: params.cacheSystem ? [{ type: "text", text: params.system, cache_control: { type: "ephemeral" } }] : params.system,
          messages: params.messages,
          output_config: { effort: params.effort, format },
        },
        { signal },
      )
      .finalMessage();
    assertNotRefused(msg, what.name);
    if (msg.stop_reason === "max_tokens") throw new HttpError(502, what.truncated);
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (!text.trim()) throw new HttpError(502, `Claude returned an empty ${what.name} answer. Please try again.`);
    return { text, parse };
  }

  /** structuredText, validated with the schema (the whole answer must match). */
  async function structured<S extends z.ZodType>(
    schema: S,
    params: { max_tokens: number; system: string; messages: Anthropic.MessageParam[]; effort: "low" | "medium" | "high" },
    what: { name: string; truncated: string },
    signal?: AbortSignal,
  ): Promise<z.infer<S>> {
    const { text, parse } = await structuredText(schema, params, what, signal);
    try {
      return parse(text) as z.infer<S>;
    } catch (err) {
      throw new HttpError(502, `Claude returned an unusable ${what.name} answer: ${err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : "parse error"}`);
    }
  }

  async function roomFromPhotos(req: RoomFromPhotosRequest, signal?: AbortSignal): Promise<RoomFromPhotosResponse> {
    try {
      const content: Anthropic.ContentBlockParam[] = [
        ...req.photos.map(
          (p): Anthropic.ImageBlockParam => ({
            type: "image",
            source: { type: "base64", media_type: p.mediaType, data: p.dataBase64 },
          }),
        ),
        { type: "text", text: roomUserPrompt(req) },
      ];
      const est = await structured(
        RoomEstimateSchema,
        { max_tokens: 32000, system: ROOM_SYSTEM, messages: [{ role: "user", content }], effort: "high" },
        { name: "room analysis", truncated: "Claude ran out of room before finishing the estimate. Try fewer photos, or add a note to skip small items." },
        signal,
      );
      return roomResponseFromEstimate(est, req);
    } catch (err) {
      throw toUpstreamError(err);
    }
  }

  /** Step 1: web research with the server-side web_search tool. Streams; resumes pause_turn. */
  async function research(req: ProductSearchRequest, signal?: AbortSignal) {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: researchUserPrompt(req) }];
    const responses: Anthropic.Message[] = [];
    for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
      const msg = await client.messages
        .stream(
          {
            model: MODEL,
            max_tokens: 32000,
            system: RESEARCH_SYSTEM,
            messages,
            tools: [
              {
                type: "web_search_20260209",
                name: "web_search",
                max_uses: 8,
                // The budget and prices are USD: steer results to US retailers.
                user_location: { type: "approximate", country: "US" },
              },
            ],
            output_config: { effort: "medium" },
          },
          { signal },
        )
        .finalMessage();
      assertNotRefused(msg, "product search");
      responses.push(msg);
      if (msg.stop_reason !== "pause_turn") break;
      // Server-side tool loop paused: send the partial assistant turn back and the API resumes it.
      messages.push({ role: "assistant", content: msg.content });
    }
    return extractResearch(responses);
  }

  async function searchProducts(req: ProductSearchRequest, signal?: AbortSignal): Promise<ProductSearchResponse> {
    try {
      const found = await research(req, signal);
      if (!found.report) {
        const why = found.searchErrors.length ? ` (web search errors: ${found.searchErrors.join(", ")})` : "";
        throw new HttpError(502, `Product research came back empty${why}. Please try again.`);
      }

      // Step 2: structure the report. Separate call: web search and structured output don't mix.
      const list = await structured(
        ProductListSchema,
        {
          max_tokens: 16000,
          system: STRUCTURE_SYSTEM,
          messages: [{ role: "user", content: structureUserPrompt(req, found.report, found.sourceUrls) }],
          effort: "medium",
        },
        { name: "product structuring", truncated: "Claude ran out of room while listing the products. Please try again." },
        signal,
      );

      // Step 3 (shared with the subscription provider): sanitize, ground, budget, open each product page.
      return await productResponseFromList(list, req, found, { verifyPages: opts.verifyPages, fetch: opts.fetch, signal });
    } catch (err) {
      throw toUpstreamError(err);
    }
  }

  /**
   * One chat turn at low effort (it's an interactive loop). The answer is parsed as plain JSON and checked action by
   * action in sanitizeChat (not all-or-nothing against the zod schema), so one odd action doesn't sink the turn.
   */
  async function chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    try {
      const { text } = await structuredText(
        ChatOutputSchema,
        { max_tokens: 16000, system: CHAT_SYSTEM, messages: chatMessages(req), effort: "low", cacheSystem: true },
        { name: "chat", truncated: "Claude ran out of room while answering. Try asking for fewer changes at once." },
        signal,
      );
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new HttpError(502, "Claude returned an unusable chat answer. Please try again.");
      }
      return chatResponseFrom(raw, req.scene, false, opts.log ?? ((line) => console.log(line)));
    } catch (err) {
      throw toUpstreamError(err);
    }
  }

  return { mode: "live", kind: "api", roomFromPhotos, searchProducts, chat };
}
