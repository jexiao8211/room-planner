// Automatic updates for the owner's release instance (npm start serves release/; npm run deploy:local replaces it).
//
// The page knows its own build id (baked in by vite.config.ts) and polls /version.json every 20 s and whenever the
// tab regains focus. When a different build is published it reloads itself, but only when that loses nothing:
// no chat / search / photo build running, no drag, no message being typed, no field being edited, no question
// open (see updateDecision.ts). Otherwise a slim bar says an update is waiting, with "Update now".
// Under the dev server (npm run dev) there is no version.json and the build id is "dev": nothing ever reloads.
import { create } from "zustand";
import { usePlanner } from "../state/store";
import { getCameraPose, isSceneInteracting, setInitialCameraPose, type CameraPose } from "../scene";
import { useChat } from "./chat/chatStore";
import { useChatDraft } from "./chat/chatDraft";
import { useUI, type SidebarTab } from "./uiStore";
import { AUTO_UPDATE_ENABLED, CURRENT_BUILD_ID, fetchPublishedBuildId, onNewBuild, noteNewBuild } from "./updateCheck";
import { decideUpdate, isNewBuild, type ActivitySnapshot, type Blocker } from "./updateDecision";

export const POLL_MS = 20_000;
/** While an update waits, how often to look again whether it is safe yet. */
const RECHECK_MS = 1000;
/** A new id is confirmed this long after it is first seen (a deploy replaces release/ file by file). */
const CONFIRM_DELAY_MS = 1500;
const VIEW_KEY = "room-planner-reload-view-v1";
/** The build id a reload was for (sessionStorage): guards against reloading into the same old build forever. */
const RELOAD_FOR_KEY = "room-planner-reload-for-v1";
/** How long the "Updated to the latest version" note shows after an update reload. */
const UPDATED_NOTE_MS = 4000;
/** A saved view older than this is ignored (it belongs to some earlier reload). */
const VIEW_MAX_AGE_MS = 2 * 60_000;

/** In-page questions that a reload would silently answer. Other panels can opt in with data-blocks-update. */
const CONFIRM_SELECTOR = [
  '[data-testid="reset-btn"].btn-danger',
  '[data-testid="chat-undo-confirm"]',
  '[data-testid="build-confirm"]',
  "[data-blocks-update]",
].join(",");

interface UpdateStatus {
  /** A newer build is published (and confirmed). */
  ready: boolean;
  newBuildId: string | null;
  /** Why it is waiting (empty while it only waits for a short idle moment). */
  blockers: Blocker[];
  showBar: boolean;
  /**
   * (Additive) This page already reloaded for newBuildId and still runs an older build (release/ half copied, or its
   * version.json and bundle from different builds): no more automatic reloads for that id, only the bar's button.
   */
  stuck: boolean;
  /** (Additive) The page has just reloaded into a new build (a short note says so). */
  justUpdated: boolean;
}

export const useUpdateStatus = create<UpdateStatus>()(() => ({ ready: false, newBuildId: null, blockers: [], showBar: false, stuck: false, justUpdated: false }));

let lastInputAt = 0;
let lastKeyAt = 0;
let pointerHeld = false;
let started = false;
/** A build id this page reloaded for without getting it (see UpdateStatus.stuck). */
let noAutoReloadFor: string | null = null;

