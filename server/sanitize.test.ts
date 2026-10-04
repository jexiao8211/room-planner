import { describe, expect, it } from "vitest";
import type { Opening, PlacedItem, Room } from "../src/shared/types";
import {
  IdGen,
  LIMITS,
  decideScale,
  finalizeRoomEstimate,
  normalizeHex,
  rescaleDraft,
  sanitizeCandidate,
  sanitizeItem,
  sanitizeParts,
  sanitizeRoom,
  type DraftRoomEstimate,
} from "./sanitize";

const room: Room = sanitizeRoom({ width: 4, depth: 3, height: 2.5, openings: [] });

describe("normalizeHex", () => {
  it("accepts and normalizes valid colors", () => {
    expect(normalizeHex("#ABCDEF")).toBe("#abcdef");
    expect(normalizeHex("abc")).toBe("#aabbcc");
    expect(normalizeHex(" #123456 ")).toBe("#123456");
  });
  it("rejects junk", () => {
    expect(normalizeHex("red")).toBeNull();
    expect(normalizeHex("#12345")).toBeNull();
    expect(normalizeHex(42)).toBeNull();
  });
});

describe("IdGen", () => {
  it("keeps valid unique ids and re-mints duplicates/invalid ones", () => {
    const ids = new IdGen();
    expect(ids.take("item", "bed")).toBe("bed");
    expect(ids.take("item", "bed")).toBe("item_1");
    expect(ids.take("item", "has space")).toBe("item_2");
    expect(ids.take("item")).toBe("item_3");
    expect(ids.take("item", "item_4")).toBe("item_4");
    expect(ids.take("item")).toBe("item_5");
  });
});

describe("sanitizeRoom", () => {
  it("clamps dimensions to sane ranges and fixes colors", () => {
    const r = sanitizeRoom({ width: 0.5, depth: 99, height: 20, wallColor: "beige", floorColor: "#ABC", openings: [] });
    expect(r.width).toBe(LIMITS.roomSizeMin);
    expect(r.depth).toBe(LIMITS.roomSizeMax);
    expect(r.height).toBe(LIMITS.roomHeightMax);
    expect(r.wallColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(r.floorColor).toBe("#aabbcc");
    expect(sanitizeRoom({ width: 3, depth: 3, height: 1, openings: [] }).height).toBe(LIMITS.roomHeightMin);
  });

  it("keeps openings within their walls and gives them unique ids", () => {
    const openings = [
      { id: "d", kind: "door", wall: "south", offset: 10, width: 0.9, height: 3.5, sill: 0.4 },
      { id: "d", kind: "window", wall: "east", offset: -1, width: 9, height: 1.2, sill: 2.4 },
      { kind: "window", wall: "up", offset: 1, width: 1, height: 1, sill: 1 },
    ] as unknown as Opening[];
    const r = sanitizeRoom({ width: 4, depth: 3, height: 2.5, openings });
    const [door, win, win2] = r.openings;
    expect(door.sill).toBe(0);
    expect(door.height).toBeLessThanOrEqual(2.5);
    expect(door.offset + door.width / 2).toBeLessThanOrEqual(4 + 1e-9);
    expect(win.width).toBeLessThanOrEqual(3);
    expect(win.offset - win.width / 2).toBeGreaterThanOrEqual(-1e-9);
    expect(win.offset + win.width / 2).toBeLessThanOrEqual(3 + 1e-9);
    expect(win.sill + win.height).toBeLessThanOrEqual(2.5);
    expect(win2.wall).toBe("north");
    expect(new Set(r.openings.map((o) => o.id)).size).toBe(3);
  });
});

describe("sanitizeParts", () => {
  it("falls back to a full box when empty", () => {
    expect(sanitizeParts([])).toEqual([{ kind: "box", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } }]);
    expect(sanitizeParts(undefined)).toHaveLength(1);
  });
  it("clamps sizes and keeps parts inside the bbox", () => {
    const [p] = sanitizeParts([{ kind: "pyramid", center: { x: 0.9, y: -1, z: 0 }, size: { x: 0.5, y: 3, z: 0 }, color: "nope" }]);
    expect(p.kind).toBe("box");
    expect(p.size.y).toBe(1);
    expect(p.size.z).toBeGreaterThan(0);
    expect(p.center.x + p.size.x / 2).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(p.center.y - p.size.y / 2).toBeGreaterThanOrEqual(-1e-9);
    expect(p.color).toBeUndefined();
  });
});

