// Round 3 integration: a design version carries everything the other round-3 features add to the plan —
// lighting mode, window blinds, lamp settings, stacks on part surfaces (cat tower level, under a desk) and
// ceiling hangs — and restoring it brings all of it back (also through localStorage, as after a reload).
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlacedItem } from "../shared/types";
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

type Store = typeof import("./store");
type Versions = typeof import("./versions");
type Lighting = typeof import("./lightingActions");
let usePlanner: Store["usePlanner"];
let V: Versions;
let L: Lighting;
const S = () => usePlanner.getState();
const get = (id: string) => S().items.find((it) => it.id === id)!;

beforeAll(async () => {
  vi.stubGlobal("localStorage", storage);
  usePlanner = (await import("./store")).usePlanner;
  V = await import("./versions");
  L = await import("./lightingActions");
});

beforeEach(() => {
  memory.clear();
  const room = defaultRoom();
  room.openings = [
    ...room.openings,
    { id: "w-test", kind: "window", wall: "east", offset: 1, width: 1, height: 1.2, sill: 0.9 },
  ];
  usePlanner.setState({ room, items: [], selectedId: null, units: "metric", preview: null, previewTargetId: null, past: [], future: [] });
  V.useVersions.setState({ versions: [], storageNote: null });
  V.setThumbnailProvider(null);
});

const fromPreset = (key: string, name?: string): NewItemInput => {
  const p = SHAPE_PRESETS.find((x) => x.key === key)!;
  return { name: name ?? p.label, dims: { ...p.dims }, mount: p.mount, color: p.color, parts: p.parts, origin: "shape" };
};

const snapshot = (items: PlacedItem[]) =>
  items.map((it) => ({
    name: it.name,
    mount: it.mount,
    supportId: it.supportId,
    supportSurfaceY: it.supportSurfaceY,
    light: it.light,
    x: +it.position.x.toFixed(3),
    y: +it.position.y.toFixed(3),
    z: +it.position.z.toFixed(3),
    h: +it.dims.h.toFixed(3),
  }));

function buildDesign() {
  const desk = S().addItem(fromPreset("desk"));
  S().updateItem(desk, { position: { x: -1, y: 0, z: -1 } });
  const bin = S().addItem({ ...fromPreset("cylinder", "Bin"), dims: { w: 0.3, h: 0.35, d: 0.3 } });
  S().placeOnTop(bin, desk, 0);
  const tower = S().addItem(fromPreset("cattower"));
  const cat = S().addItem(fromPreset("cat"));
  S().placeOnTop(cat, tower, 0.945);
  const pendant = S().addItem(fromPreset("pendant"));
  S().hangFromCeiling(pendant, 0.5);
  S().updateItem(pendant, { light: { on: false, color: "#ffb070", intensity: 0.3 } });
  L.setLightingMode("evening");
  L.setWindowCovering("w-test", "closed");
  return { desk, bin, tower, cat, pendant };
}

describe("versions x lighting x stacking x ceiling", () => {
  // Review round 5: the lighting mode, blinds and lamp settings are how the room is viewed (README), so a restore brings
  // back the design (stacks, the hang) and keeps the view as it is now.
  it("restoring a version brings back surface stacks and the hang, and keeps the current mode, blinds and lamp settings", () => {
    const ids = buildDesign();
    expect(get(ids.bin)).toMatchObject({ supportId: ids.desk, supportSurfaceY: 0 });
    expect(get(ids.cat).supportSurfaceY).toBeCloseTo(0.945);
    expect(get(ids.pendant).mount).toBe("ceiling");
    const saved = { room: S().room, items: snapshot(S().items) };
    const v = V.useVersions.getState().saveVersion("Evening setup");

    // Change everything.
    L.setLightingMode("night");
    L.setWindowCovering("w-test", "open");
    S().updateItem(ids.pendant, { light: { on: true, color: "#ffffff", intensity: 1 } });
    S().placeOnTop(ids.cat, ids.tower); // top perch
    S().placeOnTop(ids.bin, null); // off to the floor
    S().removeItem(ids.desk);

    V.useVersions.getState().restoreVersion(v.id);
    expect(S().room.lighting).toBe("night");
    expect(S().room.openings.find((o) => o.id === "w-test")?.covering).toBe("open");
    const noLight = (rows: ReturnType<typeof snapshot>) => rows.map(({ light: _l, ...rest }) => rest);
    expect(noLight(snapshot(S().items))).toEqual(noLight(saved.items));
    expect(get(ids.pendant).light).toEqual({ on: true, color: "#ffffff", intensity: 1 });

    // One undo goes back to the changed design.
    S().undo();
    expect(S().room.lighting).toBe("night");
    expect(S().items.find((it) => it.id === ids.desk)).toBeUndefined();
  });

  it("a version saved before the mode was ever changed keeps the current mode too (not back to Day)", () => {
    S().addItem(fromPreset("desk"));
    expect(S().room.lighting).toBeUndefined();
    const v = V.useVersions.getState().saveVersion("Plain");
    L.setLightingMode("night");
    V.useVersions.getState().restoreVersion(v.id);
    expect(S().room.lighting).toBe("night");
  });

  it("versions read back from localStorage (after a reload) keep every round-3 field", async () => {
    const ids = buildDesign();
    const saved = snapshot(S().items);
    V.useVersions.getState().saveVersion("Persisted");
    const raw = JSON.parse(memory.get(V.VERSIONS_KEY)!);
    // Re-read through the module's own normalization, as a fresh page load does.
    vi.resetModules();
    const V2: Versions = await import("./versions");
    const S2 = (await import("./store")).usePlanner;
    const restored = V2.useVersions.getState().versions.find((x) => x.name === "Persisted");
    expect(raw.versions.length).toBeGreaterThan(0);
    expect(restored).toBeTruthy();
    expect(restored!.room.lighting).toBe("evening");
    expect(restored!.room.openings.find((o) => o.id === "w-test")?.covering).toBe("closed");
    const byId = new Map(restored!.items.map((it) => [it.id, it]));
    expect(byId.get(ids.bin)).toMatchObject({ supportId: ids.desk, supportSurfaceY: 0 });
    expect(byId.get(ids.cat)!.supportSurfaceY).toBeCloseTo(0.945);
    expect(byId.get(ids.pendant)!.light).toEqual({ on: false, color: "#ffb070", intensity: 0.3 });
    S2.setState({ room: defaultRoom(), items: [], past: [], future: [] });
    V2.useVersions.getState().restoreVersion(restored!.id);
    expect(snapshot(S2.getState().items)).toEqual(saved);
  });
});
