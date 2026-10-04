import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlacedItem, ProductCandidate } from "../shared/types";
import { defaultRoom, fullPart } from "../lib/presets";
import type { NewItemInput } from "./store";

// zustand's persist middleware writes to localStorage, which node doesn't have: stub it before importing the store.
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

const input = (name: string, w: number, h: number, d: number): NewItemInput => ({
  name,
  dims: { w, h, d },
  mount: "floor",
  color: "#888888",
  parts: [fullPart("box")],
  origin: "shape",
});

/** A desk at x = -1 and a monitor on it. */
function deskWithMonitor() {
  const desk = S().addItem(input("Desk", 1.2, 0.75, 0.6));
  S().updateItem(desk, { position: { x: -1, y: 0, z: 0 } });
  const mon = S().addItem(input("Monitor", 0.6, 0.4, 0.2));
  S().placeOnTop(mon, desk);
  return { desk, mon };
}

describe("placeOnTop", () => {
  it("centers the item on the support, at its top, turned like it, as one undo step", () => {
    const desk = S().addItem(input("Desk", 1.2, 0.75, 0.6));
    S().updateItem(desk, { position: { x: -1, y: 0, z: 0.5 }, rotationY: Math.PI / 2 });
    const mon = S().addItem(input("Monitor", 0.6, 0.4, 0.2));
    const steps = S().past.length;
    S().placeOnTop(mon, desk);
    const m = get(mon);
    expect(m.supportId).toBe(desk);
    expect(m.position).toEqual({ x: expect.closeTo(-1), y: expect.closeTo(0.75), z: expect.closeTo(0.5) });
    expect(m.rotationY).toBeCloseTo(Math.PI / 2);
    expect(S().past.length).toBe(steps + 1);
    S().undo();
    expect(get(mon).supportId).toBeUndefined();
    expect(get(mon).position.y).toBe(0);
  });

  it("makes a wall item a floor item on the support", () => {
    const desk = S().addItem(input("Desk", 1.2, 0.75, 0.6));
    const art = S().addItem({ ...input("Art", 0.3, 0.4, 0.05), mount: "wall" });
    S().placeOnTop(art, desk);
    expect(get(art).mount).toBe("floor");
    expect(get(art).position.y).toBeCloseTo(0.75);
  });

  it("never turns a ceiling item (a pendant) into a floor item: placeOnTop is a no-op for it (regression)", () => {
    // The owner's pendant showed Mount = Floor after being stacked: placeOnTop used to force mount "floor".
    const desk = S().addItem(input("Desk", 1.2, 0.75, 0.6));
    const lamp = S().addItem({ ...input("Pendant lamp", 0.3, 0.4, 0.3), mount: "ceiling" });
    const steps = S().past.length;
    S().placeOnTop(lamp, desk);
    expect(get(lamp).mount).toBe("ceiling");
    expect(get(lamp).supportId).toBeUndefined();
    expect(get(lamp).position.y).toBeCloseTo(S().room.height - 0.4);
    expect(S().past.length).toBe(steps);
  });

  it("refuses cycles, itself, hidden supports and unknown ids without an undo step", () => {
    const { desk, mon } = deskWithMonitor();
    const steps = S().past.length;
    S().placeOnTop(desk, mon);
    S().placeOnTop(desk, desk);
    S().placeOnTop(desk, "nope");
    S().placeOnTop("nope", desk);
    const box = S().addItem(input("Box", 0.3, 0.3, 0.3));
    S().updateItem(box, { hidden: true });
    const steps2 = S().past.length;
    S().placeOnTop(mon, box);
    expect(S().past.length).toBe(steps2);
    expect(steps2).toBe(steps + 2);
    expect(get(desk).supportId).toBeUndefined();
    expect(get(mon).supportId).toBe(desk);
  });

  it("refuses a support too small for the item (bed on a nightstand), like drag and the Put on… list", () => {
    const ns = S().addItem(input("Nightstand", 0.5, 0.6, 0.4));
    const bed = S().addItem(input("Bed", 1.6, 0.6, 2.1));
    const past = S().past.length;
    S().placeOnTop(bed, ns);
    expect(get(bed).supportId).toBeUndefined();
    expect(get(bed).position.y).toBe(0);
    expect(S().past).toHaveLength(past);
  });

  it("null puts it back on the floor in front of its support (not underneath it)", () => {
    const { desk, mon } = deskWithMonitor();
    S().placeOnTop(mon, null);
    const m = get(mon);
    expect(m.supportId).toBeUndefined();
    expect(m.position.y).toBe(0);
    expect(m.position.z).toBeGreaterThan(get(desk).position.z + 0.3);
  });
});

