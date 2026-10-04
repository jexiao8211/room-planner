/// <reference types="vitest/config" />
import { randomBytes } from "node:crypto";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const API_PORT = Number(process.env.API_PORT ?? 8787);

/**
 * Build id for auto-update: baked into the client as __BUILD_ID__ and written next to it as dist/version.json
 * (scripts/deploy-local.mjs publishes that same file). The dev server and tests get "dev", which never reloads.
 */
function buildIdPlugin(): Plugin {
  const builtAt = new Date().toISOString();
  const buildId = `${builtAt.replace(/[-:.]/g, "").replace("T", "-").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
  let isBuild = false;
  return {
    name: "room-planner-build-id",
    config(_cfg, env) {
      isBuild = env.command === "build" && !process.env.VITEST;
      return { define: { __BUILD_ID__: JSON.stringify(isBuild ? buildId : "dev") } };
    },
    generateBundle() {
      if (!isBuild) return;
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ buildId, builtAt }, null, 2) + "\n" });
    },
  };
}

export default defineConfig({
  plugins: [react(), buildIdPlugin()],
  server: {
    port: 5173,
    proxy: { "/api": `http://localhost:${API_PORT}` },
  },
  preview: {
    port: 5173,
    proxy: { "/api": `http://localhost:${API_PORT}` },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "server/**/*.test.ts"],
    // Blocks real Claude Agent SDK calls in every test file.
    setupFiles: ["server/test-setup.ts"],
  },
});
