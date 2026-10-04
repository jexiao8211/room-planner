// Lighting through the chat executor and the store: modes, lamp lights (auto-assigned and changed), window blinds,
// one undo step per turn, and the plan file keeping all of it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAction, PlacedItem, ProductCandidate } from "../../shared/types";
import { SHAPE_PRESETS, defaultRoom } from "../../lib/presets";
import { DEFAULT_LIGHT, colorWarmth } from "../../lib/lighting";
import type { PlannerState } from "../../state/store";
import type * as ExecModule from "./executeActions";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

type StoreModule = typeof import("../../state/store");
let usePlanner: StoreModule["usePlanner"];
let X: typeof ExecModule;
let A: typeof import("../../state/lightingActions");
let V: typeof import("../../state/validate");
let B: typeof import("./buildScene");
const S = (): PlannerState => usePlanner.getState();
const byName = (name: string): PlacedItem => {
  const it = [...S().items].reverse().find((i) => i.name === name);
  if (!it) throw new Error(`no item ${name}`);
  return it;
};
const run = (actions: ChatAction[]) => X.executeActions(actions, { planner: usePlanner });
const preset = (key: string) => SHAPE_PRESETS.find((p) => p.key === key)!;
const addPreset = (key: string, name?: string) => {
  const p = preset(key);
  return S().addItem({ name: name ?? p.label, dims: p.dims, mount: p.mount, color: p.color, parts: p.parts, origin: "shape" });
};

beforeAll(async () => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  usePlanner = (await import("../../state/store")).usePlanner;
  X = await import("./executeActions");
  A = await import("../../state/lightingActions");
  V = await import("../../state/validate");
  B = await import("./buildScene");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  usePlanner.setState({ room: defaultRoom(), items: [], selectedId: null, past: [], future: [], preview: null, previewTargetId: null });
});

describe("store: lamps get a light automatically", () => {
  it("the Hanging lamp preset and lamp-named shapes do; a desk doesn't", () => {
    const pendant = addPreset("pendant");
    const desk = addPreset("desk");
    const lamp = S().addItem({ name: "Floor lamp", dims: { w: 0.4, h: 1.6, d: 0.4 }, mount: "floor", color: "#ffffff", parts: preset("cylinder").parts, origin: "shape" });
    const items = S().items;
    expect(items.find((it) => it.id === pendant)!.light).toEqual(DEFAULT_LIGHT);
    expect(items.find((it) => it.id === lamp)!.light).toEqual(DEFAULT_LIGHT);
    expect(items.find((it) => it.id === desk)!.light).toBeUndefined();
  });

  it("a lamp product does, and a lamp swapped for a product lamp keeps its settings", () => {
    const product: ProductCandidate = {
      id: "p1",
      name: "Akari 1A table lamp",
      retailer: "R",
      url: "https://example.com/a",
      dims: { w: 0.25, h: 0.45, d: 0.25 },
      dimsSource: "listed",
      colors: [{ name: "white", hex: "#ffffff" }],
      style: [],
      materials: [],
      mount: "floor",
      parts: [{ kind: "cylinder", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } }],
    };
    const id = S().addProduct(product);
    expect(byName("Akari 1A table lamp").light).toEqual(DEFAULT_LIGHT);
    expect(S().items.find((it) => it.id === id)?.light?.on).toBe(true);
    const old = addPreset("pendant");
    S().updateItem(old, { light: { on: false, color: "#c8dcff", intensity: 0.3 } });
    const swapped = S().replaceItemWithProduct(old, { ...product, id: "p2", name: "Paper pendant lamp", mount: "ceiling" })!;
    expect(S().items.find((it) => it.id === swapped)!.light).toEqual({ on: false, color: "#c8dcff", intensity: 0.3 });
    const box = S().addProduct({ ...product, id: "p3", name: "Oak side table" });
    expect(S().items.find((it) => it.id === box)!.light).toBeUndefined();
  });

  it("plans saved before lighting existed get lights for their lamps; lights, blinds and the mode survive a reload / import", () => {
    const file = {
      version: 1,
      room: { ...defaultRoom(), lighting: "night", openings: [{ ...defaultRoom().openings[1], covering: "closed" }, { ...defaultRoom().openings[0], covering: "closed" }] },
      items: [
        { id: "a", name: "Table lamp", position: { x: 0, y: 0, z: 0 }, rotationY: 0, dims: { w: 0.3, h: 0.5, d: 0.3 }, color: "#ffffff", mount: "floor", parts: [], origin: "shape" },
        { id: "b", name: "Box", position: { x: 1, y: 0, z: 0 }, rotationY: 0, dims: { w: 0.3, h: 0.5, d: 0.3 }, color: "#ffffff", mount: "floor", parts: [], origin: "shape", light: { on: false, color: "#C8DCFF", intensity: 0.4 } },
        { id: "c", name: "Desk", position: { x: -1, y: 0, z: 0 }, rotationY: 0, dims: { w: 1.2, h: 0.75, d: 0.6 }, color: "#ffffff", mount: "floor", parts: [], origin: "shape" },
      ],
    };
    const { room, items } = V.parsePlannerFile(JSON.stringify(file));
    expect(room.lighting).toBe("night");
    expect(room.openings.find((o) => o.kind === "window")!.covering).toBe("closed");
    expect(room.openings.find((o) => o.kind === "door")!.covering).toBeUndefined(); // doors have no blinds
    expect(items.find((it) => it.id === "a")!.light).toEqual(DEFAULT_LIGHT);
    expect(items.find((it) => it.id === "b")!.light).toEqual({ on: false, color: "#c8dcff", intensity: 0.4 });
    expect(items.find((it) => it.id === "c")!.light).toBeUndefined();
    expect(V.normalizeRoom({ ...defaultRoom(), lighting: "disco" })!.lighting).toBeUndefined();
    // Export → import round trip.
    S().replaceRoom(room, items);
    const again = V.parsePlannerFile(S().exportJSON());
    expect(again.room.lighting).toBe("night");
    expect(again.items.find((it) => it.id === "b")!.light).toEqual({ on: false, color: "#c8dcff", intensity: 0.4 });
  });
});

