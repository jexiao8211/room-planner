// Post-processing shared by the live providers (API key and Claude subscription): validated model output in,
// API response out. Same conversion, sanitizing, rescaling, grounding and page checks for both.
import type {
  ProductSearchRequest,
  ProductSearchResponse,
  RoomFromPhotosRequest,
  RoomFromPhotosResponse,
} from "../src/shared/types";
import type { ProductList, RoomEstimate } from "./schemas";
import { buildRoomResponse, candidatesFromProductList, estimateToDraft, roomNotesFromEstimate } from "./convert";
import { verifyCandidates } from "./verify";

/** Room estimate → response: normalize, rescale to the known measurement, sanitize. */
export function roomResponseFromEstimate(
  est: RoomEstimate,
  req: Pick<RoomFromPhotosRequest, "knownMeasurement">,
): RoomFromPhotosResponse {
  return buildRoomResponse(estimateToDraft(est), req, {
    mock: false,
    modelEstimateMeters: est.knownMeasurementEstimateMeters,
    notes: roomNotesFromEstimate(est),
  });
}

export interface ProductPostOptions {
  /** Skip fetching candidate product pages (tests). */
  verifyPages?: boolean;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Structured product list → response: sanitize, drop candidates whose host never appeared in the research,
 * apply the budget, then open each product page (drop dead links, fill missing images) and write the notes.
 */
export async function productResponseFromList(
  list: ProductList,
  req: Pick<ProductSearchRequest, "maxPrice" | "mount">,
  research: { sourceUrls: string[]; searchErrors: string[] },
  opts: ProductPostOptions = {},
): Promise<ProductSearchResponse> {
  const listed = candidatesFromProductList(list, req, research.sourceUrls);
  const checked =
    opts.verifyPages === false
      ? { candidates: listed.candidates, dropped: 0 }
      : await verifyCandidates(listed.candidates, { fetch: opts.fetch, signal: opts.signal });
  const candidates = checked.candidates;
  const notes = [list.notes.trim()];
  if (listed.dropped) notes.push(`${listed.dropped} result(s) were dropped (missing link, duplicate, unverified source, non-USD price with a budget, or over budget).`);
  if (checked.dropped) notes.push(`${checked.dropped} result(s) were dropped because their product page no longer exists.`);
  if (research.searchErrors.length) notes.push(`Some web searches failed (${[...new Set(research.searchErrors)].join(", ")}).`);
  if (!candidates.length) notes.push("No products made it through; try a broader description.");
  const out: ProductSearchResponse = { candidates, mock: false };
  const text = notes.filter(Boolean).join(" ");
  if (text) out.notes = text;
  return out;
}