describe("a support carries its stack", () => {
  it("moving the desk (inspector X) moves the monitor with it, one undo step restores both", () => {
    const { desk, mon } = deskWithMonitor();
    const before = get(mon).position;
    S().updateItem(desk, { position: { ...get(desk).position, x: 0.5 } });
    expect(get(mon).position.x).toBeCloseTo(before.x + 1.5);
    expect(get(mon).position.y).toBeCloseTo(0.75);
    expect(get(mon).supportId).toBe(desk);
    S().undo();
    expect(get(desk).position.x).toBeCloseTo(-1);
    expect(get(mon).position.x).toBeCloseTo(before.x);
  });

  it("transient drags carry the stack every frame and checkpoint makes it one step", () => {
    const { desk, mon } = deskWithMonitor();
    S().checkpoint();
    const steps = S().past.length;
    for (let i = 1; i <= 5; i++) S().updateItem(desk, { position: { x: -1 + i * 0.1, y: 0, z: 0 } }, { transient: true });
    expect(S().past.length).toBe(steps);
    expect(get(mon).position.x).toBeCloseTo(-0.5);
    S().undo();
    expect(get(mon).position.x).toBeCloseTo(-1);
  });

  it("rotating the desk turns the monitor around it", () => {
    const { desk, mon } = deskWithMonitor();
    S().updateItem(mon, { position: { x: -0.6, y: 0.75, z: 0 } }); // 0.4 m right of the desk's center
    S().updateItem(desk, { rotationY: Math.PI / 2 });
    expect(get(mon).position.x).toBeCloseTo(-1);
    expect(get(mon).position.z).toBeCloseTo(-0.4);
    expect(get(mon).rotationY).toBeCloseTo(Math.PI / 2);
  });

  it("resizing the desk's height re-seats the monitor", () => {
    const { desk, mon } = deskWithMonitor();
    S().updateItem(desk, { dims: { w: 1.2, h: 0.9, d: 0.6 } });
    expect(get(mon).position.y).toBeCloseTo(0.9);
  });

  it("snapping the desk to a corner / wall carries the monitor", () => {
    const { desk, mon } = deskWithMonitor();
    S().snapItemToCornerAt(desk, "nw");
    expect(get(mon).position.x).toBeCloseTo(get(desk).position.x);
    expect(get(mon).position.z).toBeCloseTo(get(desk).position.z);
    S().snapItemToWall(desk);
    expect(get(mon).position.y).toBeCloseTo(0.75);
    expect(get(mon).supportId).toBe(desk);
  });

  it("changing the room keeps stacked items on their support", () => {
    const { desk, mon } = deskWithMonitor();
    S().updateRoom({ width: 2.4 });
    expect(get(mon).position.y).toBeCloseTo(0.75);
    expect(get(mon).position.x).toBeCloseTo(get(desk).position.x);
  });
});

describe("removing / hiding a support", () => {
  it("deleting the desk drops the monitor to the floor; undo restores both", () => {
    const { desk, mon } = deskWithMonitor();
    S().removeItem(desk);
    expect(get(mon).position.y).toBe(0);
    expect(get(mon).supportId).toBeUndefined();
    S().undo();
    expect(get(mon).supportId).toBe(desk);
    expect(get(mon).position.y).toBeCloseTo(0.75);
  });

  it("hiding and showing the bed leaves the rug under it on the floor (and showing the rug doesn't stack the bed)", () => {
    const rug = S().addItem(input("Rug", 2, 0.02, 2.3));
    const bed = S().addItem(input("Bed", 1.6, 0.6, 2.1));
    S().updateItem(rug, { position: { x: 0, y: 0, z: 0 } });
    S().updateItem(bed, { position: { x: 0, y: 0, z: 0 } });
    S().updateItem(bed, { hidden: true });
    S().updateItem(bed, { hidden: false });
    expect(get(rug).supportId).toBeUndefined();
    expect(get(rug).position.y).toBe(0);
    S().updateItem(rug, { hidden: true });
    S().updateItem(rug, { hidden: false });
    expect(get(bed).supportId).toBeUndefined();
    expect(get(bed).position.y).toBe(0);
  });

  it("taking an item off a stack puts it in front of the bottom of the stack", () => {
    const { desk, mon } = deskWithMonitor();
    const cup = S().addItem(input("Cup", 0.1, 0.1, 0.1));
    S().placeOnTop(cup, mon);
    expect(get(cup).supportId).toBe(mon);
    S().placeOnTop(cup, null);
    const d = get(desk);
    expect(get(cup).supportId).toBeUndefined();
    expect(get(cup).position.y).toBe(0);
    // In front of the desk (its +z side), not under it.
    expect(get(cup).position.z).toBeCloseTo(d.position.z + d.dims.d / 2 + 0.05 + 0.05, 6);
  });

  it("hiding the desk drops the monitor", () => {
    const { desk, mon } = deskWithMonitor();
    S().updateItem(desk, { hidden: true });
    expect(get(mon).supportId).toBeUndefined();
    expect(get(mon).position.y).toBe(0);
  });
});