describe("store actions: lighting mode and blinds", () => {
  it("switches the mode and the blinds as undoable steps, and ignores no-op changes", () => {
    A.setLightingMode("evening");
    expect(S().room.lighting).toBe("evening");
    const steps = S().past.length;
    A.setLightingMode("evening");
    expect(S().past.length).toBe(steps);
    A.setWindowCovering("win_1", "closed");
    expect(S().room.openings.find((o) => o.id === "win_1")!.covering).toBe("closed");
    A.setWindowCovering("door_1", "closed");
    expect(S().room.openings.find((o) => o.id === "door_1")!.covering).toBeUndefined();
    S().undo();
    expect(S().room.openings.find((o) => o.id === "win_1")!.covering).toBeUndefined();
    S().undo();
    expect(S().room.lighting ?? "day").toBe("day");
  });

  it("a room built from photos (no mode of its own) keeps the current mode; a plan with one brings it", () => {
    A.setLightingMode("night");
    S().replaceRoom({ ...defaultRoom(), name: "From photos" }, []);
    expect(S().room.lighting).toBe("night");
    S().replaceRoom({ ...defaultRoom(), lighting: "evening" }, []);
    expect(S().room.lighting).toBe("evening");
  });
});

describe("chat executor: setLighting / setLight / setWindow", () => {
  it("makes it night, turns off the pendant, makes the lamp warmer and closes the blinds in ONE undo step", () => {
    const pendant = addPreset("pendant");
    const lamp = S().addItem({ name: "Table lamp", dims: { w: 0.3, h: 0.5, d: 0.3 }, mount: "floor", color: "#ffffff", parts: preset("cone").parts, origin: "shape" });
    usePlanner.setState({ past: [], future: [] });
    const out = run([
      { type: "setLighting", mode: "night" },
      { type: "setLight", itemId: pendant, on: false },
      { type: "setLight", itemId: "Table lamp", color: "#ffb062", intensity: 0.9 },
      { type: "setWindow", openingId: "*", covering: "closed" },
    ]);
    expect(out.results.map((r) => r.status)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(out.results.map((r) => r.label)).toEqual([
      "Lighting → Night",
      "Turned off Hanging lamp",
      "Table lamp: brighter (90%), warmer light",
      "Closed the blinds (window · north wall)",
    ]);
    expect(S().room.lighting).toBe("night");
    expect(S().items.find((it) => it.id === pendant)!.light!.on).toBe(false);
    const l = S().items.find((it) => it.id === lamp)!.light!;
    expect(l.intensity).toBe(0.9);
    expect(colorWarmth(l.color)).toBeGreaterThan(0.9);
    expect(S().room.openings.find((o) => o.kind === "window")!.covering).toBe("closed");
    // "it" now means the lamp.
    expect(S().selectedId).toBe(lamp);
    expect(S().past).toHaveLength(1);
    S().undo();
    expect(S().room.lighting ?? "day").toBe("day");
    expect(S().items.find((it) => it.id === pendant)!.light!.on).toBe(true);
    expect(S().room.openings.find((o) => o.kind === "window")!.covering).toBeUndefined();
  });

  it("reports no-ops as ok and bad targets as failed", () => {
    const desk = addPreset("desk");
    S().updateItem(desk, { hidden: true });
    const out = run([
      { type: "setLighting", mode: "day" },
      { type: "setWindow", openingId: "door_1", covering: "closed" },
      { type: "setWindow", openingId: "win_1", covering: "open" },
      { type: "setLight", itemId: "nope", on: true },
      { type: "setLight", itemId: desk, on: true },
    ]);
    expect(out.results.map((r) => r.status)).toEqual(["ok", "failed", "ok", "failed", "adjusted"]);
    expect(out.results[0].label).toContain("already Day");
    expect(out.results[1].error).toContain("door");
    expect(out.results[2].label).toContain("already open");
    // Giving a light to an item without one makes it a light source (here: hidden, so it says so).
    expect(out.results[4].label).toContain("now a light");
    expect(out.results[4].note).toContain("hidden");
    expect(S().items.find((it) => it.id === desk)!.light).toEqual({ ...DEFAULT_LIGHT, on: true });
  });

  it("the chat scene tells the model the mode, each light and closed blinds", () => {
    addPreset("pendant");
    A.setLightingMode("evening");
    A.setWindowCovering("win_1", "closed");
    const scene = B.buildChatScene(S());
    expect(scene.lighting).toBe("evening");
    expect(scene.items[0].light).toEqual(DEFAULT_LIGHT);
    expect(scene.room.openings.find((o) => o.id === "win_1")!.covering).toBe("closed");
    usePlanner.setState({ room: defaultRoom() });
    expect(B.buildChatScene(S()).lighting).toBe("day");
  });
});
