import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import type {
  HealthResponse,
  ProductSearchResponse,
  RoomFromPhotosResponse,
} from "../src/shared/types";
import { createApp, type AppOptions } from "./app";
import { createMockProvider } from "./mock";
import { toUpstreamError } from "./errors";

const PHOTO = { mediaType: "image/jpeg", dataBase64: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U" };

async function start(opts: AppOptions): Promise<{ base: string; server: Server }> {
  const app = createApp(opts);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, server };
}

function post(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("API in mock mode", () => {
  let base = "";
  let server: Server;

  beforeAll(async () => {
    ({ base, server } = await start({ env: { AI_PROVIDER: "mock" }, mock: { roomDelayMs: 0, searchDelayMs: 0 } }));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("GET /api/health reports mock mode", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body).toEqual({ ok: true, mode: "mock", provider: "mock" });
  });

  it("MOCK_AI=1 forces mock even with a key", async () => {
    const s = await start({ env: { ANTHROPIC_API_KEY: "sk-test-not-real", MOCK_AI: "1" }, mock: { roomDelayMs: 0 } });
    try {
      const body = (await (await fetch(`${s.base}/api/health`)).json()) as HealthResponse;
      expect(body.mode).toBe("mock");
    } finally {
      await new Promise<void>((r) => s.server.close(() => r()));
    }
  });

  it("a key without MOCK_AI selects live mode via the API (no API call is made by /health)", async () => {
    const s = await start({ env: { ANTHROPIC_API_KEY: "sk-test-not-real" } });
    try {
      const body = (await (await fetch(`${s.base}/api/health`)).json()) as HealthResponse;
      expect(body).toEqual({ ok: true, mode: "live", provider: "api" });
    } finally {
      await new Promise<void>((r) => s.server.close(() => r()));
    }
  });

  it("no key and no MOCK_AI selects the Claude subscription (live; /health makes no SDK call)", async () => {
    const query = () => {
      throw new Error("query() must not be called by /health");
    };
    const s = await start({ env: {}, subscription: { query, log: () => {} } });
    try {
      const body = (await (await fetch(`${s.base}/api/health`)).json()) as HealthResponse;
      expect(body).toEqual({ ok: true, mode: "live", provider: "subscription" });
    } finally {
      await new Promise<void>((r) => s.server.close(() => r()));
    }
  });

  it("AI_PROVIDER=api without a key fails at startup with a clear message", () => {
    expect(() => createApp({ env: { AI_PROVIDER: "api" } })).toThrow(/AI_PROVIDER=api needs ANTHROPIC_API_KEY/);
  });

  it.each([
    ["no photos", { photos: [] }],
    ["too many photos", { photos: [PHOTO, PHOTO, PHOTO, PHOTO] }],
    ["bad media type", { photos: [{ ...PHOTO, mediaType: "image/bmp" }] }],
    ["data: prefix", { photos: [{ ...PHOTO, dataBase64: `data:image/jpeg;base64,${PHOTO.dataBase64}` }] }],
    ["negative measurement", { photos: [PHOTO], knownMeasurement: { label: "ceiling", meters: -2 } }],
    ["missing body fields", {}],
  ])("POST /api/rooms/from-photos → 400 for %s", async (_name, body) => {
    const res = await post(base, "/api/rooms/from-photos", body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(typeof json.error).toBe("string");
    expect(json.error.length).toBeGreaterThan(0);
  });

  it.each([
    ["empty query", { query: "" }],
    ["bad mount", { query: "lamp", mount: "roof" }],
    ["bad maxPrice", { query: "lamp", maxPrice: "cheap" }],
    ["negative maxPrice", { query: "lamp", maxPrice: -5 }],
  ])("POST /api/products/search → 400 for %s", async (_name, body) => {
    const res = await post(base, "/api/products/search", body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
  });

  it("malformed JSON → 400 with a JSON error", async () => {
    const res = await post(base, "/api/products/search", "{not json");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/JSON/);
  });

  it("accepts multi-MB photo bodies and rejects > 25 MB with 413", async () => {
    const big = { photos: [{ mediaType: "image/jpeg", dataBase64: "A".repeat(6 * 1024 * 1024) }] };
    expect((await post(base, "/api/rooms/from-photos", big)).status).toBe(200);
    const huge = { photos: [{ mediaType: "image/jpeg", dataBase64: "A".repeat(26 * 1024 * 1024) }] };
    const res = await post(base, "/api/rooms/from-photos", huge);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toMatch(/too large/);
  });

  it("unknown /api route → 404 JSON", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("room from photos returns a sane bedroom with existing items", async () => {
    const res = await post(base, "/api/rooms/from-photos", { photos: [PHOTO] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RoomFromPhotosResponse;
    expect(body.mock).toBe(true);
    expect(body.room.width).toBeCloseTo(3.66, 2);
    expect(body.room.depth).toBeCloseTo(3.35, 2);
    expect(body.room.height).toBeCloseTo(2.44, 2);
    expect(body.room.openings.map((o) => o.kind).sort()).toEqual(["door", "window"]);
    expect(body.existingItems.length).toBeGreaterThanOrEqual(3);
    const ids = new Set([...body.room.openings.map((o) => o.id), ...body.existingItems.map((i) => i.id)]);
    expect(ids.size).toBe(body.room.openings.length + body.existingItems.length);
    for (const it of body.existingItems) {
      expect(it.origin).toBe("existing");
      expect(it.parts.length).toBeGreaterThan(1);
      expect(it.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(Math.abs(it.position.x)).toBeLessThanOrEqual(body.room.width / 2);
      expect(Math.abs(it.position.z)).toBeLessThanOrEqual(body.room.depth / 2);
    }
    expect(body.notes).toMatch(/Demo data/);
  });

  it("knownMeasurement (ceiling height) rescales room, openings and items", async () => {
    const base0 = (await (await post(base, "/api/rooms/from-photos", { photos: [PHOTO] })).json()) as RoomFromPhotosResponse;
    const res = await post(base, "/api/rooms/from-photos", {
      photos: [PHOTO],
      knownMeasurement: { label: "ceiling height", meters: 2.74 },
    });
    const body = (await res.json()) as RoomFromPhotosResponse;
    const f = 2.74 / 2.44;
    expect(body.room.height).toBeCloseTo(2.74, 2);
    expect(body.room.width).toBeCloseTo(3.66 * f, 2);
    const door0 = base0.room.openings.find((o) => o.kind === "door")!;
    const door = body.room.openings.find((o) => o.kind === "door")!;
    expect(door.height).toBeCloseTo(door0.height * f, 2);
    const bed0 = base0.existingItems.find((i) => /bed/i.test(i.name))!;
    const bed = body.existingItems.find((i) => /bed/i.test(i.name))!;
    expect(bed.dims.d).toBeCloseTo(bed0.dims.d * f, 2);
    expect(body.notes).toMatch(/Scaled everything up 12%/);
  });

  it("knownMeasurement on an item uses the (mock) model estimate", async () => {
    const res = await post(base, "/api/rooms/from-photos", {
      photos: [PHOTO],
      knownMeasurement: { label: "bed width", meters: 1.52 },
    });
    const body = (await res.json()) as RoomFromPhotosResponse;
    const bed = body.existingItems.find((i) => /bed/i.test(i.name))!;
    expect(bed.dims.w).toBeCloseTo(1.52, 2);
    expect(body.room.width).toBeCloseTo(3.66 * (1.52 / 1.62), 2);
  });

  it("knownMeasurement within 3% leaves the estimate alone", async () => {
    const res = await post(base, "/api/rooms/from-photos", {
      photos: [PHOTO],
      knownMeasurement: { label: "door height", meters: 2.05 },
    });
    const body = (await res.json()) as RoomFromPhotosResponse;
    expect(body.room.height).toBeCloseTo(2.44, 2);
    expect(body.notes).toMatch(/no rescale needed/);
  });

  it("product search returns 4-6 traits-complete candidates for a Japanese hanging lamp", async () => {
    const res = await post(base, "/api/products/search", { query: "hanging lamp for the corner, Japanese, paper lantern" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProductSearchResponse;
    expect(body.mock).toBe(true);
    expect(body.candidates.length).toBeGreaterThanOrEqual(4);
    expect(body.candidates.length).toBeLessThanOrEqual(6);
    expect(body.candidates[0].mount).toBe("ceiling");
    expect(body.candidates[0].style).toContain("Japanese");
    for (const c of body.candidates) {
      expect(c.url).toMatch(/^https:\/\/example\.com\/mock\//);
      expect(c.imageUrl).toBeUndefined();
      expect(c.parts.length).toBeGreaterThan(0);
      expect(c.colors.length).toBeGreaterThan(0);
      expect(c.materials.length).toBeGreaterThan(0);
    }
    expect(new Set(body.candidates.map((c) => c.id)).size).toBe(body.candidates.length);
  });

  it("product search honors mount and maxPrice filters", async () => {
    const res = await post(base, "/api/products/search", { query: "lamp light", mount: "ceiling", maxPrice: 100 });
    const body = (await res.json()) as ProductSearchResponse;
    expect(body.candidates.length).toBeGreaterThan(0);
    for (const c of body.candidates) {
      expect(c.mount).toBe("ceiling");
      expect(c.price!).toBeLessThanOrEqual(100);
    }
  });

  it("product search leaves out excluded listings (alternatives to a placed product)", async () => {
    const first = (await (await post(base, "/api/products/search", { query: "hanging lamp japanese paper lantern" })).json()) as ProductSearchResponse;
    const placed = first.candidates[0];
    const body = (await (
      await post(base, "/api/products/search", {
        query: "hanging lamp japanese paper lantern",
        excludeUrls: [placed.url],
        target: { name: placed.name, mount: placed.mount, dims: placed.dims, isProduct: true },
      })
    ).json()) as ProductSearchResponse;
    expect(body.candidates.length).toBeGreaterThanOrEqual(4);
    expect(body.candidates.map((c) => c.url)).not.toContain(placed.url);
  });

  it("mid-century nightstand query returns nightstands first", async () => {
    const res = await post(base, "/api/products/search", { query: "nightstand", style: "mid-century modern" });
    const body = (await res.json()) as ProductSearchResponse;
    expect(body.candidates[0].name).toMatch(/nightstand/i);
    expect(body.candidates[0].style).toContain("mid-century modern");
  });

  it("rugs come back very thin and floor-mounted", async () => {
    const body = (await (await post(base, "/api/products/search", { query: "wool area rug" })).json()) as ProductSearchResponse;
    const rug = body.candidates.find((c) => /rug/i.test(c.name))!;
    expect(rug.mount).toBe("floor");
    expect(rug.dims.h).toBeLessThan(0.05);
  });

  it("a budget and mount written in the query act as filters", async () => {
    const res = await post(base, "/api/products/search", { query: "hanging lamp for the corner, Japanese, under $200" });
    const body = (await res.json()) as ProductSearchResponse;
    expect(body.candidates.length).toBeGreaterThan(0);
    for (const c of body.candidates) {
      expect(c.mount).toBe("ceiling");
      expect(c.price!).toBeLessThanOrEqual(200);
    }
  });

  it("exactFilters: true turns that inference off", async () => {
    const res = await post(base, "/api/products/search", { query: "hanging lamp under $100", exactFilters: true });
    const body = (await res.json()) as ProductSearchResponse;
    expect(body.candidates.some((c) => c.mount !== "ceiling" || (c.price ?? 0) > 100)).toBe(true);
  });

  it("impossible filters return an empty list with a note, not an error", async () => {
    const res = await post(base, "/api/products/search", { query: "lamp", maxPrice: 1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProductSearchResponse;
    expect(body.candidates).toEqual([]);
    expect(body.notes).toMatch(/nothing/i);
  });
});

describe("upstream errors", () => {
  it("maps an auth failure to 502 with a helpful message", async () => {
    const failing = createMockProvider({ searchDelayMs: 0 });
    failing.searchProducts = async () => {
      throw toUpstreamError(new Anthropic.AuthenticationError(401, { type: "error" }, "invalid x-api-key", new Headers()));
    };
    const s = await start({ provider: failing });
    try {
      const res = await post(s.base, "/api/products/search", { query: "lamp" });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toMatch(/Anthropic API key rejected/);
    } finally {
      await new Promise<void>((r) => s.server.close(() => r()));
    }
  });

  it("maps SDK error classes", () => {
    expect(toUpstreamError(new Anthropic.RateLimitError(429, {}, "slow down", new Headers())).status).toBe(502);
    expect(toUpstreamError(new Anthropic.RateLimitError(429, {}, "slow down", new Headers())).message).toMatch(/rate limit/);
    expect(toUpstreamError(new Anthropic.APIConnectionError({ message: "boom" })).message).toMatch(/Could not reach/);
    expect(toUpstreamError(new Error("plain")).status).toBe(500);
  });
});
