// Express app factory. Tests use createApp() directly (app.listen(0)); index.ts adds dotenv + listen.
import express, { type NextFunction, type Request, type Response } from "express";
import type { ApiError, ChatRequest, HealthResponse, ProductSearchRequest, RoomFromPhotosRequest } from "../src/shared/types";
import { type AiProvider, resolveProvider } from "./provider";
import { createMockProvider, type MockOptions } from "./mock";
import { createClaudeProvider } from "./claude";
import { createSubscriptionProvider, type SubscriptionProviderOptions } from "./subscription";
import { HttpError } from "./errors";
import { ChatRequestSchema, ProductSearchRequestSchema, RoomFromPhotosRequestSchema, zodMessage } from "./schemas";
import { withInferredFilters } from "../src/lib/queryFilters";
import { cleanUrl } from "./sanitize";

export interface AppOptions {
  /** Environment to read AI_PROVIDER / ANTHROPIC_API_KEY / MOCK_AI from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Inject a provider (tests). Overrides env-based selection. */
  provider?: AiProvider;
  mock?: MockOptions;
  /** Options for the subscription provider (tests inject a fake query()). */
  subscription?: SubscriptionProviderOptions;
}

/** Pick the provider from AI_PROVIDER (auto | api | subscription | mock); see resolveProvider. */
export function createProvider(opts: AppOptions = {}): AiProvider {
  if (opts.provider) return opts.provider;
  const env = opts.env ?? process.env;
  const kind = resolveProvider(env);
  if (kind === "api") {
    const key = (env.ANTHROPIC_API_KEY ?? "").trim();
    if (!key) throw new Error("AI_PROVIDER=api needs ANTHROPIC_API_KEY in .env (or use AI_PROVIDER=subscription / auto).");
    return createClaudeProvider(key);
  }
  if (kind === "subscription") return createSubscriptionProvider({ env, ...opts.subscription });
  return createMockProvider(opts.mock);
}

/** Abort upstream work if the client goes away before we answer. */
function abortOnClose(res: Response): AbortSignal {
  const ctrl = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) ctrl.abort();
  });
  return ctrl.signal;
}

export function createApp(opts: AppOptions = {}) {
  const provider = createProvider(opts);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "25mb" }));

  app.get("/api/health", (_req, res) => {
    const body: HealthResponse = { ok: true, mode: provider.mode, provider: provider.kind };
    res.json(body);
  });

  app.post("/api/rooms/from-photos", async (req, res) => {
    const parsed = RoomFromPhotosRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, zodMessage(parsed.error));
    const result = await provider.roomFromPhotos(parsed.data as RoomFromPhotosRequest, abortOnClose(res));
    res.json(result);
  });

  app.post("/api/products/search", async (req, res) => {
    const parsed = ProductSearchRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, zodMessage(parsed.error));
    // "under $200" / "hanging lamp" in the text count as filters when the form fields are empty.
    const data = parsed.data as ProductSearchRequest;
    const request = data.exactFilters ? data : withInferredFilters(data);
    const result = await provider.searchProducts(request, abortOnClose(res));
    // Never offer a listing the client asked to leave out (the product it wants alternatives to).
    const excluded = new Set((request.excludeUrls ?? []).map(cleanUrl).filter(Boolean));
    if (excluded.size) result.candidates = result.candidates.filter((c) => !excluded.has(cleanUrl(c.url)));
    res.json(result);
  });

  app.post("/api/chat", async (req, res) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, zodMessage(parsed.error));
    const result = await provider.chat(parsed.data as ChatRequest, abortOnClose(res));
    res.json(result);
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" } satisfies ApiError);
  });

  // Express 5 forwards rejected async handlers here.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const { status, message } = describeError(err);
    if (status >= 500) console.error(`[api] ${status}: ${message}`);
    if (res.headersSent) return;
    res.status(status).json({ error: message } satisfies ApiError);
  });

  return app;
}

function describeError(err: unknown): { status: number; message: string } {
  if (err instanceof HttpError) return { status: err.status, message: err.message };
  // body-parser errors carry `type` and `status`.
  const e = err as { type?: string; status?: number; message?: string };
  if (e?.type === "entity.too.large") return { status: 413, message: "Request body too large (limit 25 MB). Use smaller photos." };
  if (e?.type === "entity.parse.failed") return { status: 400, message: "Request body is not valid JSON." };
  if (typeof e?.status === "number" && e.status >= 400 && e.status < 500) {
    return { status: e.status, message: e.message ?? "Bad request" };
  }
  return { status: 500, message: err instanceof Error ? err.message : "Internal server error" };
}
