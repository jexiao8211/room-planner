import { describe, expect, it } from "vitest";
import type { PlacedItem, ProductCandidate } from "../../shared/types";
import { defaultRoom, fullPart } from "../../lib/presets";
import { buildChatScene, buildHistory, MAX_HISTORY, resultsHint } from "./buildScene";

const item = (id: string, extra: Partial<PlacedItem> = {}): PlacedItem => ({
  id,
  name: id,
  position: { x: 0.123456, y: 0, z: -1.0004 },
  rotationY: Math.PI / 3,
  dims: { w: 1, h: 0.5, d: 0.5 },
  color: "#aabbcc",
  mount: "floor",
  parts: [fullPart("box")],
  origin: "shape",
  ...extra,
});

describe("buildChatScene", () => {
  it("lists items compactly (no parts, rounded), keeps stacking / hidden / product info and the selection", () => {
    const product = { id: "p", name: "Lamp", retailer: "Shop", url: "https://x.test/p", price: 50 } as ProductCandidate;
    const scene = buildChatScene({
      units: "imperial",
      room: defaultRoom(),
      items: [item("desk"), item("mon", { supportId: "desk", hidden: true, origin: "product", product })],
      selectedId: "mon",
    });
    expect(scene.units).toBe("imperial");
    expect(scene.room.width).toBe(3.66);
    expect(scene.room.openings).toHaveLength(2);
    expect(scene.items[0]).toEqual({
      id: "desk",
      name: "desk",
      dims: { w: 1, h: 0.5, d: 0.5 },
      position: { x: 0.123, y: 0, z: -1 },
      rotationY: 1.047,
      mount: "floor",
      color: "#aabbcc",
      origin: "shape",
    });
    expect(scene.items[1]).toMatchObject({ supportId: "desk", hidden: true, product: { name: "Lamp", retailer: "Shop", price: 50, url: "https://x.test/p" } });
    expect(scene.selectedId).toBe("mon");
    expect(scene.lastResults).toBeUndefined();
  });

  it("drops a stale selection and adds the last results with their index", () => {
    const c: ProductCandidate = {
      id: "c1",
      name: "Lantern",
      retailer: "R",
      url: "https://x.test/c1",
      dims: { w: 0.4, h: 0.5, d: 0.4 },
      dimsSource: "estimated",
      colors: [{ name: "White", hex: "#ffffff" }],
      style: ["Japanese"],
      materials: [],
      mount: "ceiling",
      parts: [fullPart("sphere")],
    };
    const scene = buildChatScene({ units: "metric", room: defaultRoom(), items: [], selectedId: "gone" }, [c]);
    expect(scene.selectedId).toBeNull();
    expect(scene.lastResults).toEqual([
      { index: 0, name: "Lantern", retailer: "R", price: undefined, dims: { w: 0.4, h: 0.5, d: 0.4 }, mount: "ceiling", style: ["Japanese"], colors: ["White"] },
    ]);
  });
});

describe("buildHistory", () => {
  it("keeps the last text turns only", () => {
    const msgs = [
      { role: "user" as const, text: "hi", kind: "text" },
      { role: "assistant" as const, text: "", kind: "search" },
      { role: "assistant" as const, text: "oops", kind: "error" },
      ...Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `m${i}`, kind: "text" })),
    ];
    const h = buildHistory(msgs);
    expect(h).toHaveLength(MAX_HISTORY);
    expect(h[h.length - 1]).toEqual({ role: "assistant", content: "m19" });
    expect(h.some((t) => t.content === "oops")).toBe(false);
  });
});

