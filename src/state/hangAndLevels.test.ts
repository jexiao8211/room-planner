// Store: placeOnTop on a chosen surface (a level, under a desk) and hangFromCeiling (ROUND3-SPEC §3, §4, §7).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SHAPE_PRESETS, defaultRoom } from "../lib/presets";
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

describe("placeOnTop with a surface", () => {
  it("defaults to the highest surface; surfaceY picks a level or the floor under a desk", () => {
    const tower = S().addItem(fromPreset("cattower"));
    const cat = S().addItem(fromPreset("cat"));
    S().placeOnTop(cat, tower);
    expect(get(cat).position.y).toBeCloseTo(1.5);
    expect(get(cat).supportSurfaceY).toBeUndefined();
    S().placeOnTop(cat, tower, 0.945);
    expect(get(cat).supportSurfaceY).toBeCloseTo(0.945);
    expect(get(cat).position.y).toBeCloseTo(0.945);
    // Not a surface it fits on (the condo roof is too low under the platform): no-op, no undo step.
    const steps = S().past.length;
    S().placeOnTop(cat, tower, 0.675);
    expect(get(cat).supportSurfaceY).toBeCloseTo(0.945);
    expect(S().past.length).toBe(steps);
    // Taking it off clears the surface too.
    S().placeOnTop(cat, null);
    expect(get(cat).supportId).toBeUndefined();
    expect(get(cat).supportSurfaceY).toBeUndefined();

    const desk = S().addItem(fromPreset("desk"));
    const bin = S().addItem({ ...fromPreset("cylinder", "Bin"), dims: { w: 0.3, h: 0.35, d: 0.3 } });
    S().placeOnTop(bin, desk, 0);
    expect(get(bin)).toMatchObject({ supportId: desk, supportSurfaceY: 0 });
    expect(get(bin).position.y).toBe(0);
    // Resizing the desk keeps it under the desk (on the floor).
    S().updateItem(desk, { dims: { w: 1.2, h: 0.8, d: 0.6 } });
    expect(get(bin).position.y).toBe(0);
    expect(get(bin).supportId).toBe(desk);
  });
});

describe("hangFromCeiling", () => {
  it("hangs a floor lamp-like item with a pendant drop, one undo step; a box hangs flush", () => {
    const lamp = S().addItem({ ...fromPreset("cylinder", "Paper lamp"), dims: { w: 0.4, h: 0.4, d: 0.4 } });
    const steps = S().past.length;
    const drop = S().hangFromCeiling(lamp);
    expect(drop).toBeCloseTo(2.44 - 1.9);
    expect(get(lamp).mount).toBe("ceiling");
    expect(get(lamp).dims.h).toBeCloseTo(2.44 - 1.9);
    expect(get(lamp).position.y).toBeCloseTo(1.9);
    expect(S().past.length).toBe(steps + 1);
    S().undo();
    expect(get(lamp).mount).toBe("floor");

    const box = S().addItem({ ...fromPreset("box"), dims: { w: 0.4, h: 0.3, d: 0.4 } });
    S().hangFromCeiling(box);
    expect(get(box).dims.h).toBeCloseTo(0.3);
    expect(get(box).position.y).toBeCloseTo(2.44 - 0.3);
  });

  it("sets a pendant's drop (the Inspector's Drop field), and what stood on a hung item falls off", () => {
    const pendant = S().addItem(fromPreset("pendant"));
    expect(S().hangFromCeiling(pendant, 1.2)).toBeCloseTo(1.2);
    expect(get(pendant).position.y).toBeCloseTo(2.44 - 1.2);
    const shelf = S().addItem({ ...fromPreset("box", "Shelf"), dims: { w: 0.6, h: 0.3, d: 0.3 } });
    const vase = S().addItem({ ...fromPreset("box", "Vase"), dims: { w: 0.1, h: 0.2, d: 0.1 } });
    S().placeOnTop(vase, shelf);
    S().hangFromCeiling(shelf);
    expect(get(vase).supportId).toBeUndefined();
    expect(get(vase).position.y).toBe(0);
    // Locked items aren't hung.
    S().updateItem(pendant, { locked: true });
    expect(S().hangFromCeiling(pendant, 0.5)).toBeNull();
  });
});

