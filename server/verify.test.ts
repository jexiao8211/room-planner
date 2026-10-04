import { describe, expect, it } from "vitest";
import type { ProductCandidate } from "../src/shared/types";
import { imageFromHtml, verifyCandidates } from "./verify";

const cand = (url: string, imageUrl?: string): ProductCandidate => ({
  id: url,
  name: url,
  retailer: "r",
  url,
  dims: { w: 1, h: 1, d: 1 },
  dimsSource: "estimated",
  colors: [],
  style: [],
  materials: [],
  mount: "floor",
  parts: [{ kind: "box", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } }],
  ...(imageUrl ? { imageUrl } : {}),
});

const html = (head: string) =>
  new Response(`<!doctype html><html><head>${head}</head><body></body></html>`, { status: 200, headers: { "content-type": "text/html" } });

describe("imageFromHtml", () => {
  it("prefers og:image, resolves relative URLs, decodes &amp; and accepts either attribute order", () => {
    expect(imageFromHtml(`<meta content="/a.jpg?x=1&amp;y=2" property="og:image">`, "https://s.example/p/1")).toBe("https://s.example/a.jpg?x=1&y=2");
    expect(imageFromHtml(`<meta name="twitter:image" content="https://cdn.example/t.png"><meta property="og:image" content="https://cdn.example/o.png">`, "https://s.example/")).toBe(
      "https://cdn.example/o.png",
    );
    expect(imageFromHtml(`<meta name="twitter:image" content="https://cdn.example/t.png">`, "https://s.example/")).toBe("https://cdn.example/t.png");
    expect(imageFromHtml(`<meta property="og:image" content="javascript:alert(1)">`, "https://s.example/")).toBeUndefined();
    expect(imageFromHtml("<title>none</title>", "https://s.example/")).toBeUndefined();
  });
});

describe("verifyCandidates", () => {
  it("drops 404/410 pages, keeps blocked/erroring ones, fills missing images and never overwrites one", async () => {
    const f = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/404")) return new Response("", { status: 404 });
      if (url.endsWith("/410")) return new Response("", { status: 410 });
      if (url.endsWith("/403")) return new Response("", { status: 403 });
      if (url.endsWith("/down")) throw new TypeError("fetch failed");
      return html(`<meta property="og:image" content="https://cdn.example${new URL(url).pathname}.jpg">`);
    }) as typeof fetch;
    const res = await verifyCandidates(
      [cand("https://s.example/ok"), cand("https://s.example/404"), cand("https://s.example/403"), cand("https://s.example/410"), cand("https://s.example/down"), cand("https://s.example/has", "https://img.example/mine.jpg")],
      { fetch: f },
    );
    expect(res.dropped).toBe(2);
    expect(res.candidates.map((c) => c.url)).toEqual(["https://s.example/ok", "https://s.example/403", "https://s.example/down", "https://s.example/has"]);
    expect(res.candidates[0].imageUrl).toBe("https://cdn.example/ok.jpg");
    expect(res.candidates[1].imageUrl).toBeUndefined();
    expect(res.candidates[3].imageUrl).toBe("https://img.example/mine.jpg");
  });

  it("gives up on slow pages after the timeout and keeps them", async () => {
    const slow = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")));
      })) as typeof fetch;
    const started = Date.now();
    const res = await verifyCandidates([cand("https://s.example/slow")], { fetch: slow, timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.candidates).toHaveLength(1);
  });
});
