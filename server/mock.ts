// Demo-mode provider: deterministic fixtures, artificial latency, same sanitize path as live mode.
import type {
  ChatRequest,
  ChatResponse,
  ProductCandidate,
  ProductSearchRequest,
  ProductSearchResponse,
  RoomFromPhotosRequest,
  RoomFromPhotosResponse,
} from "../src/shared/types";
import type { AiProvider } from "./provider";
import { buildRoomResponse } from "./convert";
import { IdGen, type DraftRoomEstimate, sanitizeCandidate } from "./sanitize";
import { MOCK_ROOM_NOTES, mockRoomDraft } from "./fixtures/mockRoom";
import { CATALOG, type CatalogEntry } from "./fixtures/catalog";
import { mockChatReply } from "./mockChat";
import { chatResponseFrom } from "./sanitizeChat";

export interface MockOptions {
  /** Artificial latency, ms. Defaults: 800 (room) / 1000 (search). Tests pass 0. */
  roomDelayMs?: number;
  searchDelayMs?: number;
  /** Artificial latency for a chat reply, ms. Default 300. Tests pass 0. */
  chatDelayMs?: number;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

/**
 * What a model would have "estimated" the user's known object to be, read off the fixture.
 * Matches room dimensions ("room width", "wall length") and item names ("bed width").
 */
export function mockEstimateFor(label: string, draft: DraftRoomEstimate): number | null {
  const l = label.toLowerCase();
  const axis = /wid(th|e)|across/.test(l) ? "w" : /depth|deep|long|length/.test(l) ? "d" : /height|tall|high/.test(l) ? "h" : null;
  const item = draft.items.find((it) =>
    (it.name ?? "")
      .toLowerCase()
      .split(/\s+/)
      .some((w) => w.length > 2 && l.includes(w)),
  );
  if (item?.dims) {
    if (axis) return item.dims[axis];
    return Math.max(item.dims.w, item.dims.d, item.dims.h);
  }
  if (/room|wall|floor/.test(l)) {
    if (axis === "w") return draft.room.width;
    if (axis === "d") return draft.room.depth;
  }
  return null;
}

// ---------- product scoring ----------

const STOP = new Set(
  "a an the for and or with in on of to my me i we our some that this under below less than over up about like want need looking find good nice my room bedroom style styled ish".split(
    " ",
  ),
);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/mid[\s-]*century(\s+modern)?/g, "midcentury mcm")
    .replace(/\$?\d+(\.\d+)?/g, " ")
    .split(/[^a-z]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

const CEILING_WORDS = ["hanging", "pendant", "ceiling", "chandelier", "suspended"];
const WALL_WORDS = ["wall", "sconce", "mounted", "floating", "hang on"];

/** Keyword score of one catalog entry. Category/synonym hits count most, then style, then the rest. */
export function scoreEntry(entry: CatalogEntry, req: Pick<ProductSearchRequest, "query" | "style" | "mount">): number {
  const q = tokens(req.query);
  const style = tokens(req.style ?? "");
  const kw = new Set(entry.keywords.flatMap(tokens));
  const styleSet = new Set(entry.style.flatMap(tokens));
  const rest = new Set(tokens([entry.name, entry.summary ?? "", entry.materials.join(" "), entry.origin ?? ""].join(" ")));
  let score = 0;
  for (const t of q) {
    if (kw.has(t)) score += 4;
    else if (styleSet.has(t)) score += 3;
    else if (rest.has(t)) score += 1;
  }
  for (const t of style) {
    if (styleSet.has(t)) score += 3;
    else if (kw.has(t) || rest.has(t)) score += 1;
  }
  // Implied mount from wording, when no explicit mount filter is set.
  if (!req.mount) {
    const ql = req.query.toLowerCase();
    if (CEILING_WORDS.some((w) => ql.includes(w)) && entry.mount === "ceiling") score += 2;
    if (WALL_WORDS.some((w) => ql.includes(w)) && entry.mount === "wall") score += 2;
  }
  return score;
}

export function searchCatalog(req: ProductSearchRequest, catalog: CatalogEntry[] = CATALOG): CatalogEntry[] {
  const excluded = new Set(req.excludeUrls ?? []);
  const eligible = catalog.filter(
    (e) =>
      (!req.mount || e.mount === req.mount) &&
      (req.maxPrice === undefined || (e.price ?? 0) <= req.maxPrice) &&
      !excluded.has(mockUrl(e)),
  );
  const scored = eligible
    .map((e, i) => ({ e, i, s: scoreEntry(e, req) }))
    .sort((a, b) => b.s - a.s || a.i - b.i);
  const hits = scored.filter((x) => x.s > 0);
  const picked = hits.slice(0, 6).map((x) => x.e);
  if (picked.length < 4 && hits.length) {
    // Pad with same-mount neighbours of the best hit so the results grid isn't sparse.
    const mount = hits[0].e.mount;
    for (const x of scored) {
      if (picked.length >= 4) break;
      if (!picked.includes(x.e) && x.e.mount === mount) picked.push(x.e);
    }
  }
  return picked;
}

function entryToCandidate(e: CatalogEntry): Partial<ProductCandidate> {
  const c: Partial<CatalogEntry> = { ...e };
  delete c.slug;
  delete c.keywords;
  return { ...c, id: `mock_${e.slug.replace(/-/g, "_")}`, url: mockUrl(e) };
}

function mockUrl(e: CatalogEntry): string {
  return `https://example.com/mock/products/${e.slug}`;
}

export function createMockProvider(opts: MockOptions = {}): AiProvider {
  const roomDelay = opts.roomDelayMs ?? 800;
  const searchDelay = opts.searchDelayMs ?? 1000;
  const chatDelay = opts.chatDelayMs ?? 300;

  async function roomFromPhotos(req: RoomFromPhotosRequest, signal?: AbortSignal): Promise<RoomFromPhotosResponse> {
    await delay(roomDelay, signal);
    const draft = mockRoomDraft();
    const estimate = req.knownMeasurement ? mockEstimateFor(req.knownMeasurement.label, draft) : null;
    return buildRoomResponse(draft, req, { mock: true, modelEstimateMeters: estimate, notes: MOCK_ROOM_NOTES });
  }

  async function searchProducts(req: ProductSearchRequest, signal?: AbortSignal): Promise<ProductSearchResponse> {
    await delay(searchDelay, signal);
    const ids = new IdGen();
    const candidates = searchCatalog(req)
      .map((e) => sanitizeCandidate(entryToCandidate(e), ids))
      .filter((c): c is ProductCandidate => c !== null);
    const notes = candidates.length
      ? "Demo data: fictional products from a built-in catalog (links go to example.com). Demo data is on because MOCK_AI or AI_PROVIDER=mock is set; remove it to search the web with your Claude subscription or an ANTHROPIC_API_KEY."
      : "Demo data: nothing in the built-in catalog matches those filters. Try a broader query, a different mount, or a higher max price.";
    return { candidates, mock: true, notes };
  }

  /** The rule-based demo parser, through the same sanitizer as a model's answer. */
  async function chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    await delay(chatDelay, signal);
    return chatResponseFrom(mockChatReply(req), req.scene, true);
  }

  return { mode: "mock", kind: "mock", roomFromPhotos, searchProducts, chat };
}
