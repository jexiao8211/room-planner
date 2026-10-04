// Pure decision logic for auto-update (src/ui/autoUpdate.ts): is a published build newer than this page, and is
// it safe to reload right now? No imports, so it unit-tests without a browser.

/** Build id of a page served by the dev server / tests: never reloads. */
export const DEV_BUILD_ID = "dev";

/** The buildId in a /version.json body, or null when the body isn't one (404 page, HTML fallback, garbage). */
export function parseVersion(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const id = (body as { buildId?: unknown }).buildId;
  return typeof id === "string" && id.trim() && id.length <= 200 ? id.trim() : null;
}

/** True when `published` is a real build id different from the one this page runs. Dev pages never update. */
export function isNewBuild(current: string, published: string | null): boolean {
  if (!current || current === DEV_BUILD_ID) return false;
  return published != null && published !== current;
}

/** Everything that decides whether a reload would lose work, read from the stores, the scene and the DOM. */
export interface ActivitySnapshot {
  /** A chat turn is waiting for its reply. */
  chatPending: boolean;
  /** A product search (Find tab or chat) is running. */
  searchRunning: boolean;
  /** A room build from photos is running. */
  buildRunning: boolean;
  /** Photos are attached but not built yet (a chat "Replace room?" question, or photos picked in the Room tab). */
  photosWaiting: boolean;
  /** A product preview ghost is showing (not persisted). */
  previewing: boolean;
  /** An item drag or an orbit is in progress in the 3D view. */
  dragging: boolean;
  /** Text in the chat composer (persisted on every keystroke, so it survives a reload). */
  chatDraft: string;
  /** (Optional) ms since the last key press: a draft only blocks while it is being written (focused + recent keys). */
  msSinceKey?: number;
  /** (Optional) A mouse button / finger is held down anywhere (holding an Inspector slider, a scrollbar...). */
  pointerDown?: boolean;
  /** Which text field has focus: none, the chat composer, or another field (an uncommitted edit). */
  focus: "none" | "chat" | "other";
  /** An in-page confirmation is open (Reset, Replace room, Undo anyway, ...). */
  confirmOpen: boolean;
}

export type Blocker = "request" | "photos" | "preview" | "drag" | "typing" | "editing" | "confirm";

/** Why reloading now would lose something; empty = safe. Ordered by importance (the first one is shown). */
export function reloadBlockers(s: ActivitySnapshot): Blocker[] {
  const out: Blocker[] = [];
  if (s.chatPending || s.searchRunning || s.buildRunning) out.push("request");
  if (s.photosWaiting) out.push("photos");
  if (s.dragging || s.pointerDown) out.push("drag");
  // The draft is saved on every keystroke and restored after the reload, so it only blocks while it is being written:
  // the composer has focus and a key was pressed recently. A draft left there doesn't keep the app on an old build.
  if (s.chatDraft.trim() && s.focus === "chat" && (s.msSinceKey ?? 0) < TYPING_PAUSE_MS) out.push("typing");
  // The chat composer is focused whenever the app is idle (it autofocuses), so an EMPTY focused composer is fine.
  if (s.focus === "other") out.push("editing");
  if (s.confirmOpen) out.push("confirm");
  if (s.previewing) out.push("preview");
  return out;
}

/** A draft whose last key press is older than this (and any draft without focus) no longer blocks an update. */
export const TYPING_PAUSE_MS = 30_000;

export const BLOCKER_TEXT: Record<Blocker, string> = {
  request: "a request is running",
  photos: "photos are waiting to be built",
  preview: "a product preview is showing",
  drag: "you're dragging or holding a control",
  typing: "you're typing a message",
  editing: "a field is being edited",
  confirm: "a question is open",
};

/** After the last key or pointer input, wait this long before an automatic reload (so it never lands mid-click). */
export const IDLE_BEFORE_RELOAD_MS = 3000;

export type UpdateDecision = { action: "none" } | { action: "reload" } | { action: "wait"; blockers: Blocker[]; showBar: boolean };

/**
 * What to do with a pending update. Hidden tabs reload as soon as nothing would be lost; a visible tab also
 * waits for a short idle moment (no bar for that: it is over in a few seconds).
 */
export function decideUpdate(opts: {
  updateReady: boolean;
  snapshot: ActivitySnapshot;
  hidden: boolean;
  msSinceInput: number;
}): UpdateDecision {
  if (!opts.updateReady) return { action: "none" };
  const blockers = reloadBlockers(opts.snapshot);
  if (blockers.length) return { action: "wait", blockers, showBar: true };
  if (!opts.hidden && opts.msSinceInput < IDLE_BEFORE_RELOAD_MS) return { action: "wait", blockers: [], showBar: false };
  return { action: "reload" };
}

/** Kinds of request failure that mean the server went away mid-request (a redeploy / restart), not a bad request. */
export function isConnectionLossStatus(status: number, apiErrorBody: boolean): boolean {
  // The API itself always answers errors with a JSON { error } body (its own 502s mean "Claude failed", which a
  // resend may not fix). A 5xx without one comes from the proxy in front of it: the API is down or restarting.
  return status >= 500 && !apiErrorBody;
}

export const UPDATED_MID_REQUEST = "The app was updated while this was running — please resend.";
export const CONNECTION_LOST_MID_REQUEST = "Lost the connection to the app server while this was running (it may have restarted) — please resend.";
