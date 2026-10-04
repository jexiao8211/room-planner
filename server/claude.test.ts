// Live provider, exercised offline: the Anthropic client gets a stubbed fetch that replays streamed (SSE)
// responses, so the real SDK code paths (streaming, stop_reason checks, JSON parsing) run without a key.
import { describe, expect, it } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createClaudeProvider } from "./claude";
import { HttpError } from "./errors";
import { ProductListSchema, RoomEstimateSchema, type ProductList, type RoomEstimate } from "./schemas";
import { roomUserPrompt, researchUserPrompt, structureUserPrompt } from "./prompts";
import type { ProductSearchRequest } from "../src/shared/types";

type Block = { type: "text"; text: string };

/** One streamed Messages API response as server-sent events. */
function sse(blocks: Block[], stopReason: string): string {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = ev("message_start", {
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  blocks.forEach((b, index) => {
    out += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
    out += ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    out += ev("content_block_stop", { index });
  });
  out += ev("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
  out += ev("message_stop", {});
  return out;
}

interface Stub {
  fetch: typeof fetch;
  apiBodies: Array<Record<string, unknown>>;
  pageHits: string[];
}

/** Anthropic calls get the scripted responses in order; any other URL is a product page handled by `page`. */
function stubFetch(responses: string[], page: (url: string) => Response = () => new Response("", { status: 404 })): Stub {
  const apiBodies: Array<Record<string, unknown>> = [];
  const pageHits: string[] = [];
  const queue = [...responses];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("api.anthropic.com")) {
      apiBodies.push(JSON.parse(String(init?.body ?? "{}")));
      const body = queue.shift();
      if (body === undefined) throw new Error("unexpected extra API call");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    pageHits.push(url);
    return page(url);
  }) as typeof fetch;
  return { fetch: f, apiBodies, pageHits };
}

const PHOTO = { mediaType: "image/jpeg" as const, dataBase64: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U" };

const estimate: RoomEstimate = {
  room: { name: "Bedroom", width: 4, depth: 3.5, height: 2.5, wallColor: "#eeeeee", floorColor: "#aa8866" },
  photos: [{ photoIndex: 1, facingWall: "North", note: "bed wall" }],
  openings: [
    { kind: "Door", wall: "south", offset: 0.7, width: 0.8, height: 2.0, sill: 0 },
    { kind: "window", wall: "NORTH", offset: 2, width: 1.2, height: 1.2, sill: 0.9 },
  ],
  items: [
    {
      name: "Queen bed",
      // Already scaled by the model to the known 2.03 m bed length.
      dims: { w: 1.6, h: 0.9, d: 2.03 },
      mount: "Floor",
      color: "#ccbbaa",
      position: { x: 0, y: 0, z: -0.7 },
      rotationYDegrees: 0,
      parts: [{ kind: "Box", center: { x: 0, y: 0.25, z: 0 }, size: { x: 1, y: 0.5, z: 1 }, color: null }],
    },
    {
      name: "Lamp",
      dims: { w: 0.3, h: 0.5, d: 0.3 },
      mount: "tabletop", // off-list value: must not sink the whole estimate
      color: "#ffffff",
      position: { x: 1, y: 0, z: 1 },
      rotationYDegrees: 0,
      parts: [],
    },
  ],
  knownMeasurementEstimateMeters: 2.03,
  confidence: "High",
  notes: "Scaled from the bed.",
};

describe("structured output schema sent to the API", () => {
  it("keeps the part/position conventions (not hidden behind a $ref) and has no enum the model could trip over", () => {
    type Node = { $ref?: string; description?: string; properties?: Record<string, Node>; items?: Node };
    const room = zodOutputFormat(RoomEstimateSchema).schema as Node;
    const item = room.properties!.items.items!;
    const part = item.properties!.parts.items!;
    for (const node of [item.properties!.position, part.properties!.center, part.properties!.size]) {
      expect(node.$ref).toBeUndefined();
      expect(node.description).toBeTruthy();
    }
    expect(part.properties!.center.description).toContain("This is the part's CENTER");
    expect(item.properties!.position.description).toContain("Bottom-center of the bbox");
    const json = JSON.stringify(room) + JSON.stringify(zodOutputFormat(ProductListSchema).schema);
    expect(json).not.toContain('"enum"');
    expect(json).toContain("One of: floor, wall, ceiling");
  });

  it("parses off-list enum values instead of throwing", () => {
    const fmt = zodOutputFormat(ProductListSchema);
    const list: ProductList = {
      candidates: [
        {
          name: "Lamp",
          retailer: "Shop",
          url: "https://shop.example/lamp",
          price: 20,
          currency: "USD",
          imageUrl: null,
          dims: { w: 0.2, h: 0.4, d: 0.2 },
          dimsSource: "Listed",
          dimsText: null,
          colors: [],
          style: [],
          origin: null,
          materials: [],
          mount: "tabletop",
          parts: [],
          summary: null,
        },
      ],
      notes: "",
    };
    expect(fmt.parse(JSON.stringify(list)).candidates[0].mount).toBe("tabletop");
  });
});

describe("live room from photos", () => {
  it("normalizes model enums and does not apply a known measurement twice", async () => {
    const stub = stubFetch([sse([{ type: "text", text: JSON.stringify(estimate) }], "end_turn")]);
    const provider = createClaudeProvider("sk-test", { fetch: stub.fetch });
    const res = await provider.roomFromPhotos({ photos: [PHOTO], knownMeasurement: { label: "bed length", meters: 2.03 } });

    // The model already applied the known value (bed 2.03 m) and reported it as such: no second rescale.
    expect(res.room.width).toBeCloseTo(4, 3);
    const bed = res.existingItems.find((it) => it.name === "Queen bed")!;
    expect(bed.dims.d).toBeCloseTo(2.03, 3);
    expect(res.notes).not.toMatch(/Scaled everything/);
    expect(res.notes).toMatch(/already matched/);
    // Case / off-list values were normalized rather than rejected.
    expect(res.room.openings.map((o) => [o.kind, o.wall])).toEqual([
      ["door", "south"],
      ["window", "north"],
    ]);
    expect(res.existingItems.find((it) => it.name === "Lamp")!.mount).toBe("floor");
    expect(res.notes).toContain("Confidence: high.");
    expect(res.notes).toContain("photo 1 faces north");

    // Streamed request with the structured-output format and a 32k budget.
    const body = stub.apiBodies[0];
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(32000);
    expect((body.output_config as { format: { type: string } }).format.type).toBe("json_schema");
  });

  it("reports a refusal as a refusal, not as a parse error", async () => {
    const stub = stubFetch([sse([{ type: "text", text: "I can't help with that." }], "refusal")]);
    const provider = createClaudeProvider("sk-test", { fetch: stub.fetch });
    const err = await provider.roomFromPhotos({ photos: [PHOTO] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(502);
    expect((err as HttpError).message).toMatch(/declined the room analysis/);
  });

  it("reports a truncated answer as out of room, not as a parse error", async () => {
    const stub = stubFetch([sse([{ type: "text", text: '{"room": {"name": "Bed' }], "max_tokens")]);
    const provider = createClaudeProvider("sk-test", { fetch: stub.fetch });
    const err = await provider.roomFromPhotos({ photos: [PHOTO] }).catch((e: unknown) => e);
    expect((err as HttpError).message).toMatch(/ran out of room/);
  });

  it("asks the model for the known object's size as it is in the answer (after scaling)", () => {
    const prompt = roomUserPrompt({ photos: [PHOTO], knownMeasurement: { label: "bed length", meters: 2.03 } });
    expect(prompt).toMatch(/AS IT IS IN\s+YOUR ANSWER \(after scaling\)/);
    expect(prompt).toMatch(/must not intersect/);
  });
});

const productList: ProductList = {
  candidates: [
    {
      name: "Paper Pendant",
      retailer: "Shop A",
      url: "https://shop-a.example/p/paper-pendant",
      price: 120,
      currency: "USD",
      imageUrl: null,
      dims: { w: 0.45, h: 0.9, d: 0.45 },
      dimsSource: "listed",
      dimsText: '18" dia',
      colors: [{ name: "White", hex: "#ffffff" }],
      style: ["Japanese"],
      origin: "Japan",
      materials: ["paper"],
      mount: "ceiling",
      parts: [],
      summary: null,
    },
    {
      name: "Gone Pendant",
      retailer: "Shop A",
      url: "https://shop-a.example/p/gone",
      price: 90,
      currency: "USD",
      imageUrl: null,
      dims: { w: 0.4, h: 0.8, d: 0.4 },
      dimsSource: "estimated",
      dimsText: null,
      colors: [],
      style: [],
      origin: null,
      materials: [],
      mount: "ceiling",
      parts: [],
      summary: null,
    },
    {
      name: "UK Pendant",
      retailer: "Shop B",
      url: "https://shop-b.example/uk-pendant",
      price: 80,
      currency: "GBP",
      imageUrl: null,
      dims: { w: 0.4, h: 0.8, d: 0.4 },
      dimsSource: "estimated",
      dimsText: null,
      colors: [],
      style: [],
      origin: null,
      materials: [],
      mount: "ceiling",
      parts: [],
      summary: null,
    },
  ],
  notes: "Found a few.",
};

describe("live product search", () => {
  const req: ProductSearchRequest = {
    query: "paper pendant",
    mount: "ceiling",
    maxPrice: 200,
    room: { width: 3.66, depth: 3.35, height: 2.44 },
    target: { name: "Hanging lamp", mount: "ceiling", dims: { w: 0.4, h: 0.9, d: 0.4 }, placement: "in the north-west corner" },
    roomItems: [{ name: "Queen bed", dims: { w: 1.6, h: 0.9, d: 2.1 }, color: "#d9d4ca" }],
  };

  it("searches US retailers, drops dead links and non-USD prices under a budget, and fills images", async () => {
    const report = "1. Paper Pendant https://shop-a.example/p/paper-pendant\n2. https://shop-b.example/uk-pendant\n3. https://shop-a.example/p/gone";
    const stub = stubFetch(
      [sse([{ type: "text", text: report }], "end_turn"), sse([{ type: "text", text: JSON.stringify(productList) }], "end_turn")],
      (url) =>
        url.endsWith("/gone")
          ? new Response("not here", { status: 404 })
          : new Response('<html><head><meta property="og:image" content="/img/pendant.jpg"></head></html>', {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
    );
    const provider = createClaudeProvider("sk-test", { fetch: stub.fetch });
    const res = await provider.searchProducts(req);

    expect(res.candidates.map((c) => c.name)).toEqual(["Paper Pendant"]);
    expect(res.candidates[0].imageUrl).toBe("https://shop-a.example/img/pendant.jpg");
    expect(res.candidates[0].id).toMatch(/^prod_[0-9a-z]+$/);
    expect(res.notes).toMatch(/non-USD/);
    expect(res.notes).toMatch(/no longer exists/);

    const tools = stub.apiBodies[0].tools as Array<{ type: string; user_location?: { country?: string } }>;
    expect(tools[0].type).toBe("web_search_20260209");
    expect(tools[0].user_location?.country).toBe("US");
  });

  it("prompts carry the placement context: target, pendant drop, existing items, US/USD", () => {
    const research = researchUserPrompt(req);
    expect(research).toContain('replaces a placeholder "Hanging lamp"');
    expect(research).toContain("in the north-west corner");
    expect(research).toMatch(/at most about 0\.44 m/);
    expect(research).toContain("Queen bed");
    expect(research).toMatch(/US retailers/);
    expect(research).toMatch(/at least 2 different retailers/);
    expect(research).toMatch(/kind of item asked for.*\n.*not a flush-mount, semi-flush or recessed light/);
    const structure = structureUserPrompt(req, "report", []);
    expect(structure).toMatch(/at most about 0\.44 m/);
  });

  it("alternatives to a placed product ask for different products, not a placeholder replacement", () => {
    const alt = {
      ...req,
      target: { ...req.target!, name: "Washi Globe Pendant", isProduct: true },
      excludeUrls: ["https://shop-a.example/washi-globe"],
    };
    const research = researchUserPrompt(alt);
    expect(research).toContain('alternatives to "Washi Globe Pendant"');
    expect(research).not.toContain("placeholder");
    expect(research).toContain("https://shop-a.example/washi-globe");
  });
});
