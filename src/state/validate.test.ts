import { describe, expect, it } from "vitest";
import { normalizeProduct, parsePlannerFile } from "./validate";
import { httpUrl } from "../lib/urls";

const product = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  name: "Paper lantern",
  retailer: "Shop",
  url: "https://shop.example.com/lantern",
  dims: { w: 0.45, h: 0.6, d: 0.45 },
  colors: [{ name: "White", hex: "#ffffff" }],
  style: ["Japanese"],
  materials: ["paper"],
  mount: "ceiling",
  parts: [{ kind: "sphere", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } }],
  ...over,
});

describe("product links from files and storage", () => {
  it("only accepts http(s) links", () => {
    expect(httpUrl("https://a.example/x")).toBe("https://a.example/x");
    expect(httpUrl(" http://a.example ")).toBe("http://a.example/");
    const bad = [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///C:/Windows/system32/calc.exe",
      "ms-msdt:/id PCWDiagnostic",
      "search-ms:query=x",
      "ms-settings:",
      "/relative",
      "",
      42,
    ];
    for (const v of bad) expect(httpUrl(v), String(v)).toBeUndefined();
  });

  it("drops a product whose link isn't http(s), and an image URL that isn't", () => {
    expect(normalizeProduct(product())?.url).toBe("https://shop.example.com/lantern");
    expect(normalizeProduct(product({ url: "data:text/html,<script>alert(1)</script>" }))).toBeUndefined();
    expect(normalizeProduct(product({ url: "ms-msdt:/id PCWDiagnostic" }))).toBeUndefined();
    const p = normalizeProduct(product({ imageUrl: "file:///etc/passwd" }))!;
    expect(p).toBeDefined();
    expect(p.imageUrl).toBeUndefined();
    expect(normalizeProduct(product({ imageUrl: "https://cdn.example.com/a.jpg" }))?.imageUrl).toBe("https://cdn.example.com/a.jpg");
  });

  it("an imported plan keeps the item but not a product with a bad link", () => {
    const file = {
      version: 1,
      room: { width: 3, depth: 3, height: 2.4 },
      items: [
        {
          id: "i1",
          name: "Lamp",
          position: { x: 0, y: 1.8, z: 0 },
          rotationY: 0,
          dims: { w: 0.4, h: 0.6, d: 0.4 },
          color: "#ffffff",
          mount: "ceiling",
          parts: [],
          origin: "product",
          product: product({ url: "search-ms:query=evil" }),
        },
      ],
    };
    const { items } = parsePlannerFile(JSON.stringify(file));
    expect(items).toHaveLength(1);
    expect(items[0].product).toBeUndefined();
  });
});

describe("droppedFromId (additive)", () => {
  it("survives a reload / import, and is dropped when it points at a missing item", () => {
    const base = { position: { x: 0, y: 0, z: 0 }, rotationY: 0, dims: { w: 0.3, h: 0.5, d: 0.3 }, color: "#ffffff", mount: "floor", parts: [], origin: "shape" };
    const json = JSON.stringify({
      version: 1,
      room: { name: "R", width: 4, depth: 4, height: 2.4, wallColor: "#ffffff", floorColor: "#ffffff", openings: [] },
      items: [
        { ...base, id: "box", hidden: true },
        { ...base, id: "lamp", droppedFromId: "box" },
        { ...base, id: "cup", droppedFromId: "gone" },
      ],
    });
    const { items } = parsePlannerFile(json);
    expect(items.find((it) => it.id === "lamp")?.droppedFromId).toBe("box");
    expect(items.find((it) => it.id === "cup")?.droppedFromId).toBeUndefined();
  });
});
