// The setup file must replace the real Agent SDK in every test file (no real calls, ever).
import { describe, expect, it } from "vitest";

describe("Agent SDK test guard", () => {
  it("replaces @anthropic-ai/claude-agent-sdk with a stub that only exports a throwing query()", async () => {
    const mod = (await import("@anthropic-ai/claude-agent-sdk")) as Record<string, unknown>;
    // The real module exports many names (AbortError, tool, createSdkMcpServer, ...); the stub has one.
    expect(Object.keys(mod)).toEqual(["query"]);
    expect(String(mod.query)).toMatch(/blocked in tests/);
  });
});
