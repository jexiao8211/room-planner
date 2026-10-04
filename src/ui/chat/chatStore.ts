// Chat state: the conversation (last ~50 messages persisted), the in-flight request, and the flows a reply can
// start (product search, room build from photos), which run through the UI store so the other tabs stay in sync.
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { HealthResponse, Mount, ProductCandidate } from "../../shared/types";
import { usePlanner } from "../../state/store";
import { normalizeProduct } from "../../state/validate";
import { versionsApi } from "../../state/versions";
import { setCameraPreset } from "../../scene";
import { getHealth, isAbort, isConnectionLost, isPermanentRequestError, sendChat } from "../api";
import { explainInterruption } from "../updateCheck";
import { MAX_PHOTOS, useUI } from "../uiStore";
import { buildChatScene, buildHistory } from "./buildScene";
import { executeActions, type ActionResult, type SearchAction, type TurnStep } from "./executeActions";

/** Who answered: the demo parser, or Claude through an API key / the Claude subscription. */
export type ChatVia = "mock" | "api" | "subscription" | "live";

export type JobState = "running" | "done" | "error" | "cancelled";

export interface ChatSearchInfo {
  query: string;
  status: JobState;
  startedAt: number;
  forItemName?: string;
  candidates?: ProductCandidate[];
  notes?: string | null;
  mock?: boolean;
  error?: string;
  /** The search as asked (filters included), so "Resend" can run it again. */
  request?: { query: string; mount?: Mount; maxPrice?: number; style?: string; forItemId?: string };
  /** It failed because the app was updated / the server restarted mid-request: offer "Resend". */
  resend?: boolean;
}

export interface ChatBuildInfo {
  /** confirm = waiting for "Replace room?"; kept = the user kept the current room. */
  status: JobState | "confirm" | "kept";
  photos: number;
  /** Added items the build would replace (shown in the confirmation). */
  replaceCount?: number;
  startedAt?: number;
  error?: string;
  notes?: string | null;
  mock?: boolean;
  room?: { name: string; width: number; depth: number; height: number; items: number };
  /** It failed because the app was updated / the server restarted mid-request: offer "Resend" (photos kept). */
  resend?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** text = a normal turn; photos = the user attached photos; search / build = a running or finished flow. */
  kind: "text" | "photos" | "search" | "build" | "error" | "note";
  text: string;
  at: number;
  /** What the reply did, one chip each. */
  results?: ActionResult[];
  via?: ChatVia;
  photos?: number;
  /** Object URLs of attached photos (this session only). */
  thumbs?: string[];
  /** The turn's undo step (this session only: the undo history isn't persisted either). */
  step?: TurnStep;
  search?: ChatSearchInfo;
  build?: ChatBuildInfo;
  /** For errors: the message to send again with "Retry". */
  retryText?: string;
  /** The request died because the app was updated / the server restarted: the button says "Resend". */
  interrupted?: boolean;
}

interface Pending {
  startedAt: number;
  controller: AbortController;
}

interface ChatState {
  messages: ChatMessage[];
  pending: Pending | null;
  provider: HealthResponse["provider"] | null;
  /** Send a message; applies the reply's actions as one undo step and starts any search it asks for. */
  send: (text: string) => Promise<void>;
  /** Stop waiting for the current reply. */
  cancel: () => void;
  /** Attach 1–3 room photos: builds the room from them (asking first if that would replace added items). */
  attachPhotos: (files: File[]) => string | null;
  /** Answer the in-chat "Replace room?" question of a build message. */
  confirmBuild: (messageId: string, replace: boolean) => void;
  /** Run a search again that failed because the app was updated mid-request (same message, same filters). */
  resendSearch: (messageId: string) => void;
  /** Run a room build again that failed because the app was updated mid-request (same photos). */
  resendBuild: (messageId: string) => void;
  clear: () => void;
  loadProvider: () => void;
}

// Declared before the store: persist hydrates synchronously while the store is created, and restoreMessage uses these.
const KINDS: ChatMessage["kind"][] = ["text", "photos", "search", "build", "error", "note"];
const JOB_STATES = ["running", "done", "error", "cancelled", "confirm", "kept"];

export const MAX_MESSAGES = 50;
const PERSIST_KEY = "room-planner-chat-v1";

/** Photos waiting for a "Replace room?" answer, by build message id. */
const pendingFiles = new Map<string, File[]>();

let seq = 0;
const newMsgId = () => `msg_${Date.now().toString(36)}_${(++seq).toString(36)}`;

const safeLocalStorage: StateStorage = {
  getItem: (name) => {
    try {
      return globalThis.localStorage?.getItem(name) ?? null;
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      globalThis.localStorage?.setItem(name, value);
    } catch {
      // quota exceeded / storage blocked
    }
  },
  removeItem: (name) => {
    try {
      globalThis.localStorage?.removeItem(name);
    } catch {
      // ignore
    }
  },
};