describe("review round 3", () => {
  it("clips names and lists to the server's limits so the request always validates", async () => {
    const { ChatRequestSchema } = await import("../../../server/schemas");
    const room = { ...defaultRoom(), name: "R".repeat(500), openings: Array.from({ length: 50 }, (_, i) => ({ ...defaultRoom().openings[0], id: `o${i}` })) };
    const product = { id: "p", name: "P".repeat(400), retailer: "S".repeat(300), url: `https://x.test/${"u".repeat(3000)}`, price: 5 } as ProductCandidate;
    const scene = buildChatScene({ units: "metric", room, items: [item("a", { name: "N".repeat(500), origin: "product", product })], selectedId: null });
    expect(ChatRequestSchema.safeParse({ message: "hi", history: [], scene }).success).toBe(true);
    expect(scene.items[0].name).toHaveLength(200);
    expect(scene.room.openings).toHaveLength(40);
  });

  it("always includes the selected item (and what it rests on) even in a big room", () => {
    const items = [item("old_desk"), item("old_mon", { supportId: "old_desk" }), ...Array.from({ length: 100 }, (_, i) => item(`i${i}`))];
    const scene = buildChatScene({ units: "metric", room: defaultRoom(), items, selectedId: "old_mon" });
    expect(scene.selectedId).toBe("old_mon");
    expect(scene.items.map((i) => i.id).slice(0, 2)).toEqual(["old_desk", "old_mon"]);
    expect(scene.items).toHaveLength(82);
  });

  it("says what the last search was for", () => {
    const c = { id: "c1", name: "Lamp", retailer: "R", url: "https://x.test", dims: { w: 0.3, h: 0.5, d: 0.3 }, dimsSource: "listed", colors: [], style: [], materials: [], mount: "floor", parts: [] } as ProductCandidate;
    const scene = buildChatScene({ units: "metric", room: defaultRoom(), items: [item("lamp")], selectedId: null, previewTargetId: "lamp" }, [c], "mid-century lamp");
    expect(scene.lastSearch).toEqual({ query: "mid-century lamp", forItemId: "lamp" });
    // No results: nothing to pick from, no lastSearch.
    expect(buildChatScene({ units: "metric", room: defaultRoom(), items: [item("lamp")], selectedId: null, previewTargetId: "lamp" }, []).lastSearch).toBeUndefined();
  });

  it("puts finished searches into the history as a one-line summary", () => {
    const c = { id: "c1", name: "Akari", retailer: "Vitra", price: 129, url: "u", mount: "ceiling" } as ProductCandidate;
    const h = buildHistory([
      { role: "user", text: "find a lamp", kind: "text" },
      { role: "assistant", text: "", kind: "search", search: { query: "lamp", status: "done", candidates: [c] } },
      { role: "assistant", text: "", kind: "search", search: { query: "x", status: "running" } },
    ]);
    expect(h).toEqual([
      { role: "user", content: "find a lamp" },
      { role: "assistant", content: 'Found 1 product for "lamp": 1. Akari $129 (Vitra, ceiling).' },
    ]);
  });

  it("suggests a follow-up that works for the results", () => {
    const r = (mount: ProductCandidate["mount"], w = 0.3) => ({ mount, dims: { w, h: 0.5, d: 0.3 } });
    expect(resultsHint([r("ceiling"), r("ceiling")], true)).toBe("add the second one in the corner");
    expect(resultsHint([r("wall")], true)).toBe("add the first one on the north wall");
    expect(resultsHint([r("floor"), r("floor")], true)).toBe("add the second one on the desk");
    expect(resultsHint([r("floor"), r("floor")], false)).toBe("add the second one");
    expect(resultsHint([r("floor"), r("floor", 2)], true)).toBe("add the second one");
  });
});

describe("buildChatScene: previewed result", () => {
  it("says which result is shown as a ghost (lastSearch.previewIndex)", () => {
    const c = (id: string) => ({ id, name: id, retailer: "R", url: "https://x.test", dims: { w: 0.5, h: 0.6, d: 0.4 }, dimsSource: "listed", colors: [], style: [], materials: [], mount: "floor", parts: [] }) as ProductCandidate;
    const results = [c("a"), c("b"), c("c")];
    const base = { units: "metric" as const, room: defaultRoom(), items: [], selectedId: null };
    expect(buildChatScene({ ...base, preview: results[1] }, results, "walnut nightstand").lastSearch).toEqual({ query: "walnut nightstand", previewIndex: 1 });
    expect(buildChatScene({ ...base, preview: null }, results, "walnut nightstand").lastSearch).toEqual({ query: "walnut nightstand" });
    // A preview that isn't one of these results (an older search) isn't "it".
    expect(buildChatScene({ ...base, preview: c("old") }, results, "x").lastSearch).toEqual({ query: "x" });
  });
});
