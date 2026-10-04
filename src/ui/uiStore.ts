// Small UI-only store: things that should survive switching sidebar tabs but are not part of the plan
// (photos being uploaded, the in-flight room build, the last product search and its results).
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { Mount, PlacedItem, ProductCandidate } from "../shared/types";
import { usePlanner } from "../state/store";
import { setCameraPreset } from "../scene";
import { describePlacement } from "../lib/geometry";
import { inferSearchFilters, type PlacementHint } from "../lib/queryFilters";
import { normalizeProduct } from "../state/validate";
import { useVersions } from "../state/versions";
import { downscaleImage, isAbort, isConnectionLost, roomFromPhotos, searchProducts } from "./api";
import { explainInterruption } from "./updateCheck";

export type SidebarTab = "chat" | "room" | "add" | "find";
/** What a known length refers to when the "What" box is left empty (it is also the box's placeholder). */
export const DEFAULT_KNOWN_LABEL = "ceiling height";
/** Suggestions for the "What" box (anything else can be typed too). */
export const KNOWN_LABEL_PRESETS = ["ceiling height", "door height", "door width", "bed length", "room width"];
export const MAX_PHOTOS = 3;

export interface Photo {
  id: string;
  file: File;
  url: string; // object URL for the thumbnail
}

interface Job {
  status: "idle" | "running" | "done" | "error" | "cancelled";
  startedAt: number | null;
  error: string | null;
  controller: AbortController | null;
  /** It failed because the app was updated / the server restarted mid-request: offer "Resend". */
  resend?: boolean;
}

const idleJob: Job = { status: "idle", startedAt: null, error: null, controller: null };

/** Filters read from the wording of a query. */
export interface InferredForm {
  maxPrice?: number;
  mount?: Mount;
  placement?: PlacementHint;
}

/** How many product → query entries are remembered for "Find alternatives". */
const MAX_PRODUCT_QUERIES = 120;

export interface SearchForm {
  query: string;
  mount: Mount | "any";
  style: string;
  maxPrice: string;
}

interface UIState {
  tab: SidebarTab;
  setTab: (tab: SidebarTab) => void;

  // --- room from photos ---
  photos: Photo[];
  knownLabel: string;
  knownLength: string;
  photoNotes: string;
  build: Job;
  buildNotes: string | null;
  buildMock: boolean;
  addPhotos: (files: File[]) => string | null;
  removePhoto: (id: string) => void;
  setRoomForm: (patch: Partial<Pick<UIState, "knownLabel" | "knownLength" | "photoNotes">>) => void;
  startBuild: (knownMeters: number | null) => Promise<void>;
  cancelBuild: () => void;

  // --- product search ---
  form: SearchForm;
  search: Job;
  results: ProductCandidate[];
  resultsNotes: string | null;
  resultsMock: boolean;
  hasSearched: boolean;
  /** Filters read from the wording of the last searched query and filled into the form (shown as a note). */
  inferred: InferredForm | null;
  /** Query text the form was last auto-filled from, so clearing a filled field sticks for that query. */
  inferredFor: string | null;
  /** Query (and style) each product was found with, so "Find alternatives" can search for the same kind of thing. */
  productQueries: Record<string, { query: string; style: string }>;
  setForm: (patch: Partial<SearchForm>) => void;
  startSearch: () => Promise<void>;
  cancelSearch: () => void;
  /**
   * Start a product search "for" an item (e.g. a placeholder shape): prefill the form from it, make it the
   * preview target (candidates preview in its spot and can replace it) and switch to the Find tab.
   */
  findProductsFor: (item: PlacedItem) => void;

