// Live-mode helpers, tested offline with hand-built model output. Never calls the API.
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ProductListSchema, RoomEstimateSchema, type ProductList, type RoomEstimate } from "./schemas";
import {
  buildRoomResponse,
  candidatesFromProductList,
  estimateToDraft,
  extractResearch,
  roomNotesFromEstimate,
} from "./convert";
import { assertNotRefused } from "./claude";
import { HttpError } from "./errors";

const estimate: RoomEstimate = {
  room: { name: "Bedroom", width: 3.5, depth: 3.2, height: 2.3, wallColor: "#EEE", floorColor: "oak" },
  photos: [
    { photoIndex: 1, facingWall: "north", note: "bed wall" },
    { photoIndex: 2, facingWall: null, note: "blurry" },
  ],
  openings: [
    { kind: "door", wall: "south", offset: 0.6, width: 0.8, height: 1.95, sill: 0 },
    { kind: "window", wall: "north", offset: 1.7, width: 1.1, height: 1.1, sill: 0.9 },
  ],
  items: [
    {
      name: "Bed",
      dims: { w: 1.5, h: 0.9, d: 2.0 },
      mount: "floor",
      color: "#ccbbaa",
      position: { x: 0, y: 0, z: -0.6 },
      rotationYDegrees: 90,
      parts: [{ kind: "box", center: { x: 0, y: 0.25, z: 0 }, size: { x: 1, y: 0.5, z: 1 }, color: null }],
    },
  ],
  knownMeasurementEstimateMeters: 1.95,
  confidence: "medium",
  notes: "Scale from the door.",
};

describe("structured output schemas", () => {
  it("convert to a strict JSON schema and parse model JSON", () => {
    const roomFmt = zodOutputFormat(RoomEstimateSchema);
    expect(roomFmt.type).toBe("json_schema");
    expect(roomFmt.parse(JSON.stringify(estimate)).room.width).toBe(3.5);
    const listFmt = zodOutputFormat(ProductListSchema);
    expect(() => listFmt.parse("{}")).toThrow();
  });
});

describe("room estimate → response", () => {
  it("converts degrees, drops null part colors, and sanitizes", () => {
    const draft = estimateToDraft(estimate);
    expect(draft.items[0].rotationY).toBeCloseTo(Math.PI / 2);
    expect(draft.items[0].parts![0]).not.toHaveProperty("color");
    const res = buildRoomResponse(draft, {}, { mock: false, notes: roomNotesFromEstimate(estimate) });
    expect(res.mock).toBe(false);
    expect(res.room.wallColor).toBe("#eeeeee");
    expect(res.room.floorColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(res.existingItems[0].origin).toBe("existing");
    expect(res.notes).toContain("Confidence: medium.");
    expect(res.notes).toContain("photo 1 faces north");
  });

  it("rescales when the known door height disagrees with the estimate", () => {
    const res = buildRoomResponse(
      estimateToDraft(estimate),
      { knownMeasurement: { label: "front door height", meters: 2.03 } },
      { mock: false, modelEstimateMeters: estimate.knownMeasurementEstimateMeters },
    );
    const f = 2.03 / 1.95;
    expect(res.room.height).toBeCloseTo(2.3 * f, 3);
    expect(res.room.openings.find((o) => o.kind === "door")!.height).toBeCloseTo(2.03, 3);
    expect(res.existingItems[0].dims.d).toBeCloseTo(2.0 * f, 3);
    expect(res.notes).toMatch(/Scaled everything up 4%/);
  });
});

function textBlock(text: string, urls: string[] = []): Anthropic.TextBlock {
  return {
    type: "text",
    text,
    citations: urls.map((url) => ({
      type: "web_search_result_location",
      url,
      title: "t",
      cited_text: "c",
      encrypted_index: "e",
    })),
  } as Anthropic.TextBlock;
}

describe("extractResearch", () => {
  it("collects text across paused turns, urls from results/citations/text, and search errors", () => {
    const msgs = [
      {
        content: [
          { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "paper lantern" } },
          {
            type: "web_search_tool_result",
            tool_use_id: "s1",
            content: [{ type: "web_search_result", url: "https://shop-a.example/p/1", title: "A", encrypted_content: "x", page_age: null }],
          },
          textBlock("Report part one. "),
        ],
      },
      {
        content: [
          { type: "web_search_tool_result", tool_use_id: "s2", content: { type: "web_search_tool_result_error", error_code: "too_many_requests" } },
          textBlock("See https://shop-b.example/item/2.", ["https://shop-c.example/x"]),
        ],
      },
    ] as unknown as Array<Pick<Anthropic.Message, "content">>;
    const r = extractResearch(msgs);
    expect(r.report).toBe("Report part one. See https://shop-b.example/item/2.");
    expect(r.sourceUrls).toEqual(["https://shop-a.example/p/1", "https://shop-c.example/x", "https://shop-b.example/item/2"]);
    expect(r.searchErrors).toEqual(["too_many_requests"]);
    expect(r.searchCount).toBe(2);
  });
});

describe("candidatesFromProductList", () => {
  const cand = (over: Partial<ProductList["candidates"][number]>): ProductList["candidates"][number] => ({
    name: "Lamp",
    retailer: "Shop",
    url: "https://shop-a.example/p/1",
    price: 50,
    currency: "USD",
    imageUrl: null,
    dims: { w: 0.4, h: 0.9, d: 0.4 },
    dimsSource: "listed",
    dimsText: null,
    colors: [{ name: "White", hex: "#ffffff" }],
    style: ["Japanese"],
    origin: null,
    materials: ["paper"],
    mount: "ceiling",
    parts: [{ kind: "sphere", center: { x: 0, y: 0.2, z: 0 }, size: { x: 1, y: 0.4, z: 1 }, color: null }],
    summary: null,
    ...over,
  });

  it("drops invalid, duplicate, ungrounded and over-budget candidates", () => {
    const list: ProductList = {
      notes: "",
      candidates: [
        cand({}),
        cand({ name: "dup" }),
        cand({ url: "not-a-url" }),
        cand({ url: "https://made-up.example/p" }),
        cand({ url: "https://shop-a.example/p/2", price: 500 }),
        cand({ url: "https://shop-a.example/p/3", price: null }),
      ],
    };
    const { candidates, dropped } = candidatesFromProductList(list, { maxPrice: 100 }, ["https://shop-a.example/search"]);
    expect(candidates.map((c) => c.url)).toEqual(["https://shop-a.example/p/1", "https://shop-a.example/p/3"]);
    expect(dropped).toBe(4);
    expect(candidates[0].origin).toBeUndefined();
    expect(candidates[1].price).toBeUndefined();
  });

  it("keeps candidates when no sources were captured", () => {
    const { candidates } = candidatesFromProductList({ notes: "", candidates: [cand({ url: "https://x.example/1" })] }, {}, []);
    expect(candidates).toHaveLength(1);
  });

  it("caps at 6", () => {
    const list: ProductList = { notes: "", candidates: Array.from({ length: 9 }, (_, i) => cand({ url: `https://shop-a.example/p/${i}` })) };
    expect(candidatesFromProductList(list, {}, []).candidates).toHaveLength(6);
  });
});

describe("assertNotRefused", () => {
  it("throws a 502 HttpError on refusal and passes otherwise", () => {
    expect(() => assertNotRefused({ stop_reason: "end_turn", stop_details: null }, "x")).not.toThrow();
    let caught: unknown;
    try {
      assertNotRefused({ stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null } as never }, "room");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(502);
  });
});