function revoke(m: ChatMessage) {
  for (const url of m.thumbs ?? []) URL.revokeObjectURL(url);
}

export const useChat = create<ChatState>()(
  persist(
    (set, get) => {
      const push = (m: Omit<ChatMessage, "id" | "at">): string => {
        const id = newMsgId();
        set((s) => {
          const messages = [...s.messages, { ...m, id, at: Date.now() }];
          // Keep the in-memory list bounded too (old object URLs released).
          const drop = messages.length - MAX_MESSAGES * 2;
          if (drop > 0) messages.slice(0, drop).forEach(revoke);
          return { messages: drop > 0 ? messages.slice(drop) : messages };
        });
        return id;
      };
      const patch = (id: string, fn: (m: ChatMessage) => Partial<ChatMessage>) =>
        set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...fn(m) } : m)) }));

      const runSearch = async (a: Omit<SearchAction, "type">, reuseId?: string) => {
        if (useUI.getState().search.status === "running") {
          push({ role: "assistant", kind: "error", text: "A product search is already running. Wait for it to finish (or cancel it), then ask again." });
          return;
        }
        const forItem = a.forItemId ? usePlanner.getState().items.find((it) => it.id === a.forItemId) : undefined;
        const request = { query: a.query, mount: a.mount, maxPrice: a.maxPrice, style: a.style, forItemId: forItem?.id };
        const search: ChatSearchInfo = { query: a.query, status: "running", startedAt: Date.now(), forItemName: forItem?.name, request };
        // "Resend" reuses the failed bubble.
        const id = reuseId ?? push({ role: "assistant", kind: "search", text: "", search });
        if (reuseId) patch(reuseId, () => ({ search }));
        await useUI.getState().runSearch({ query: a.query, mount: a.mount, maxPrice: a.maxPrice, style: a.style, forItemId: forItem?.id });
        const ui = useUI.getState();
        const status: JobState = ui.search.status === "done" ? "done" : ui.search.status === "cancelled" ? "cancelled" : "error";
        patch(id, (m) => ({
          search: {
            ...m.search!,
            status,
            candidates: status === "done" ? ui.results : undefined,
            notes: status === "done" ? ui.resultsNotes : null,
            mock: ui.resultsMock,
            error: status === "error" ? (ui.search.error ?? "The search didn't start (another one may be running).") : undefined,
            resend: status === "error" && ui.search.resend === true ? true : undefined,
          },
        }));
      };

      const runBuild = async (id: string) => {
        const files = pendingFiles.get(id);
        if (!files?.length) {
          patch(id, (m) => ({ build: { ...m.build!, status: "error", error: "The photos are no longer available. Attach them again." } }));
          return;
        }
        if (useUI.getState().build.status === "running") {
          patch(id, (m) => ({ build: { ...m.build!, status: "error", error: "A room build is already running." } }));
          return;
        }
        patch(id, (m) => ({ build: { ...m.build!, status: "running", startedAt: Date.now() } }));
        await useUI.getState().runBuild(files);
        const ui = useUI.getState();
        const status: JobState = ui.build.status === "done" ? "done" : ui.build.status === "cancelled" ? "cancelled" : "error";
        // Interrupted by an app update: keep the photos for "Resend".
        const resend = status === "error" && ui.build.resend === true;
        if (!resend) pendingFiles.delete(id);
        const { room, items } = usePlanner.getState();
        patch(id, (m) => ({
          build: {
            ...m.build!,
            status,
            error: status === "error" ? (ui.build.error ?? "The room build failed.") : undefined,
            resend: resend || undefined,
            notes: status === "done" ? ui.buildNotes : null,
            mock: ui.buildMock,
            room:
              status === "done"
                ? { name: room.name, width: room.width, depth: room.depth, height: room.height, items: items.filter((it) => it.origin === "existing").length }
                : undefined,
          },
        }));
      };

      return {
        messages: [],
        pending: null,
        provider: null,

        send: async (raw) => {
          const text = raw.trim();
          if (!text || get().pending) return;
          const history = buildHistory(get().messages);
          push({ role: "user", kind: "text", text });
          const controller = new AbortController();
          set({ pending: { startedAt: Date.now(), controller } });
          try {
            // One snapshot of the search results for the whole turn: a search finishing while the reply is on its
            // way replaces the UI store's list, and "the second one" must mean what the model (and user) saw.
            const ui = useUI.getState();
            const results = ui.results;
            const lastQuery = results.length ? ui.productQueries[results[0].id]?.query : undefined;
            const scene = buildChatScene(usePlanner.getState(), results, lastQuery, versionsApi.list());
            const res = await sendChat({ message: text, history, scene }, controller.signal);
            if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
            const out = executeActions(Array.isArray(res.actions) ? res.actions : [], {
              planner: usePlanner,
              lastResults: results,
              camera: setCameraPreset,
              versions: versionsApi,
            });
            // Steps the server had to leave out show as muted chips with the reason.
            const skipped: ActionResult[] = (Array.isArray(res.skipped) ? res.skipped : [])
              .filter((x) => x && typeof x.reason === "string")
              .slice(0, 20)
              .map((x) => ({ type: "select", ok: false, status: "failed", label: skippedLabel(x.type), error: x.reason.slice(0, 200) }));
            const chips = [...out.results, ...skipped];
            const reply = typeof res.reply === "string" && res.reply.trim() ? res.reply.trim() : out.results.length ? "Done." : "Sorry, I didn't get that.";
            set({ pending: null });
            push({
              role: "assistant",
              kind: "text",
              text: reply,
              results: chips.length ? chips : undefined,
              step: out.step ?? undefined,
              via: res.mock ? "mock" : (get().provider ?? "live"),
            });
            for (const s of out.searches) void runSearch(s);
          } catch (e) {
            set({ pending: null });
            if (isAbort(e) || controller.signal.aborted) push({ role: "assistant", kind: "note", text: "Stopped." });
            // A rejected request (400: too long, invalid) fails the same way again: no Retry button for it.
            // The server went away mid-request (an app update restarts it): say so, with a one-click Resend. The
            // message is persisted, so the button is still there after the page reloads itself into the update.
            else if (isConnectionLost(e)) push({ role: "assistant", kind: "error", text: (await explainInterruption()).text, retryText: text, interrupted: true });
            else push({ role: "assistant", kind: "error", text: e instanceof Error ? e.message : String(e), ...(isPermanentRequestError(e) ? {} : { retryText: text }) });
          }
        },

        cancel: () => get().pending?.controller.abort(),

        attachPhotos: (files) => {
          const images = files.filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic)$/i.test(f.name));
          if (!images.length) return "Only image files can be used.";
          if (useUI.getState().build.status === "running") return "A room build is already running.";
          const used = images.slice(0, MAX_PHOTOS);
          push({
            role: "user",
            kind: "photos",
            text: "",
            photos: used.length,
            thumbs: typeof URL.createObjectURL === "function" ? used.map((f) => URL.createObjectURL(f)) : undefined,
          });
          const added = usePlanner.getState().items.filter((it) => it.origin !== "existing").length;
          const id = push({
            role: "assistant",
            kind: "build",
            text: "",
            build: { status: added ? "confirm" : "running", photos: used.length, replaceCount: added || undefined },
          });
          pendingFiles.set(id, used);
          if (!added) void runBuild(id);
          if (images.length > MAX_PHOTOS) return `Up to ${MAX_PHOTOS} photos: the extra ones were skipped.`;
          if (images.length < files.length) return "Some files weren't images and were skipped.";
          return null;
        },

        confirmBuild: (messageId, replace) => {
          const m = get().messages.find((x) => x.id === messageId);
          if (m?.build?.status !== "confirm") return;
          if (replace) void runBuild(messageId);
          else {
            pendingFiles.delete(messageId);
            patch(messageId, (x) => ({ build: { ...x.build!, status: "kept" } }));
          }
        },

        resendSearch: (messageId) => {
          const m = get().messages.find((x) => x.id === messageId);
          const r = m?.search?.request;
          if (!m?.search?.resend || !r) return;
          void runSearch(r, messageId);
        },

        resendBuild: (messageId) => {
          const m = get().messages.find((x) => x.id === messageId);
          if (!m?.build?.resend) return;
          void runBuild(messageId);
        },

        clear: () => {
          get().pending?.controller.abort();
          get().messages.forEach(revoke);
          pendingFiles.clear();
          set({ messages: [], pending: null });
        },

        loadProvider: () => {
          if (get().provider) return;
          getHealth()
            .then((h) => set({ provider: h.provider ?? (h.mode === "mock" ? "mock" : null) }))
            .catch(() => {
              // Offline: the banner says so; messages fall back to a generic note.
            });
        },
      };
    },
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (s) => ({ messages: s.messages.slice(-MAX_MESSAGES).map(forStorage) }),
      // Never trust storage; flows that were running when the page closed are reported as interrupted.
      merge: (persisted, current) => {
        const raw = (persisted as { messages?: unknown } | null)?.messages;
        const messages = Array.isArray(raw) ? raw.map(restoreMessage).filter((m): m is ChatMessage => !!m).slice(-MAX_MESSAGES) : [];
        return { ...current, messages };
      },
    },
  ),
);

