import type {
  ChatRequest,
  ChatResponse,
  ProductSearchRequest,
  ProductSearchResponse,
  RoomFromPhotosRequest,
  RoomFromPhotosResponse,
} from "../src/shared/types";

/** Which backend serves the AI calls. "api" and "subscription" are both live Claude; "mock" is demo data. */
export type ProviderKind = "api" | "subscription" | "mock";
/** The AI_PROVIDER setting: a provider, or "auto" to pick one from the environment. */
export type ProviderSetting = "auto" | ProviderKind;

/** The AI-backed operations. Implemented by the API-key client, the subscription client and the mock. */
export interface AiProvider {
  mode: "live" | "mock";
  kind: ProviderKind;
  roomFromPhotos(req: RoomFromPhotosRequest, signal?: AbortSignal): Promise<RoomFromPhotosResponse>;
  searchProducts(req: ProductSearchRequest, signal?: AbortSignal): Promise<ProductSearchResponse>;
  /** One chat turn: a short reply plus sanitized actions for the browser to apply. */
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
}

type Env = Record<string, string | undefined>;

const SETTINGS: readonly ProviderSetting[] = ["auto", "api", "subscription", "mock"];

function isOn(v: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());
}

/** AI_PROVIDER, normalized. Empty or unrecognized values mean "auto". */
export function providerSetting(env: Env): ProviderSetting {
  const raw = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  return (SETTINGS as readonly string[]).includes(raw) ? (raw as ProviderSetting) : "auto";
}

/** True when AI_PROVIDER is set to something other than a known value (worth a startup warning). */
export function isUnknownProviderSetting(env: Env): boolean {
  const raw = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  return raw !== "" && !(SETTINGS as readonly string[]).includes(raw);
}

/**
 * An explicit AI_PROVIDER wins. "auto" (the default): MOCK_AI on → mock; ANTHROPIC_API_KEY set → api;
 * otherwise the Claude subscription this machine's Claude Code is signed in with.
 */
export function resolveProvider(env: Env): ProviderKind {
  const setting = providerSetting(env);
  if (setting !== "auto") return setting;
  if (isOn(env.MOCK_AI)) return "mock";
  if ((env.ANTHROPIC_API_KEY ?? "").trim()) return "api";
  return "subscription";
}

/** live (api or subscription) or mock. */
export function resolveMode(env: Env): "live" | "mock" {
  return resolveProvider(env) === "mock" ? "mock" : "live";
}
