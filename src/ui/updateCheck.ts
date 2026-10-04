// The page's own build id and the published one (release/version.json), plus the wording for a request that
// died because the app was redeployed under it. No store imports: the stores use this, autoUpdate.ts uses both.
import { CONNECTION_LOST_MID_REQUEST, DEV_BUILD_ID, UPDATED_MID_REQUEST, isNewBuild, parseVersion } from "./updateDecision";

declare const __BUILD_ID__: string;

/** Baked in at build time by vite.config.ts; "dev" under the dev server and in tests. */
export const CURRENT_BUILD_ID: string = typeof __BUILD_ID__ === "string" && __BUILD_ID__ ? __BUILD_ID__ : DEV_BUILD_ID;

/** True when this page can auto-update at all (a production build). */
export const AUTO_UPDATE_ENABLED = CURRENT_BUILD_ID !== DEV_BUILD_ID && !import.meta.env.DEV;

/** The published build id, or null when unknown (server down mid-redeploy, file missing, not JSON). Never throws. */
export async function fetchPublishedBuildId(timeoutMs = 5000): Promise<string | null> {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store", signal: ctrl?.signal });
    if (!res.ok) return null;
    return parseVersion(await res.json());
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let knownNewBuild: string | null = null;
const listeners = new Set<(id: string) => void>();

/** Record a newer published build (autoUpdate.ts listens). */
export function noteNewBuild(id: string): void {
  if (!isNewBuild(CURRENT_BUILD_ID, id) || knownNewBuild === id) return;
  knownNewBuild = id;
  listeners.forEach((l) => l(id));
}

export function onNewBuild(l: (id: string) => void): () => void {
  listeners.add(l);
  if (knownNewBuild) l(knownNewBuild);
  return () => listeners.delete(l);
}

/** Check now whether a newer build is published; resolves true if one is (and tells autoUpdate). */
export async function checkForNewBuild(): Promise<boolean> {
  if (!AUTO_UPDATE_ENABLED) return false;
  const id = await fetchPublishedBuildId();
  if (id && isNewBuild(CURRENT_BUILD_ID, id)) {
    noteNewBuild(id);
    return true;
  }
  return knownNewBuild != null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A request failed because the server went away mid-request (ConnectionLostError). Say whether that was an app
 * update (a newer build is published) or just a lost connection. Both are worth resending.
 */
export async function explainInterruption(): Promise<{ text: string; updated: boolean }> {
  for (let i = 0; i < 2; i++) {
    if (await checkForNewBuild()) return { text: UPDATED_MID_REQUEST, updated: true };
    if (!AUTO_UPDATE_ENABLED) break;
    // The API restarts after release/ is replaced, so the new version.json is normally already there; give a
    // slow copy one more moment.
    await sleep(1500);
  }
  return { text: CONNECTION_LOST_MID_REQUEST, updated: false };
}
