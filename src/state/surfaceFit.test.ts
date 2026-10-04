// Items on a lower surface (under a desk, a cat tower's level) are checked again when their support changes shape:
// resized, or swapped for a product (review round 5).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SHAPE_PRESETS, defaultRoom } from "../lib/presets";
import { footprintsOverlap } from "../lib/geometry";
import type { ProductCandidate } from "../shared/types";
import type { NewItemInput } from "./store";

const memory = new Map<string, string>();
const storage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, String(v)),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
  key: (i: number) => [...memory.keys()][i] ?? null,
  get length() {
    return memory.size;
  },
};

type StoreModule = typeof import("./store");
let usePlanner: StoreModule["usePlanner"];
const S = () => usePlanner.getState();
const get = (id: string) => S().items.find((it) => it.id === id)!;

beforeAll(async () => {
  vi.stubGlobal("localStorage", storage);
  usePlanner = (await import("./store")).usePlanner;
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  usePlanner.setState({ room: defaultRoom(), items: [], selectedId: null, units: "metric", preview: null, previewTargetId: null, past: [], future: [] });
});

const fromPreset = (key: string, name?: string): NewItemInput => {
  const p = SHAPE_PRESETS.find((x) => x.key === key)!;
  return { name: name ?? p.label, dims: { ...p.dims }, mount: p.mount, color: p.color, parts: p.parts, origin: "shape" };
};
const box = (name: string, w: number, h: number, d: number): NewItemInput => ({
  name,
  dims: { w, h, d },
  mount: "floor",
  color: "#888888",
  parts: [{ kind: "cylinder", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } }],
  origin: "shape",
});
/** A product modelled as one solid box (nothing fits under it, no levels). */
function solidProduct(name: string, dims: { w: number; h: number; d: number }): ProductCandidate {
  return {
    id: `p-${name}`,
    name,
    retailer: "Shop",
    url: `https://example.com/${name}`,
    dims,
    dimsSource: "listed",
    colors: [{ name: "Oak", hex: "#a0805a" }],
    style: [],
    materials: [],
    mount: "floor",
    parts: [{ kind: "box", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } }],
  };
}

/** A desk with a bin of height `binH` under it, and its id. */
function deskWithBin(binH: number) {
  const desk = S().addItem(fromPreset("desk"));
  const bin = S().addItem(box("Bin", 0.25, binH, 0.25));
  S().placeOnTop(bin, desk, 0);
  expect(get(bin)).toMatchObject({ supportId: desk, supportSurfaceY: 0 });
  return { desk, bin };
}

describe("an item under a desk when the desk changes shape", () => {
  it("lowering the desk below the bin's height moves the bin out in front of the desk (not through the desktop)", () => {
    const { desk, bin } = deskWithBin(0.5);
    S().updateItem(desk, { dims: { ...get(desk).dims, h: 0.4 } });
    const b = get(bin);
    const d = get(desk);
    expect(b.supportId).toBeUndefined();
    expect(b.supportSurfaceY).toBeUndefined();
    expect(b.position.y).toBe(0);
    expect(footprintsOverlap(b, d)).toBe(false);
    // In front of the desk (its +z side).
    expect(b.position.z).toBeGreaterThan(d.position.z + d.dims.d / 2);
  });

  it("a desk lowered but still high enough keeps the bin under it", () => {
    const { desk, bin } = deskWithBin(0.3);
    S().updateItem(desk, { dims: { ...get(desk).dims, h: 0.4 } });
    expect(get(bin)).toMatchObject({ supportId: desk, supportSurfaceY: 0, position: { y: 0 } });
  });

  it("narrowing the desk onto the bin keeps the bin under it, clear of the legs", () => {
    const { desk, bin } = deskWithBin(0.3);
    S().updateItem(bin, { position: { x: 0.4, y: 0, z: 0 } });
    expect(get(bin).supportId).toBe(desk);
    S().updateItem(desk, { dims: { ...get(desk).dims, w: 0.8 } });
    const b = get(bin);
    expect(b).toMatchObject({ supportId: desk, supportSurfaceY: 0 });
    // The leg panel now sits at x ≈ ±0.376; the bin (0.25 wide) is inside it.
    expect(b.position.x + 0.125).toBeLessThan(0.376 - 0.016 + 1e-6);
  });

  it("growing the bin taller than the desk's clearance moves it out in front", () => {
    const { desk, bin } = deskWithBin(0.3);
    S().updateItem(bin, { dims: { w: 0.25, h: 0.9, d: 0.25 } });
    const b = get(bin);
    expect(b.supportId).toBeUndefined();
    expect(footprintsOverlap(b, get(desk))).toBe(false);
  });
});

describe("replacing a support with a product", () => {
  it("a bin under a placeholder desk goes in front of a solid product desk; the monitor on top goes on the product", () => {
    const { desk, bin } = deskWithBin(0.3);
    const monitor = S().addItem(box("Monitor", 0.5, 0.4, 0.2));
    S().placeOnTop(monitor, desk);
    const id = S().replaceItemWithProduct(desk, solidProduct("Solid desk", { w: 1.2, h: 0.75, d: 0.6 }))!;
    const product = get(id);
    const b = get(bin);
    expect(b.supportId).toBeUndefined();
    expect(b.position.y).toBe(0);
    expect(footprintsOverlap(b, product)).toBe(false);
    expect(get(monitor)).toMatchObject({ supportId: id, position: { y: 0.75 } });
  });

  it("a product desk with room under it keeps the bin under it", () => {
    const { desk, bin } = deskWithBin(0.3);
    const p = SHAPE_PRESETS.find((x) => x.key === "desk")!;
    const id = S().replaceItemWithProduct(desk, { ...solidProduct("Leggy desk", { w: 1.2, h: 0.75, d: 0.6 }), parts: p.parts })!;
    expect(get(bin)).toMatchObject({ supportId: id, supportSurfaceY: 0, position: { y: 0 } });
  });

  it("a cat on a placeholder tower's middle level goes onto a solid product tower's top, not inside it", () => {
    const tower = S().addItem(fromPreset("cattower"));
    const cat = S().addItem(fromPreset("cat"));
    S().placeOnTop(cat, tower, 0.945);
    expect(get(cat).supportSurfaceY).toBeCloseTo(0.945, 3);
    const id = S().replaceItemWithProduct(tower, solidProduct("Cat condo", { w: 0.6, h: 1.2, d: 0.6 }))!;
    const c = get(cat);
    expect(c.supportId).toBe(id);
    expect(c.supportSurfaceY).toBeUndefined();
    expect(c.position.y).toBeCloseTo(1.2, 6);
  });

  it("replacing the bin under a desk with a taller product bin moves it out in front", () => {
    const { desk, bin } = deskWithBin(0.3);
    const id = S().replaceItemWithProduct(bin, solidProduct("Tall bin", { w: 0.3, h: 0.9, d: 0.3 }))!;
    const b = get(id);
    expect(b.supportId).toBeUndefined();
    expect(footprintsOverlap(b, get(desk))).toBe(false);
  });
});
