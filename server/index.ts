// Entry point: `tsx server/index.ts` (npm run dev:api).
import dotenv from "dotenv";
import { createApp } from "./app";
import { isUnknownProviderSetting, resolveProvider, type ProviderKind } from "./provider";

dotenv.config({ quiet: true });

const port = Number(process.env.API_PORT) || 8787;

const DESCRIBE: Record<ProviderKind, string> = {
  api: "live: Claude API (ANTHROPIC_API_KEY)",
  subscription: "live: your Claude subscription via the Claude Agent SDK (Claude Code login, no API key)",
  mock: "mock: demo data (MOCK_AI=1 or AI_PROVIDER=mock)",
};

if (isUnknownProviderSetting(process.env)) {
  console.warn(`[api] unknown AI_PROVIDER "${process.env.AI_PROVIDER}"; using auto (api | subscription | mock | auto).`);
}

let app: ReturnType<typeof createApp>;
try {
  app = createApp();
} catch (err) {
  console.error(`[api] failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const server = app.listen(port, () => {
  console.log(`[api] listening on http://localhost:${port} (${DESCRIBE[resolveProvider(process.env)]})`);
});
// Photo analysis and web research can take a couple of minutes; don't let Node cut them off.
server.requestTimeout = 10 * 60 * 1000;
server.headersTimeout = 65 * 1000;
server.on("error", (err) => {
  console.error(`[api] failed to start: ${err.message}`);
  process.exit(1);
});