  // --- flows the chat drives (it stays on the Chat tab and reads the outcome from this store) ---
  /**
   * Run a product search with these filters (the Find tab shows the same form and results). Resolves when the
   * search ends; read `search.status`, `results`, `resultsNotes` and `resultsMock` afterwards.
   */
  runSearch: (req: ChatSearchRequest) => Promise<void>;
  /**
   * Build the room from these photos (replacing the photos picked in the Room tab). Resolves when the build ends;
   * read `build.status`, `buildNotes` and `buildMock` afterwards. Callers confirm replacing added items first.
   */
  runBuild: (files: File[], knownMeters?: number | null) => Promise<void>;
}

export interface ChatSearchRequest {
  query: string;
  mount?: Mount;
  maxPrice?: number;
  style?: string;
  /** The item the products are for (previews show in its spot; "Use here" replaces it). */
  forItemId?: string;
}

/** Same never-throwing localStorage wrapper as the planner store (absent in tests, blocked in private modes). */
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

let photoSeq = 0;

export const useUI = create<UIState>()(
  persist(
    (set, get) => ({
      tab: "chat",
      setTab: (tab) => set({ tab }),

      photos: [],
      knownLabel: "",
      knownLength: "",
      photoNotes: "",
      build: idleJob,
      buildNotes: null,
      buildMock: false,

      addPhotos: (files) => {
        const images = files.filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic)$/i.test(f.name));
        const room = MAX_PHOTOS - get().photos.length;
        const accepted = images.slice(0, Math.max(0, room));
        if (accepted.length) {
          set((s) => ({
            photos: [...s.photos, ...accepted.map((file) => ({ id: `photo_${++photoSeq}`, file, url: URL.createObjectURL(file) }))],
          }));
        }
        if (images.length < files.length) return "Only image files can be used.";
        if (accepted.length < images.length) return `Up to ${MAX_PHOTOS} photos — extra files were skipped.`;
        return null;
      },

      removePhoto: (id) =>
        set((s) => {
          const p = s.photos.find((x) => x.id === id);
          if (p) URL.revokeObjectURL(p.url);
          return { photos: s.photos.filter((x) => x.id !== id) };
        }),

      setRoomForm: (patch) => set(patch),

      startBuild: async (knownMeters) => {
        const { photos, knownLabel, photoNotes } = get();
        if (!photos.length || get().build.status === "running") return;
        const controller = new AbortController();
        set({ build: { status: "running", startedAt: Date.now(), error: null, controller }, buildNotes: null });
        try {
          const encoded = await Promise.all(photos.map((p) => downscaleImage(p.file)));
          if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
          const res = await roomFromPhotos(
            {
              photos: encoded,
              knownMeasurement:
                knownMeters != null && knownMeters > 0
                  ? { label: knownLabel.trim() || DEFAULT_KNOWN_LABEL, meters: knownMeters }
                  : undefined,
              notes: photoNotes.trim() || undefined,
            },
            controller.signal,
          );
          // Keep the design being replaced as an auto version ("Before photo build").
          useVersions.getState().autoSnapshot("photo-build");
          usePlanner.getState().replaceRoom(res.room, res.existingItems);
          setCameraPreset("iso");
          set({ build: { ...idleJob, status: "done" }, buildNotes: res.notes ?? null, buildMock: res.mock });
        } catch (e) {
          if (isAbort(e) || controller.signal.aborted) set({ build: { ...idleJob, status: "cancelled" } });
          else if (isConnectionLost(e)) set({ build: { ...idleJob, status: "error", error: (await explainInterruption()).text, resend: true } });
          else set({ build: { ...idleJob, status: "error", error: e instanceof Error ? e.message : String(e) } });
        }
      },

      cancelBuild: () => get().build.controller?.abort(),

      form: { query: "", mount: "any", style: "", maxPrice: "" },
      search: idleJob,
      results: [],
      resultsNotes: null,
      resultsMock: false,
      hasSearched: false,
      inferred: null,
      inferredFor: null,
      productQueries: {},

      setForm: (patch) => set((s) => ({ form: { ...s.form, ...patch } })),

      startSearch: async () => {
        const query = get().form.query.trim();
        if (!query || get().search.status === "running") return;

        // A budget / mount written in the query ("under $200", "hanging lamp") fills the empty form fields, once per
        // query text: if the user clears a filled field and searches again, it stays cleared.
        let form = get().form;
        const found = inferSearchFilters(query);
        // "... in the corner": previews and "Add to room" put the product in a free corner.
        usePlanner.getState().setPlacementHint(found.placement ?? null);
        if (get().inferredFor !== query) {
          const patch: Partial<SearchForm> = {};
          const inferred: InferredForm = {};
          if (found.maxPrice && !form.maxPrice.trim()) {
            patch.maxPrice = String(found.maxPrice);
            inferred.maxPrice = found.maxPrice;
          }
          if (found.mount && form.mount === "any") {
            patch.mount = found.mount;
            inferred.mount = found.mount;
          }
          if (found.placement) inferred.placement = found.placement;
          form = { ...form, ...patch };
          set({ form, inferred: Object.keys(inferred).length ? inferred : null, inferredFor: query });
        }

        const controller = new AbortController();
        set({ search: { status: "running", startedAt: Date.now(), error: null, controller } });
        const { room, items, previewTargetId } = usePlanner.getState();
        const target = items.find((it) => it.id === previewTargetId);
        const maxPrice = Number(form.maxPrice);
        // Looking for alternatives to a product already in the room: don't offer that same listing again.
        const targetProduct = target?.origin === "product" ? target.product : undefined;
        const excludeUrls = targetProduct ? [targetProduct.url] : undefined;
        try {
          const res = await searchProducts(
            {
              query,
              mount: form.mount === "any" ? undefined : form.mount,
              style: form.style.trim() || undefined,
              maxPrice: form.maxPrice.trim() && Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : undefined,
              room: { width: room.width, depth: room.depth, height: room.height },
              target: target
                ? {
                    name: target.name.slice(0, 120),
                    mount: target.mount,
                    dims: target.dims,
                    placement: describePlacement(target, room),
                    ...(targetProduct ? { isProduct: true } : {}),
                  }
                : undefined,
              excludeUrls,
              roomItems: items
                .filter((it) => !it.hidden && it.id !== target?.id)
                .slice(0, 20)
                .map((it) => ({ name: it.name.slice(0, 120), dims: it.dims, color: it.color })),
              exactFilters: true,
            },
            controller.signal,
          );
          const style = form.style.trim();
          const candidates = excludeUrls ? res.candidates.filter((c) => !excludeUrls.includes(c.url)) : res.candidates;
          const remembered = Object.entries({
            ...get().productQueries,
            ...Object.fromEntries(candidates.map((c) => [c.id, { query, style }])),
          }).slice(-MAX_PRODUCT_QUERIES);
          set({
            search: { ...idleJob, status: "done" },
            results: candidates,
            productQueries: Object.fromEntries(remembered),
            resultsNotes: res.notes ?? null,
            resultsMock: res.mock,
            hasSearched: true,
          });
        } catch (e) {
          if (isAbort(e) || controller.signal.aborted) set({ search: { ...idleJob, status: "cancelled" } });
          else if (isConnectionLost(e)) set({ search: { ...idleJob, status: "error", error: (await explainInterruption()).text, resend: true } });
          else set({ search: { ...idleJob, status: "error", error: e instanceof Error ? e.message : String(e) } });
        }
      },

      cancelSearch: () => get().search.controller?.abort(),

      findProductsFor: (item) => {
        const planner = usePlanner.getState();
        planner.setPreviewTarget(item.id);
        planner.setPreview(null);
        // A placeholder: start from its name and mount, keep the user's style and budget. A product already in the
        // room: search for the same kind of thing it was found with (not its own name, which only finds itself again)
        // in its style; the search leaves that listing out.
        const product = item.origin === "product" ? item.product : undefined;
        const found = product ? get().productQueries[product.id] : undefined;
        const query = product ? (found?.query ?? `alternatives to ${product.name}`) : item.name;
        set((s) => ({
          tab: "find",
          form: { ...s.form, query, mount: item.mount, style: product ? found?.style || product.style[0] || s.form.style : s.form.style },
          inferredFor: null,
          inferred: null,
        }));
      },

      runSearch: async (req) => {
        if (get().search.status === "running") return;
        const planner = usePlanner.getState();
        const target = req.forItemId && planner.items.some((it) => it.id === req.forItemId) ? req.forItemId : null;
        planner.setPreviewTarget(target);
        planner.setPreview(null);
        set({
          form: {
            query: req.query,
            mount: req.mount ?? "any",
            style: req.style ?? "",
            maxPrice: req.maxPrice != null && Number.isFinite(req.maxPrice) && req.maxPrice > 0 ? String(req.maxPrice) : "",
          },
          // Let the wording fill whatever the chat left open ("hanging", "in the corner").
          inferredFor: null,
          inferred: null,
        });
        await get().startSearch();
      },

      runBuild: async (files, knownMeters = null) => {
        if (get().build.status === "running") return;
        for (const p of get().photos) URL.revokeObjectURL(p.url);
        set({ photos: [] });
        get().addPhotos(files);
        await get().startBuild(knownMeters);
      },
    }),
    {
      // Search results took up to a couple of minutes to get: keep them (and the form) across reloads.
      name: "room-planner-ui-v1",
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (s) => ({
        form: s.form,
        results: s.results,
        resultsNotes: s.resultsNotes,
        resultsMock: s.resultsMock,
        hasSearched: s.hasSearched,
        inferred: s.inferred,
        inferredFor: s.inferredFor,
        productQueries: s.productQueries,
        // A search the app update cut off: still says so (with Resend) after the page reloads into the update.
        searchInterrupted: s.search.status === "error" && s.search.resend ? s.search.error : null,
      }),
      // Never trust storage: anything malformed falls back to the defaults.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<UIState> & { searchInterrupted?: unknown };
        const f = (p.form && typeof p.form === "object" ? p.form : {}) as Partial<SearchForm>;
        const mounts = ["any", "floor", "wall", "ceiling"] as const;
        const results = Array.isArray(p.results) ? p.results.map(normalizeProduct).filter((c): c is ProductCandidate => !!c) : [];
        const inferred = p.inferred && typeof p.inferred === "object" ? p.inferred : null;
        const productQueries: UIState["productQueries"] = {};
        if (p.productQueries && typeof p.productQueries === "object") {
          for (const [id, v] of Object.entries(p.productQueries)) {
            if (v && typeof v.query === "string" && typeof v.style === "string") productQueries[id] = { query: v.query, style: v.style };
          }
        }
        // The restored results keep going where the search asked for ("in the corner").
        usePlanner.getState().setPlacementHint(inferred?.placement === "corner" ? "corner" : null);
        return {
          ...current,
          form: {
            query: typeof f.query === "string" ? f.query : "",
            mount: mounts.includes(f.mount as (typeof mounts)[number]) ? (f.mount as SearchForm["mount"]) : "any",
            style: typeof f.style === "string" ? f.style : "",
            maxPrice: typeof f.maxPrice === "string" ? f.maxPrice : "",
          },
          results,
          resultsNotes: typeof p.resultsNotes === "string" ? p.resultsNotes : null,
          resultsMock: p.resultsMock === true,
          hasSearched: p.hasSearched === true,
          inferred,
          inferredFor: typeof p.inferredFor === "string" ? p.inferredFor : null,
          productQueries,
          ...(typeof p.searchInterrupted === "string" && p.searchInterrupted
            ? { search: { ...idleJob, status: "error" as const, error: p.searchInterrupted.slice(0, 300), resend: true } }
            : {}),
        };
      },
    },
  ),
);
