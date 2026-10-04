import { describe, expect, it } from "vitest";
import { isUnknownProviderSetting, providerSetting, resolveMode, resolveProvider, type ProviderKind } from "./provider";
import { createProvider } from "./app";

const KEY = "sk-test-not-real";

describe("provider selection", () => {
  it.each<[string, Record<string, string | undefined>, ProviderKind]>([
    // auto (default)
    ["nothing set → subscription", {}, "subscription"],
    ["empty key → subscription", { ANTHROPIC_API_KEY: "  " }, "subscription"],
    ["key → api", { ANTHROPIC_API_KEY: KEY }, "api"],
    ["MOCK_AI=1 → mock", { MOCK_AI: "1" }, "mock"],
    ["MOCK_AI=true with a key → mock", { MOCK_AI: "true", ANTHROPIC_API_KEY: KEY }, "mock"],
    ["MOCK_AI=0 with a key → api", { MOCK_AI: "0", ANTHROPIC_API_KEY: KEY }, "api"],
    ["AI_PROVIDER=auto with a key → api", { AI_PROVIDER: "auto", ANTHROPIC_API_KEY: KEY }, "api"],
    ["unknown AI_PROVIDER falls back to auto", { AI_PROVIDER: "openai" }, "subscription"],
    // explicit
    ["AI_PROVIDER=api", { AI_PROVIDER: "api", ANTHROPIC_API_KEY: KEY }, "api"],
    ["AI_PROVIDER=subscription beats a key", { AI_PROVIDER: "subscription", ANTHROPIC_API_KEY: KEY }, "subscription"],
    ["AI_PROVIDER=Subscription (case, spaces)", { AI_PROVIDER: " Subscription " }, "subscription"],
    ["AI_PROVIDER=mock beats a key", { AI_PROVIDER: "mock", ANTHROPIC_API_KEY: KEY }, "mock"],
    ["explicit AI_PROVIDER beats MOCK_AI", { AI_PROVIDER: "subscription", MOCK_AI: "1" }, "subscription"],
  ])("%s", (_name, env, expected) => {
    expect(resolveProvider(env)).toBe(expected);
    expect(resolveMode(env)).toBe(expected === "mock" ? "mock" : "live");
  });

  it("normalizes the setting and flags unknown values", () => {
    expect(providerSetting({})).toBe("auto");
    expect(providerSetting({ AI_PROVIDER: "MOCK" })).toBe("mock");
    expect(isUnknownProviderSetting({ AI_PROVIDER: "openai" })).toBe(true);
    expect(isUnknownProviderSetting({ AI_PROVIDER: "" })).toBe(false);
    expect(isUnknownProviderSetting({ AI_PROVIDER: "api" })).toBe(false);
  });

  it("createProvider builds the matching provider without calling anything", () => {
    expect(createProvider({ env: { MOCK_AI: "1" } }).kind).toBe("mock");
    expect(createProvider({ env: { ANTHROPIC_API_KEY: KEY } }).kind).toBe("api");
    const sub = createProvider({ env: {} });
    expect(sub.kind).toBe("subscription");
    expect(sub.mode).toBe("live");
  });
});
