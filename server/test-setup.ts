// Vitest setup for every test file: real Claude Agent SDK calls are never allowed in tests (they spend the
// owner's subscription credit). Tests that exercise the subscription provider inject a fake query().
import { vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    throw new Error("Real Claude Agent SDK calls are blocked in tests: pass a fake `query` to createSubscriptionProvider.");
  },
}));
