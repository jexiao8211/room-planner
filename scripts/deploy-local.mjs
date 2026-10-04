// Publishes the current build to release/, which is what the owner's app (npm start) serves.
// Agents build into dist/ while they work; only this step changes what the owner sees.
//
// dist/version.json is written by the build (vite.config.ts) with the same build id the client has baked in,
// so open pages can tell a new release is out. It is copied LAST: a page polling while the copy runs only
// sees the new id once every other file of the release is in place.
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// DEPLOY_TARGET (default release/) lets the script be tried against a scratch folder.
const target = process.env.DEPLOY_TARGET || "release";

if (!existsSync("dist/index.html")) {
  console.error("deploy:local: dist/ has no build; run npm run build first");
  process.exit(1);
}
let version;
try {
  version = JSON.parse(readFileSync("dist/version.json", "utf8"));
} catch {
  version = null;
}
if (!version || typeof version.buildId !== "string" || !version.buildId) {
  console.error("deploy:local: dist/version.json is missing or has no buildId; run npm run build again");
  process.exit(1);
}
// Another `npm run build` (other agents build into dist/ too) can rewrite dist/ while this copies it. Snapshot it into
// a private folder first, check that the snapshot is ONE build (the id in version.json is the one baked into its
// JS, and every script index.html loads is there), and publish only the snapshot. A release whose version.json and
// bundle disagree would make every open page reload over and over.
const snap = mkdtempSync(path.join(os.tmpdir(), "room-planner-deploy-"));
try {
  cpSync("dist", snap, { recursive: true });
  const snapVersion = JSON.parse(readFileSync(path.join(snap, "version.json"), "utf8"));
  const id = snapVersion?.buildId;
  const html = readFileSync(path.join(snap, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script[^>]+src="\/?([^"]+)"/g)].map((m) => m[1]);
  const missing = scripts.filter((src) => !existsSync(path.join(snap, src)));
  const baked = scripts.some((src) => existsSync(path.join(snap, src)) && readFileSync(path.join(snap, src), "utf8").includes(id));
  if (typeof id !== "string" || !scripts.length || missing.length || !baked) {
    console.error(
      `deploy:local: dist/ changed while it was being copied, or is not one build (version.json ${id ?? "?"}, ` +
        `${missing.length ? `missing ${missing.join(", ")}` : baked ? "" : "that id is not in the bundle"}); run npm run deploy:local again`,
    );
    process.exit(1);
  }
  rmSync(target, { recursive: true, force: true });
  for (const entry of readdirSync(snap)) {
    if (entry === "version.json") continue;
    cpSync(path.join(snap, entry), path.join(target, entry), { recursive: true });
  }
  cpSync(path.join(snap, "version.json"), path.join(target, "version.json"));
  console.log(`deploy:local: published dist/ to ${target}/ (buildId ${id}, built ${snapVersion.builtAt ?? "?"})`);
} finally {
  rmSync(snap, { recursive: true, force: true });
}