describe("the stacked item itself", () => {
  it("nudging it within the desk keeps it stacked; moving it off drops it", () => {
    const { desk, mon } = deskWithMonitor();
    S().updateItem(mon, { position: { x: -0.7, y: 0, z: 0.1 } });
    expect(get(mon).supportId).toBe(desk);
    expect(get(mon).position.y).toBeCloseTo(0.75);
    S().updateItem(mon, { position: { x: 1, y: 0.75, z: 0 } });
    expect(get(mon).supportId).toBeUndefined();
    expect(get(mon).position.y).toBe(0);
  });

  it("an explicit supportId patch (drag) seats it; supportId: undefined puts it on the floor", () => {
    const desk = S().addItem(input("Desk", 1.2, 0.75, 0.6));
    const mon = S().addItem(input("Monitor", 0.6, 0.4, 0.2));
    S().updateItem(mon, { position: { x: 0.1, y: 0, z: 0 }, supportId: desk }, { transient: true });
    expect(get(mon).position.y).toBeCloseTo(0.75);
    S().updateItem(mon, { position: { x: 1.5, y: 0, z: 0 }, supportId: undefined }, { transient: true });
    expect(get(mon).position.y).toBe(0);
    expect("supportId" in get(mon)).toBe(false);
  });

  it("changing its mount to wall clears supportId", () => {
    const { mon } = deskWithMonitor();
    S().updateItem(mon, { mount: "wall" });
    expect(get(mon).supportId).toBeUndefined();
    expect(get(mon).mount).toBe("wall");
  });

  it("duplicating it keeps the copy on the same support while it is still over it", () => {
    const { desk, mon } = deskWithMonitor();
    const copy = S().duplicateItem(mon)!;
    expect(get(copy).supportId).toBe(desk);
    expect(get(copy).position.y).toBeCloseTo(0.75);
  });
});

describe("replacing a support with a product", () => {
  it("re-points what rested on it to the product", () => {
    const { desk, mon } = deskWithMonitor();
    const product: ProductCandidate = {
      id: "p1",
      name: "Real desk",
      retailer: "Shop",
      url: "https://example.com/desk",
      dims: { w: 1.4, h: 0.72, d: 0.7 },
      dimsSource: "listed",
      colors: [{ name: "Oak", hex: "#aa8855" }],
      style: [],
      materials: [],
      mount: "floor",
      parts: [fullPart("box")],
    };
    const id = S().replaceItemWithProduct(desk, product)!;
    expect(get(mon).supportId).toBe(id);
    expect(get(mon).position.y).toBeCloseTo(0.72);
  });
});

describe("loading plans", () => {
  it("importJSON keeps valid supports and drops dangling ones", () => {
    const desk: PlacedItem = {
      id: "d",
      name: "Desk",
      position: { x: 0, y: 0, z: 0 },
      rotationY: 0,
      dims: { w: 1.2, h: 0.75, d: 0.6 },
      color: "#888888",
      mount: "floor",
      parts: [fullPart("box")],
      origin: "shape",
    };
    const mon = { ...desk, id: "m", name: "Monitor", dims: { w: 0.6, h: 0.4, d: 0.2 }, position: { x: 0, y: 0.75, z: 0 }, supportId: "d" };
    const ghost = { ...desk, id: "g", name: "Ghost", position: { x: 1, y: 0.75, z: 1 }, supportId: "missing" };
    S().importJSON(JSON.stringify({ version: 1, room: defaultRoom(), items: [desk, mon, ghost] }));
    expect(get("m").supportId).toBe("d");
    expect(get("m").position.y).toBeCloseTo(0.75);
    expect(get("g").supportId).toBeUndefined();
    expect(get("g").position.y).toBe(0);
  });
});
