// Pure helpers that turn model output into API responses. No network; unit-tested.
import type Anthropic from "@anthropic-ai/sdk";
import type {
  Mount,
  Opening,
  ShapeKind,
  WallSide,
  PlacedItem,
  ProductCandidate,
  ProductSearchRequest,
  RoomFromPhotosRequest,
  RoomFromPhotosResponse,
} from "../src/shared/types";
import type { ProductList, RoomEstimate } from "./schemas";
import {
  type DraftRoomEstimate,
  IdGen,
  decideScale,
  finalizeRoomEstimate,
  hostOf,
  rescaleDraft,
  sanitizeCandidate,
} from "./sanitize";

// ---------- room ----------

export function estimateToDraft(est: RoomEstimate): DraftRoomEstimate {
  return {
    room: {
      name: est.room.name,
      width: est.room.width,
      depth: est.room.depth,
      height: est.room.height,
      wallColor: est.room.wallColor,
      floorColor: est.room.floorColor,
    },
    // kind / wall / mount are free strings in the model schema; sanitize normalizes them (case, fallbacks).
    openings: est.openings.map((o) => ({ ...o, kind: o.kind as Opening["kind"], wall: o.wall as WallSide })),
    items: est.items.map(
      (it): Partial<PlacedItem> => ({
        name: it.name,
        dims: { ...it.dims },
        mount: it.mount as Mount,
        color: it.color,
        position: { ...it.position },
        rotationY: (it.rotationYDegrees * Math.PI) / 180,
        parts: it.parts.map((p) => ({
          kind: p.kind as ShapeKind,
          center: { ...p.center },
          size: { ...p.size },
          ...(p.color ? { color: p.color } : {}),
        })),
      }),
    ),
  };
}

/**
 * Apply the known-measurement scale fix to a draft, sanitize it, and build the response.
 * `modelEstimateMeters` is what the model (or mock) thinks the known object measures.
 */
export function buildRoomResponse(
  draft: DraftRoomEstimate,
  req: Pick<RoomFromPhotosRequest, "knownMeasurement">,
  opts: { mock: boolean; modelEstimateMeters?: number | null; notes?: string[] },
): RoomFromPhotosResponse {
  const decision = decideScale(req.knownMeasurement, draft, opts.modelEstimateMeters);
  const scaled = rescaleDraft(draft, decision.factor);
  const { room, existingItems } = finalizeRoomEstimate(scaled);
  const notes = [...(opts.notes ?? [])];
  if (req.knownMeasurement) {
    const km = req.knownMeasurement;
    if (decision.factor !== 1 && decision.estimate) {
      const pct = Math.round((decision.factor - 1) * 100);
      notes.push(
        `Scaled everything ${pct > 0 ? "up" : "down"} ${Math.abs(pct)}% so "${km.label}" matches ${km.meters.toFixed(2)} m (estimated ${decision.estimate.toFixed(2)} m from the ${decision.basis}).`,
      );
    } else if (decision.basis !== "none") {
      notes.push(`"${km.label}" (${km.meters.toFixed(2)} m) already matched the estimate; no rescale needed.`);
    } else {
      notes.push(`Could not tie "${km.label}" to anything in the estimate, so no extra rescale was applied.`);
    }
  }
  const out: RoomFromPhotosResponse = { room, existingItems, mock: opts.mock };
  const text = notes.filter(Boolean).join(" ").trim();
  if (text) out.notes = text;
  return out;
}

export function roomNotesFromEstimate(est: RoomEstimate): string[] {
  const confidence = est.confidence.trim().toLowerCase();
  const notes = [est.notes.trim()];
  if (["low", "medium", "high"].includes(confidence)) notes.push(`Confidence: ${confidence}.`);
  const facing = est.photos
    .filter((p) => p.facingWall)
    .map((p) => `photo ${p.photoIndex} faces ${p.facingWall!.trim().toLowerCase()}`)
    .join(", ");
  if (facing) notes.push(`Orientation: ${facing}.`);
  return notes;
}

// ---------- product research ----------

export interface ResearchResult {
  report: string;
  /** URLs from web_search results and citations, deduped, in order of appearance. */
  sourceUrls: string[];
  /** web_search error codes (HTTP 200 errors inside web_search_tool_result). */
  searchErrors: string[];
  searchCount: number;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]]+/g;

/** Collect the final text report and every URL seen across one or more (paused/resumed) responses. */
export function extractResearch(messages: Array<Pick<Anthropic.Message, "content">>): ResearchResult {
  const texts: string[] = [];
  const urls: string[] = [];
  const errors: string[] = [];
  let searchCount = 0;
  const addUrl = (u: string) => {
    const clean = u.replace(/[.,;:]+$/, "");
    if (!urls.includes(clean)) urls.push(clean);
  };
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "text") {
        texts.push(block.text);
        for (const c of block.citations ?? []) {
          if (c.type === "web_search_result_location") addUrl(c.url);
        }
        for (const m of block.text.match(URL_IN_TEXT) ?? []) addUrl(m);
      } else if (block.type === "web_search_tool_result") {
        searchCount += 1;
        const content = block.content;
        if (Array.isArray(content)) {
          for (const r of content) addUrl(r.url);
        } else {
          errors.push(content.error_code);
        }
      }
    }
  }
  return { report: texts.join("").trim(), sourceUrls: urls, searchErrors: errors, searchCount };
}

/**
 * Sanitize structured candidates. Drops ones without a valid URL, duplicates, ones over budget,
 * and (when we have sources) ones whose host never appeared in the research — likely invented.
 */
export function candidatesFromProductList(
  list: ProductList,
  req: Pick<ProductSearchRequest, "maxPrice" | "mount">,
  sourceUrls: string[],
): { candidates: ProductCandidate[]; dropped: number } {
  const ids = new IdGen();
  const seenHosts = new Set(sourceUrls.map(hostOf).filter(Boolean));
  const out: ProductCandidate[] = [];
  let dropped = 0;
  const all: ProductCandidate[] = [];
  for (const raw of list.candidates) {
    const c = sanitizeCandidate(
      {
        ...raw,
        price: raw.price ?? undefined,
        currency: raw.currency ?? undefined,
        imageUrl: raw.imageUrl ?? undefined,
        dimsText: raw.dimsText ?? undefined,
        origin: raw.origin ?? undefined,
        summary: raw.summary ?? undefined,
        dimsSource: raw.dimsSource as ProductCandidate["dimsSource"],
        mount: raw.mount as Mount,
        parts: raw.parts.map((p) => ({ ...p, kind: p.kind as ShapeKind, color: p.color ?? undefined })),
      },
      ids,
    );
    if (!c) {
      dropped++;
      continue;
    }
    if (all.some((o) => o.url === c.url)) {
      dropped++;
      continue;
    }
    all.push(c);
  }
  const grounded = seenHosts.size ? all.filter((c) => seenHosts.has(hostOf(c.url))) : all;
  // If grounding would wipe everything (e.g. citations missing), keep the sanitized list.
  const pool = grounded.length ? grounded : all;
  dropped += all.length - pool.length;
  for (const c of pool) {
    // The budget is in USD: a price in another currency can't be compared, so it doesn't pass the filter.
    if (req.maxPrice !== undefined && c.price !== undefined && (c.price > req.maxPrice || (c.currency ?? "USD") !== "USD")) {
      dropped++;
      continue;
    }
    out.push(c);
  }
  return { candidates: out.slice(0, 6), dropped };
}
