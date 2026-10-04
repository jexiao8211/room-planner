// Filters people type into a product search in plain words ("hanging lamp ... under $200").
// Used by the server (so the API honors them) and by the UI (to show what was applied).
import type { Mount } from "../shared/types";

/** Where the user asked for the item to go ("a hanging lamp in the corner"). */
export type PlacementHint = "corner";

export interface InferredFilters {
  maxPrice?: number;
  mount?: Mount;
  placement?: PlacementHint;
}

const PRICE = /\b(?:under|below|less\s+than|max(?:imum)?|at\s+most|up\s+to|no\s+more\s+than|<=?)\s*(?:usd\s*)?\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k\b)?/i;
const CEILING = /\b(hanging|pendants?|ceiling|chandeliers?|suspended|flush[\s-]?mount)\b/i;
const WALL = /\b(sconces?|wall[\s-](?:mounted|art|shelf|shelves|mirror|lamp|light|clock|hanging|decor))\b/i;
const CORNER = /\bcorners?\b/i;

/** Max price, mount and placement implied by the wording of a query; fields are absent when nothing is implied. */
export function inferSearchFilters(query: string): InferredFilters {
  const out: InferredFilters = {};
  const price = PRICE.exec(query);
  if (price) {
    const n = Number(price[1].replace(/,/g, "")) * (price[2] ? 1000 : 1);
    if (Number.isFinite(n) && n > 0) out.maxPrice = n;
  }
  // Wall phrases are specific compounds ("wall hanging", "wall art"), so they are checked before the looser
  // ceiling words ("hanging", "pendant").
  if (WALL.test(query)) out.mount = "wall";
  else if (CEILING.test(query)) out.mount = "ceiling";
  if (CORNER.test(query)) out.placement = "corner";
  return out;
}

/** Fill in maxPrice / mount from the query text where the request leaves them unset. */
export function withInferredFilters<T extends { query: string; maxPrice?: number; mount?: Mount }>(req: T): T {
  const inferred = inferSearchFilters(req.query);
  return {
    ...req,
    maxPrice: req.maxPrice ?? inferred.maxPrice,
    mount: req.mount ?? inferred.mount,
  };
}
