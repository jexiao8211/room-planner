import { defineConfig, devices } from "@playwright/test";

// E2E runs against mock mode: the API serves demo fixtures, so no Anthropic key or Claude login is needed.
// E2E_WEB_PORT / E2E_API_PORT let tests run while `npm run dev` holds the default ports.
const WEB_PORT = process.env.E2E_WEB_PORT ?? "5173";
const API_PORT = process.env.E2E_API_PORT ?? "8787";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        // Software WebGL so the three.js canvas renders in headless runs on any machine.
        launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] },
      },
    },
  ],
  webServer: [
    {
      name: "api",
      command: "npx tsx server/index.ts",
      url: `http://localhost:${API_PORT}/api/health`,
      // AI_PROVIDER=mock beats any provider set in .env or the shell; MOCK_AI=1 covers the auto rule too.
      env: { AI_PROVIDER: "mock", MOCK_AI: "1", API_PORT },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
    },
    {
      name: "web",
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      env: { API_PORT },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
