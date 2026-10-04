// Live-mode check of product candidates against their own pages: drop links that are gone (404/410) and fill
// in a missing image from the page's og:image / twitter:image. Search snippets rarely carry image URLs, and a
// made-up URL on a real retailer's domain passes the "host appeared in the results" check.
import type { ProductCandidate } from "../src/shared/types";
import { cleanUrl } from "./sanitize";

export interface VerifyOptions {
  fetch?: typeof fetch;
  /** Per-page timeout, ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
/** Only the start of a page is read: meta tags live in <head>. */
const MAX_HTML_BYTES = 400_000;

/** og:image / twitter:image from an HTML document, resolved against the page URL. */
export function imageFromHtml(html: string, pageUrl: string): string | undefined {
  const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
  const want = ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"];
  const found = new Map<string, string>();
  for (const tag of metas) {
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (key && content && want.includes(key) && !found.has(key)) found.set(key, content.replace(/&amp;/g, "&").trim());
  }
  for (const key of want) {
    const raw = found.get(key);
    if (!raw) continue;
    try {
      const url = cleanUrl(new URL(raw, pageUrl).toString());
      if (url) return url;
    } catch {
      // unparsable: try the next tag
    }
  }
  return undefined;
}

async function readHead(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

type Check = { status: "gone" } | { status: "ok"; imageUrl?: string } | { status: "unknown" };

async function checkPage(url: string, opts: Required<Pick<VerifyOptions, "fetch" | "timeoutMs">> & { signal?: AbortSignal }): Promise<Check> {
  const signals = [AbortSignal.timeout(opts.timeoutMs)];
  if (opts.signal) signals.push(opts.signal);
  try {
    const res = await opts.fetch(url, {
      redirect: "follow",
      signal: AbortSignal.any(signals),
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" },
    });
    // Only a definite "not found" drops a result: many shops answer bots with 403/429/503 even for live pages.
    if (res.status === 404 || res.status === 410) {
      void res.body?.cancel().catch(() => undefined);
      return { status: "gone" };
    }
    if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) {
      void res.body?.cancel().catch(() => undefined);
      return { status: "unknown" };
    }
    return { status: "ok", imageUrl: imageFromHtml(await readHead(res), res.url || url) };
  } catch {
    return { status: "unknown" }; // timeout / network error: can't tell, keep the result
  }
}

/** Check every candidate's page in parallel. Returns the survivors (same order) and how many were dropped. */
export async function verifyCandidates(
  candidates: ProductCandidate[],
  opts: VerifyOptions = {},
): Promise<{ candidates: ProductCandidate[]; dropped: number }> {
  const f = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const checks = await Promise.all(candidates.map((c) => checkPage(c.url, { fetch: f, timeoutMs, signal: opts.signal })));
  const out: ProductCandidate[] = [];
  candidates.forEach((c, i) => {
    const check = checks[i];
    if (check.status === "gone") return;
    if (check.status === "ok" && check.imageUrl && !c.imageUrl) out.push({ ...c, imageUrl: check.imageUrl });
    else out.push(c);
  });
  return { candidates: out, dropped: candidates.length - out.length };
}