function focusKind(): ActivitySnapshot["focus"] {
  const el = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
  if (!el || el === document.body) return "none";
  if (el.matches('[data-testid="chat-input"]')) return "chat";
  if (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return "other";
  if (el.tagName === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return ["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image"].includes(type) ? "none" : "other";
  }
  return "none";
}

/** What the app is doing right now, from the stores, the 3D view and the DOM. */
export function readActivity(): ActivitySnapshot {
  const ui = useUI.getState();
  const chat = useChat.getState();
  return {
    chatPending: chat.pending != null,
    searchRunning: ui.search.status === "running",
    buildRunning: ui.build.status === "running",
    photosWaiting: chat.messages.some((m) => m.build?.status === "confirm") || (ui.photos.length > 0 && ui.build.status !== "done"),
    previewing: usePlanner.getState().preview != null,
    dragging: isSceneInteracting(),
    chatDraft: useChatDraft.getState().text,
    msSinceKey: Date.now() - lastKeyAt,
    pointerDown: pointerHeld,
    focus: focusKind(),
    confirmOpen: typeof document !== "undefined" && document.querySelector(CONFIRM_SELECTOR) != null,
  };
}

interface SavedView {
  at: number;
  tab: SidebarTab;
  selectedId: string | null;
  camera: CameraPose | null;
}

/** Remember what the user was looking at, then reload into the new build. */
export function reloadNow(): void {
  try {
    const id = useUpdateStatus.getState().newBuildId;
    if (id) sessionStorage.setItem(RELOAD_FOR_KEY, JSON.stringify({ id, at: Date.now() }));
    const view: SavedView = {
      at: Date.now(),
      tab: useUI.getState().tab,
      selectedId: usePlanner.getState().selectedId ?? null,
      camera: getCameraPose(),
    };
    sessionStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    // storage blocked: reload anyway (the plan, chat and draft are persisted on their own)
  }
  window.location.reload();
}

const TABS: SidebarTab[] = ["chat", "room", "add", "find"];
const isVec = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

/** Call once before the first render: brings back the tab, selection and camera saved by reloadNow(). */
export function restoreViewAfterReload(): void {
  let view: Partial<SavedView> | null = null;
  try {
    const raw = sessionStorage.getItem(VIEW_KEY);
    sessionStorage.removeItem(VIEW_KEY);
    view = raw ? (JSON.parse(raw) as Partial<SavedView>) : null;
  } catch {
    view = null;
  }
  if (!view || typeof view.at !== "number" || Date.now() - view.at > VIEW_MAX_AGE_MS) return;
  if (typeof view.tab === "string" && TABS.includes(view.tab)) useUI.getState().setTab(view.tab);
  const sel = view.selectedId;
  if (typeof sel === "string" && usePlanner.getState().items.some((it) => it.id === sel && !it.hidden)) usePlanner.getState().select(sel);
  const cam = view.camera;
  if (cam && typeof cam === "object" && ["iso", "top", "eye", "custom"].includes(cam.preset) && isVec(cam.position) && isVec(cam.target)) {
    setInitialCameraPose({ preset: cam.preset, position: cam.position, target: cam.target });
  }
}

function evaluate(): void {
  const st = useUpdateStatus.getState();
  if (!st.ready) return;
  const d = decideUpdate({
    updateReady: true,
    snapshot: readActivity(),
    hidden: document.visibilityState === "hidden",
    msSinceInput: Date.now() - lastInputAt,
  });
  if (d.action === "reload") {
    if (st.newBuildId && st.newBuildId === noAutoReloadFor) {
      // Reloaded for this build once already and still not on it: don't loop, let the owner decide.
      if (!st.showBar || !st.stuck) useUpdateStatus.setState({ showBar: true, stuck: true, blockers: [] });
      return;
    }
    reloadNow();
    return;
  }
  if (d.action === "wait") {
    const same = st.showBar === d.showBar && st.blockers.join() === d.blockers.join();
    if (!same) useUpdateStatus.setState({ blockers: d.blockers, showBar: d.showBar });
  }
}

let confirming = false;
/** A new id was seen: look again a moment later (and make sure the new page itself is served) before trusting it. */
async function confirmNewBuild(id: string): Promise<void> {
  if (confirming || useUpdateStatus.getState().newBuildId === id) return;
  confirming = true;
  try {
    await new Promise((r) => setTimeout(r, CONFIRM_DELAY_MS));
    const again = await fetchPublishedBuildId();
    if (again !== id) return; // still being replaced, or replaced again: the next poll picks it up
    const page = await fetch(`/?t=${Date.now()}`, { cache: "no-store" }).catch(() => null);
    if (!page?.ok || !(await page.text().catch(() => "")).includes("<script")) return;
    useUpdateStatus.setState({ ready: true, newBuildId: id });
    evaluate();
  } finally {
    confirming = false;
  }
}

async function poll(): Promise<void> {
  const id = await fetchPublishedBuildId();
  if (!id || !isNewBuild(CURRENT_BUILD_ID, id)) return;
  noteNewBuild(id); // tells listeners the first time this id shows up
  void confirmNewBuild(id); // and retries the confirmation if an earlier one fell inside a deploy
}

/**
 * After a reload for a new build: did this page get it? Yes = show the short "Updated" note; no = remember the id so
 * the page doesn't reload for it again (a release whose version.json and bundle don't match would loop forever).
 */
export function checkReloadOutcome(currentId: string = CURRENT_BUILD_ID): void {
  let saved: { id?: unknown; at?: unknown } | null = null;
  try {
    const raw = sessionStorage.getItem(RELOAD_FOR_KEY);
    sessionStorage.removeItem(RELOAD_FOR_KEY);
    saved = raw ? (JSON.parse(raw) as { id?: unknown; at?: unknown }) : null;
  } catch {
    saved = null;
  }
  if (!saved || typeof saved.id !== "string" || typeof saved.at !== "number" || Date.now() - saved.at > VIEW_MAX_AGE_MS) return;
  if (saved.id === currentId) {
    useUpdateStatus.setState({ justUpdated: true });
    setTimeout(() => useUpdateStatus.setState({ justUpdated: false }), UPDATED_NOTE_MS);
  } else noAutoReloadFor = saved.id;
}

/** Start polling (production builds only). Safe to call more than once. */
export function startAutoUpdate(): void {
  if (started || !AUTO_UPDATE_ENABLED || typeof window === "undefined") return;
  started = true;
  checkReloadOutcome();
  const markInput = () => {
    lastInputAt = Date.now();
  };
  for (const ev of ["pointerdown", "keydown", "wheel"] as const) window.addEventListener(ev, markInput, { capture: true, passive: true });
  window.addEventListener("keydown", () => (lastKeyAt = Date.now()), { capture: true, passive: true });
  // A held button (an Inspector slider, a scrollbar, a long press) counts as busy until it is released.
  window.addEventListener("pointerdown", () => (pointerHeld = true), { capture: true, passive: true });
  for (const ev of ["pointerup", "pointercancel", "blur"] as const) window.addEventListener(ev, () => (pointerHeld = false), { capture: true, passive: true });
  window.addEventListener("pointermove", (e) => {
    if (e.buttons) {
      pointerHeld = true;
      lastInputAt = Date.now();
    }
  }, { capture: true, passive: true });
  onNewBuild((id) => void confirmNewBuild(id));
  window.setInterval(() => void poll(), POLL_MS);
  window.setInterval(evaluate, RECHECK_MS);
  const onWake = () => {
    if (document.visibilityState === "visible") void poll();
    evaluate();
  };
  window.addEventListener("focus", onWake);
  document.addEventListener("visibilitychange", onWake);
  void poll();
}