describe("sanitizeItem", () => {
  it("clamps dims (0.02–5 m), constrains position and mount rules", () => {
    const ids = new IdGen();
    const it1 = sanitizeItem({ name: "x", dims: { w: 0.001, h: 9, d: 1 }, mount: "floor", position: { x: 50, y: 3, z: -50 } }, room, ids);
    expect(it1.dims.w).toBe(LIMITS.itemMin);
    expect(it1.dims.h).toBeLessThanOrEqual(room.height);
    expect(it1.position.y).toBe(0);
    expect(it1.position.x).toBeLessThanOrEqual(room.width / 2);
    expect(it1.position.z).toBeGreaterThanOrEqual(-room.depth / 2);
    const lamp = sanitizeItem({ name: "lamp", dims: { w: 0.4, h: 0.8, d: 0.4 }, mount: "ceiling", position: { x: 0, y: 0, z: 0 } }, room, ids);
    expect(lamp.position.y).toBeCloseTo(room.height - 0.8, 6);
    const weird = sanitizeItem({ mount: "roof" as PlacedItem["mount"], color: "zz" } as Partial<PlacedItem>, room, ids);
    expect(weird.mount).toBe("floor");
    expect(weird.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(weird.parts.length).toBe(1);
    expect(weird.name).toBe("Item");
  });
});

describe("sanitizeCandidate", () => {
  const base = {
    name: "Lamp",
    retailer: "",
    url: "https://www.shop.example/lamp",
    dims: { w: 0.4, h: 99, d: 0.4 },
    dimsSource: "listed" as const,
    colors: [{ name: "white", hex: "fff" }, { name: "bad", hex: "white" }],
    style: ["Japanese", "japanese", " minimal "],
    materials: ["paper"],
    mount: "ceiling" as const,
    parts: [],
  };
  it("drops candidates without a valid http(s) url", () => {
    expect(sanitizeCandidate({ ...base, url: "javascript:alert(1)" }, new IdGen())).toBeNull();
    expect(sanitizeCandidate({ ...base, url: "not a url" }, new IdGen())).toBeNull();
  });
  it("cleans traits", () => {
    const c = sanitizeCandidate({ ...base, price: 12.345, currency: "usd", imageUrl: "ftp://x/y.png" }, new IdGen())!;
    expect(c.dims.h).toBe(LIMITS.itemMax);
    expect(c.colors).toEqual([{ name: "white", hex: "#ffffff" }]);
    expect(c.style).toEqual(["Japanese", "minimal"]);
    expect(c.retailer).toBe("shop.example");
    expect(c.price).toBe(12.35);
    expect(c.currency).toBe("USD");
    expect(c.imageUrl).toBeUndefined();
    expect(c.parts).toHaveLength(1);
  });
  it("gives every candidate a color", () => {
    const c = sanitizeCandidate({ ...base, colors: [] }, new IdGen())!;
    expect(c.colors.length).toBe(1);
  });
  it("derives ids from the URL, so separate searches never reuse an id for a different product", () => {
    // Each search response has its own IdGen; the old prod_1..N ids collided across searches.
    const a = sanitizeCandidate({ ...base, url: "https://shop.example/a" }, new IdGen())!;
    const b = sanitizeCandidate({ ...base, url: "https://shop.example/b" }, new IdGen())!;
    const a2 = sanitizeCandidate({ ...base, url: "https://shop.example/a" }, new IdGen())!;
    expect(a.id).not.toBe(b.id);
    expect(a2.id).toBe(a.id);
  });
  it("normalizes enum-like fields case-insensitively (model output is not enum-checked)", () => {
    const c = sanitizeCandidate({ ...base, mount: "Ceiling" as never, dimsSource: "LISTED" as never }, new IdGen())!;
    expect(c.mount).toBe("ceiling");
    expect(c.dimsSource).toBe("listed");
    expect(sanitizeCandidate({ ...base, mount: "tabletop" as never }, new IdGen())!.mount).toBe("floor");
  });
});

describe("scale fix", () => {
  const draft: DraftRoomEstimate = {
    room: { width: 4, depth: 3, height: 2.4 },
    openings: [
      { kind: "door", wall: "south", offset: 1, width: 0.8, height: 2.0, sill: 0 },
      { kind: "door", wall: "east", offset: 1, width: 0.9, height: 2.1, sill: 0 },
      { kind: "window", wall: "north", offset: 2, width: 1, height: 1, sill: 1 },
    ],
    items: [{ name: "bed", dims: { w: 1.5, h: 0.6, d: 2 }, position: { x: 1, y: 0, z: -0.5 } }],
  };

  it("ceiling label compares to room height", () => {
    const d = decideScale({ label: "Ceiling height", meters: 2.64 }, draft, null);
    expect(d.basis).toBe("ceiling height");
    expect(d.factor).toBeCloseTo(1.1, 6);
  });
  it("door label compares to the tallest door; 'width' compares widths", () => {
    expect(decideScale({ label: "door", meters: 2.31 }, draft, null)).toMatchObject({ basis: "door height", estimate: 2.1 });
    expect(decideScale({ label: "door width", meters: 0.81 }, draft, null).basis).toBe("door width");
  });
  it("other labels use the model's own estimate; within 3% is ignored", () => {
    expect(decideScale({ label: "bed length", meters: 2.2 }, draft, 2.0)).toMatchObject({ basis: "model estimate" });
    expect(decideScale({ label: "bed length", meters: 2.2 }, draft, 2.0).factor).toBeCloseTo(1.1, 6);
    expect(decideScale({ label: "bed length", meters: 2.05 }, draft, 2.0).factor).toBe(1);
    expect(decideScale({ label: "sofa height", meters: 0.9 }, draft, null).factor).toBe(1);
  });
  it("refuses absurd factors", () => {
    expect(decideScale({ label: "ceiling", meters: 30 }, draft, null).factor).toBe(1);
  });
  it("rescales room, openings and items uniformly", () => {
    const s = rescaleDraft(draft, 1.5);
    expect(s.room.width).toBeCloseTo(6);
    expect(s.openings[2].sill).toBeCloseTo(1.5);
    expect(s.openings[0].offset).toBeCloseTo(1.5);
    expect(s.items[0].dims!.d).toBeCloseTo(3);
    expect(s.items[0].position!.x).toBeCloseTo(1.5);
    expect(rescaleDraft(draft, 1)).toBe(draft);
  });
});

describe("wall items from a room estimate", () => {
  it("hang on the wall they stand against, facing into the room, even with a wrong rotation", () => {
    const draft: DraftRoomEstimate = {
      room: { name: "Den", width: 3.66, depth: 3.35, height: 2.44 },
      openings: [],
      items: [
        { name: "TV", mount: "wall", position: { x: 1.8, y: 1, z: 0.2 }, rotationY: 0, dims: { w: 1.2, h: 0.7, d: 0.08 } },
        { name: "Mirror", mount: "wall", position: { x: -1.8, y: 1, z: -0.4 }, rotationY: -Math.PI / 2, dims: { w: 0.6, h: 1, d: 0.03 } },
        { name: "Art", mount: "wall", position: { x: 0.3, y: 1.3, z: -1.66 }, rotationY: 0, dims: { w: 0.6, h: 0.5, d: 0.03 } },
      ],
    };
    const { existingItems } = finalizeRoomEstimate(draft);
    const [tv, mirror, art] = existingItems;
    expect(tv.position.x).toBeCloseTo(1.83 - 0.04, 3);
    expect(tv.position.z).toBeCloseTo(0.2, 3);
    expect(tv.rotationY).toBeCloseTo(-Math.PI / 2, 4);
    expect(mirror.position.x).toBeCloseTo(-1.83 + 0.015, 3);
    expect(mirror.rotationY).toBeCloseTo(Math.PI / 2, 4);
    expect(art.position.z).toBeCloseTo(-1.675 + 0.015, 3);
    expect(art.position.x).toBeCloseTo(0.3, 3);
    expect(art.rotationY).toBe(0);
  });
});