describe("hiding and showing a support keeps each item on its own surface", () => {
  it("a bin under the desk stays under it; the monitor on top goes back on top; a cat keeps its level", () => {
    const desk = S().addItem(fromPreset("desk"));
    const bin = S().addItem({ ...fromPreset("cylinder", "Bin"), dims: { w: 0.25, h: 0.25, d: 0.25 } });
    const monitor = S().addItem({ ...fromPreset("box", "Monitor"), dims: { w: 0.5, h: 0.4, d: 0.2 } });
    S().placeOnTop(bin, desk, 0);
    S().placeOnTop(monitor, desk);
    expect(get(bin)).toMatchObject({ supportId: desk, supportSurfaceY: 0 });

    S().updateItem(desk, { hidden: true });
    expect(get(bin).supportId).toBeUndefined();
    expect(get(bin).position.y).toBe(0);
    expect(get(bin).droppedFromId).toBe(desk);
    expect(get(bin).droppedSurfaceY).toBe(0);
    expect(get(monitor).position.y).toBe(0);

    S().updateItem(desk, { hidden: false });
    expect(get(bin)).toMatchObject({ supportId: desk, supportSurfaceY: 0 });
    expect(get(bin).position.y).toBe(0);
    expect(get(bin).droppedFromId).toBeUndefined();
    expect(get(bin).droppedSurfaceY).toBeUndefined();
    expect(get(monitor).supportId).toBe(desk);
    expect(get(monitor).supportSurfaceY).toBeUndefined();
    expect(get(monitor).position.y).toBeCloseTo(0.75);

    const tower = S().addItem(fromPreset("cattower"));
    const cat = S().addItem(fromPreset("cat"));
    S().placeOnTop(cat, tower, 0.945);
    S().updateItem(tower, { hidden: true });
    expect(get(cat).position.y).toBe(0);
    S().updateItem(tower, { hidden: false });
    expect(get(cat).supportSurfaceY).toBeCloseTo(0.945);
    expect(get(cat).position.y).toBeCloseTo(0.945);
  });
});

describe("hanging a floor lamp", () => {
  it("hangs its shade as a pendant on a cord (not an upright floor lamp floating in the air)", () => {
    const part = (y: number, sy: number, sx: number) => ({ kind: "cylinder" as const, center: { x: 0, y, z: 0 }, size: { x: sx, y: sy, z: sx } });
    const lamp = S().addItem({
      name: "Floor lamp",
      dims: { w: 0.4, h: 1.6, d: 0.4 },
      mount: "floor",
      color: "#f2e6c9",
      parts: [part(0.01, 0.02, 0.6), part(0.45, 0.86, 0.06), part(0.89, 0.2, 1)],
      origin: "shape",
    });
    const drop = S().hangFromCeiling(lamp)!;
    const l = get(lamp);
    expect(l.mount).toBe("ceiling");
    expect(drop).toBeCloseTo(2.44 - 1.9);
    expect(l.position.y).toBeCloseTo(1.9);
    // The shade (full width) at the bottom, plus a thin cord up to the ceiling; no base disc, no stem.
    expect(l.parts).toHaveLength(2);
    const shade = l.parts.find((p) => p.size.x === 1)!;
    expect(shade.center.y - shade.size.y / 2).toBeCloseTo(0, 3);
    expect(shade.size.y * l.dims.h).toBeCloseTo(0.32, 2);
    // One undo brings the floor lamp back as it was.
    S().undo();
    expect(get(lamp)).toMatchObject({ mount: "floor", dims: { h: 1.6 } });
    expect(get(lamp).parts).toHaveLength(3);
  });
});