const SKIPPED_LABELS: Record<string, string> = {
  addShape: "Add",
  move: "Move",
  rotate: "Rotate",
  resize: "Resize",
  recolor: "Recolor",
  rename: "Rename",
  remove: "Remove",
  duplicate: "Duplicate",
  setRoom: "Change room",
  search: "Search",
  addCandidate: "Add result",
  previewCandidate: "Preview result",
  select: "Select",
  camera: "Change view",
  setHidden: "Hide / show",
  setMount: "Change mount",
  setHeight: "Change height",
  hang: "Hang from the ceiling",
  setOpening: "Door / window",
  saveVersion: "Save version",
  restoreVersion: "Restore version",
};

/** Chip label for a step the server left out. */
function skippedLabel(type: unknown): string {
  return `Skipped: ${(typeof type === "string" && SKIPPED_LABELS[type]) || "a step"}`;
}

function forStorage(m: ChatMessage): ChatMessage {
  const out: ChatMessage = { ...m };
  delete out.step;
  delete out.thumbs;
  return out;
}


/** A stored message, checked field by field (anything malformed is dropped). */
export function restoreMessage(v: unknown): ChatMessage | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Partial<ChatMessage>;
  if (typeof m.id !== "string" || (m.role !== "user" && m.role !== "assistant") || !KINDS.includes(m.kind as ChatMessage["kind"])) return null;
  const out: ChatMessage = {
    id: m.id,
    role: m.role,
    kind: m.kind as ChatMessage["kind"],
    text: typeof m.text === "string" ? m.text : "",
    at: typeof m.at === "number" ? m.at : 0,
  };
  if (Array.isArray(m.results)) {
    out.results = m.results
      .filter((r): r is ActionResult => !!r && typeof r.label === "string" && typeof r.ok === "boolean")
      .map((r) => ({
        type: r.type,
        ok: r.ok,
        label: r.label,
        ...(r.status === "ok" || r.status === "adjusted" || r.status === "failed" ? { status: r.status } : {}),
        ...(typeof r.error === "string" ? { error: r.error } : {}),
        ...(typeof r.note === "string" ? { note: r.note } : {}),
        ...(typeof r.swatch === "string" ? { swatch: r.swatch } : {}),
      }));
  }
  if (m.via === "mock" || m.via === "api" || m.via === "subscription" || m.via === "live") out.via = m.via;
  if (typeof m.photos === "number") out.photos = m.photos;
  if (typeof m.retryText === "string") out.retryText = m.retryText;
  if (m.interrupted === true) out.interrupted = true;
  if (m.search && typeof m.search === "object" && typeof m.search.query === "string" && JOB_STATES.includes(m.search.status)) {
    const s = m.search;
    out.search = {
      query: s.query,
      status: s.status === "running" ? "cancelled" : s.status,
      startedAt: typeof s.startedAt === "number" ? s.startedAt : 0,
      forItemName: typeof s.forItemName === "string" ? s.forItemName : undefined,
      candidates: Array.isArray(s.candidates) ? s.candidates.map(normalizeProduct).filter((c): c is ProductCandidate => !!c) : undefined,
      notes: typeof s.notes === "string" ? s.notes : null,
      mock: s.mock === true,
      error: s.status === "running" ? "Interrupted by a page reload." : typeof s.error === "string" ? s.error : undefined,
    };
    const r = s.request;
    if (r && typeof r === "object" && typeof r.query === "string") {
      out.search.request = {
        query: r.query,
        ...(r.mount === "floor" || r.mount === "wall" || r.mount === "ceiling" ? { mount: r.mount } : {}),
        ...(typeof r.maxPrice === "number" && Number.isFinite(r.maxPrice) ? { maxPrice: r.maxPrice } : {}),
        ...(typeof r.style === "string" ? { style: r.style } : {}),
        ...(typeof r.forItemId === "string" ? { forItemId: r.forItemId } : {}),
      };
      // A search cut off by a reload (e.g. "Update now") or by an app update can be sent again as it was.
      if (s.status === "running" || s.resend === true) out.search.resend = true;
    }
  } else if (out.kind === "search") return null;
  if (m.build && typeof m.build === "object" && JOB_STATES.includes(m.build.status)) {
    const b = m.build;
    const interrupted = b.status === "running" || b.status === "confirm";
    out.build = {
      status: interrupted ? "cancelled" : b.status,
      photos: typeof b.photos === "number" ? b.photos : 0,
      error: interrupted ? "Interrupted by a page reload. Attach the photos again." : typeof b.error === "string" ? b.error : undefined,
      notes: typeof b.notes === "string" ? b.notes : null,
      mock: b.mock === true,
      room:
        b.room && typeof b.room === "object" && typeof b.room.name === "string" && [b.room.width, b.room.depth, b.room.height, b.room.items].every((n) => typeof n === "number")
          ? b.room
          : undefined,
    };
  } else if (out.kind === "build") return null;
  return out;
}
