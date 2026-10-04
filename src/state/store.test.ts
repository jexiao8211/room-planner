import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlacedItem, ProductCandidate, Room } from "../shared/types";
import { defaultRoom, fullPart } from "../lib/presets";
import type { NewItemInput, PlannerState } from "./store";

// zustand's persist middleware writes to localStorage, which node doesn't have.
// Stub an in-memory implementation BEFORE the store module is imported.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
}

const PERSIST_KEY = "room-planner-v1";
const memory = new MemoryStorage();

type StoreModule = typeof import("./store");
let usePlanner: StoreModule["usePlanner"];
let selectSelectedItem: StoreModule["selectSelectedItem"];
const S = () => usePlanner.getState();

beforeAll(async () => {
  vi.stubGlobal("localStorage", memory);
  const mod = await import("./store");
  usePlanner = mod.usePlanner;
  selectSelectedItem = mod.selectSelectedItem;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  usePlanner.setState({
    room: defaultRoom(),
    items: [],
    selectedId: null,
    units: "imperial",
    preview: null,
    past: [],
    future: [],
  });
});

const box = (over: Partial<NewItemInput> = {}): NewItemInput => ({
  name: "Box",
  dims: { w: 0.5, h: 0.5, d: 0.5 },
  mount: "floor",
  color: "#8aa1b1",
  parts: [fullPart("box")],
  origin: "shape",
  ...over,
});

function candidate(over: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    id: "p1",
    name: "Paper lantern",
    retailer: "Shop",
    url: "https://example.com/lantern",
    price: 120,
    currency: "USD",
    dims: { w: 0.45, h: 0.6, d: 0.45 },
    dimsSource: "listed",
    colors: [
      { name: "White", hex: "#f5f2ea" },
      { name: "Black", hex: "#111111" },
    ],
    style: ["Japanese"],
    materials: ["paper"],
    mount: "ceiling",
    parts: [{ kind: "sphere", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } }],
    ...over,
  };
}

const itemById = (id: string) => S().items.find((it) => it.id === id)!;

describe("initial state", () => {
  it("opens on the default bedroom with no items", () => {
    expect(S().room).toEqual(defaultRoom());
    expect(S().items).toEqual([]);
    expect(S().units).toBe("imperial");
    expect(S().past).toEqual([]);
    expect(S().future).toEqual([]);
  });
});

describe("addItem", () => {
  it("adds at the room center on the floor, selects it and returns its id", () => {
    const id = S().addItem(box());
    expect(typeof id).toBe("string");
    expect(S().items).toHaveLength(1);
    const it1 = itemById(id);
    expect(it1.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(it1.rotationY).toBe(0);
    expect(it1.name).toBe("Box");
    expect(it1.origin).toBe("shape");
    expect(S().selectedId).toBe(id);
    expect(selectSelectedItem(S())).toBe(it1);
  });

  it("gives unique ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => S().addItem(box())));
    expect(ids.size).toBe(50);
  });

  it("hangs ceiling items from the ceiling and puts wall items on the north wall", () => {
    const lamp = S().addItem(box({ mount: "ceiling", dims: { w: 0.4, h: 0.9, d: 0.4 } }));
    expect(itemById(lamp).position.y).toBeCloseTo(S().room.height - 0.9, 9);
    const art = S().addItem(box({ mount: "wall", dims: { w: 0.8, h: 0.6, d: 0.04 } }));
    expect(itemById(art).position.z).toBeCloseTo(-S().room.depth / 2 + 0.02, 9);
  });

  it("creates one undo step", () => {
    S().addItem(box());
    expect(S().past).toHaveLength(1);
    expect(S().past[0].items).toEqual([]);
  });
});

describe("addProduct in a corner", () => {
  afterAll(() => usePlanner.setState({ placementHint: null }));
  it("goes to a free corner when the search asked for one", () => {
    usePlanner.setState({ placementHint: "corner" });
    const a = S().addProduct(candidate());
    const b = S().addProduct(candidate({ id: "p2" }));
    const room = S().room;
    expect(itemById(a).position.x).toBeLessThan(-room.width / 2 + 0.9);
    expect(itemById(a).position.z).toBeLessThan(-room.depth / 2 + 0.9);
    expect(itemById(b).position.x).toBeGreaterThan(room.width / 2 - 0.9); // next free corner: back-right
    usePlanner.setState({ placementHint: null });
    expect(itemById(S().addProduct(candidate({ id: "p3" }))).position.x).toBeCloseTo(0, 9);
  });
});

describe("addProduct", () => {
  it("uses the first color, the product's parts and origin 'product'", () => {
    const c = candidate();
    const id = S().addProduct(c);
    const it1 = itemById(id);
    expect(it1.color).toBe("#f5f2ea");
    expect(it1.parts).toEqual(c.parts);
    expect(it1.origin).toBe("product");
    expect(it1.product).toEqual(c);
    expect(it1.name).toBe("Paper lantern");
    expect(it1.dims).toEqual(c.dims);
    expect(it1.mount).toBe("ceiling");
    expect(it1.position.y).toBeCloseTo(S().room.height - 0.6, 9);
    expect(S().selectedId).toBe(id);
  });

  it("falls back to a grey full-size box when colors and parts are empty", () => {
    const id = S().addProduct(candidate({ colors: [], parts: [] }));
    const it1 = itemById(id);
    expect(it1.color).toBe("#999999");
    expect(it1.parts).toEqual([{ kind: "box", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } }]);
  });
});

describe("updateItem", () => {
  it("patches fields and records an undo step", () => {
    const id = S().addItem(box());
    S().updateItem(id, { name: "Crate", color: "#ff0000" });
    expect(itemById(id).name).toBe("Crate");
    expect(itemById(id).color).toBe("#ff0000");
    expect(S().past).toHaveLength(2);
  });

  it("re-constrains the position to the room", () => {
    const id = S().addItem(box());
    const { width, depth } = S().room;
    S().updateItem(id, { position: { x: 100, y: 3, z: -100 } });
    const p = itemById(id).position;
    expect(p.x).toBeCloseTo(width / 2 - 0.25, 9);
    expect(p.z).toBeCloseTo(-depth / 2 + 0.25, 9);
    expect(p.y).toBe(0);
  });

  it("re-constrains after a resize that would poke through a wall", () => {
    const id = S().addItem(box());
    S().updateItem(id, { position: { x: S().room.width / 2 - 0.25, y: 0, z: 0 } });
    S().updateItem(id, { dims: { w: 1.5, h: 0.5, d: 0.5 } });
    expect(itemById(id).position.x).toBeCloseTo(S().room.width / 2 - 0.75, 9);
  });

  it("re-applies the vertical rule when the mount changes", () => {
    const id = S().addItem(box());
    S().updateItem(id, { mount: "ceiling" });
    expect(itemById(id).position.y).toBeCloseTo(S().room.height - 0.5, 9);
    S().updateItem(id, { mount: "floor" });
    expect(itemById(id).position.y).toBe(0);
  });

  it("re-constrains after rotation using the rotated footprint", () => {
    const id = S().addItem(box({ dims: { w: 2, h: 0.5, d: 0.4 } }));
    const half = S().room.depth / 2;
    S().updateItem(id, { position: { x: 0, y: 0, z: half - 0.2 } });
    S().updateItem(id, { rotationY: Math.PI / 2 });
    expect(itemById(id).position.z).toBeCloseTo(half - 1, 9);
  });

  it("leaves other items untouched", () => {
    const a = S().addItem(box());
    const b = S().addItem(box());
    const before = itemById(b);
    S().updateItem(a, { name: "changed" });
    expect(itemById(b)).toBe(before);
  });

  it("clears the redo stack", () => {
    const id = S().addItem(box());
    S().updateItem(id, { name: "x" });
    S().undo();
    expect(S().future).toHaveLength(1);
    S().updateItem(id, { name: "y" });
    expect(S().future).toEqual([]);
  });
});

describe("transient updates and drag checkpoints", () => {
  it("transient updates don't create undo steps but are still constrained", () => {
    const id = S().addItem(box());
    const pastLen = S().past.length;
    for (let i = 0; i < 30; i++) S().updateItem(id, { position: { x: i * 0.1, y: 0, z: 0 } }, { transient: true });
    expect(S().past).toHaveLength(pastLen);
    expect(itemById(id).position.x).toBeCloseTo(S().room.width / 2 - 0.25, 9);
  });

  it("checkpoint + transient drag + undo restores the pre-drag state in one step", () => {
    const id = S().addItem(box());
    S().updateItem(id, { position: { x: -0.5, y: 0, z: 0.5 } });
    const preDrag = itemById(id).position;
    const pastLen = S().past.length;

    S().checkpoint();
    expect(S().past).toHaveLength(pastLen + 1);
    for (let i = 1; i <= 20; i++) S().updateItem(id, { position: { x: -0.5 + i * 0.05, y: 0, z: 0.5 - i * 0.02 } }, { transient: true });
    const postDrag = itemById(id).position;
    expect(postDrag).not.toEqual(preDrag);
    expect(S().past).toHaveLength(pastLen + 1);

    S().undo();
    expect(itemById(id).position).toEqual(preDrag);
    expect(S().past).toHaveLength(pastLen);

    S().redo();
    expect(itemById(id).position).toEqual(postDrag);
  });

  it("checkpoint clears the redo stack", () => {
    const id = S().addItem(box());
    S().updateItem(id, { name: "x" });
    S().undo();
    S().checkpoint();
    expect(S().future).toEqual([]);
  });
});

describe("removeItem", () => {
  it("removes the item and clears the selection if it was selected", () => {
    const a = S().addItem(box());
    const b = S().addItem(box());
    S().removeItem(b);
    expect(S().items.map((it) => it.id)).toEqual([a]);
    expect(S().selectedId).toBeNull();
  });

  it("keeps the selection when another item is removed", () => {
    const a = S().addItem(box());
    const b = S().addItem(box());
    S().select(a);
    S().removeItem(b);
    expect(S().selectedId).toBe(a);
  });

  it("is undoable", () => {
    const a = S().addItem(box());
    S().removeItem(a);
    S().undo();
    expect(S().items.map((it) => it.id)).toEqual([a]);
  });
});

describe("duplicateItem", () => {
  it("copies with a new id, '(copy)' suffix and a small offset, and selects the copy", () => {
    const a = S().addItem(box({ name: "Chair", color: "#123456" }));
    S().updateItem(a, { rotationY: 0.5 });
    const c = S().duplicateItem(a)!;
    expect(c).not.toBe(a);
    const src = itemById(a);
    const copy = itemById(c);
    expect(copy.name).toBe("Chair (copy)");
    expect(copy.color).toBe("#123456");
    expect(copy.rotationY).toBe(0.5);
    expect(copy.dims).toEqual(src.dims);
    expect(copy.position.x).toBeCloseTo(src.position.x + 0.3, 9);
    expect(copy.position.z).toBeCloseTo(src.position.z + 0.3, 9);
    expect(S().selectedId).toBe(c);
    expect(S().items).toHaveLength(2);
  });

  it("keeps the copy inside the room when the source is in a corner", () => {
    const a = S().addItem(box());
    S().snapItemToCorner(a);
    S().updateItem(a, { position: { x: 9, y: 0, z: 9 } });
    const c = S().duplicateItem(a)!;
    const { width, depth } = S().room;
    expect(itemById(c).position.x).toBeCloseTo(width / 2 - 0.25, 9);
    expect(itemById(c).position.z).toBeCloseTo(depth / 2 - 0.25, 9);
  });

  it("returns null for an unknown id without creating an undo step", () => {
    const len = S().past.length;
    expect(S().duplicateItem("nope")).toBeNull();
    expect(S().past).toHaveLength(len);
  });
});

describe("snapping actions", () => {
  it("snapItemToWall pushes the item to its nearest wall facing in", () => {
    const id = S().addItem(box({ dims: { w: 1, h: 0.5, d: 0.4 } }));
    S().updateItem(id, { position: { x: S().room.width / 2 - 0.6, y: 0, z: 0 }, rotationY: 0.2 });
    S().snapItemToWall(id);
    const it1 = itemById(id);
    expect(it1.rotationY).toBeCloseTo(-Math.PI / 2, 9);
    expect(it1.position.x).toBeCloseTo(S().room.width / 2 - 0.2, 9);
  });

  it("snapItemToCorner pushes into the nearest corner", () => {
    const id = S().addItem(box());
    S().updateItem(id, { position: { x: -0.3, y: 0, z: 0.3 } });
    S().snapItemToCorner(id);
    const p = itemById(id).position;
    expect(p.x).toBeCloseTo(-S().room.width / 2 + 0.25, 9);
    expect(p.z).toBeCloseTo(S().room.depth / 2 - 0.25, 9);
  });
});

describe("undo / redo", () => {
  it("walks back and forth through a sequence", () => {
    const a = S().addItem(box({ name: "A" }));
    S().updateItem(a, { name: "A2" });
    const b = S().addItem(box({ name: "B" }));
    S().removeItem(a);

    const names = () => S().items.map((it) => it.name);
    expect(names()).toEqual(["B"]);
    S().undo();
    expect(names()).toEqual(["A2", "B"]);
    S().undo();
    expect(names()).toEqual(["A2"]);
    S().undo();
    expect(names()).toEqual(["A"]);
    S().undo();
    expect(names()).toEqual([]);
    S().undo(); // nothing left: no-op
    expect(names()).toEqual([]);
    expect(S().future).toHaveLength(4);

    S().redo();
    expect(names()).toEqual(["A"]);
    S().redo();
    S().redo();
    expect(names()).toEqual(["A2", "B"]);
    S().redo();
    expect(names()).toEqual(["B"]);
    S().redo(); // nothing left: no-op
    expect(names()).toEqual(["B"]);
    expect(S().past).toHaveLength(4);
    expect(itemById(b).name).toBe("B");
  });

  it("drops the selection when undo removes the selected item", () => {
    const id = S().addItem(box());
    expect(S().selectedId).toBe(id);
    S().undo();
    expect(S().items).toEqual([]);
    expect(S().selectedId).toBeNull();
    expect(selectSelectedItem(S())).toBeUndefined();
  });

  it("keeps the selection when the selected item still exists after undo", () => {
    const id = S().addItem(box());
    S().updateItem(id, { name: "x" });
    S().undo();
    expect(S().selectedId).toBe(id);
  });

  it("undoes room changes", () => {
    S().updateRoom({ name: "Studio", width: 5 });
    S().undo();
    expect(S().room).toEqual(defaultRoom());
  });

  it("caps history at 100 steps", () => {
    const id = S().addItem(box());
    for (let i = 0; i < 150; i++) S().updateItem(id, { name: `n${i}` });
    expect(S().past).toHaveLength(100);
    for (let i = 0; i < 100; i++) S().undo();
    expect(itemById(id).name).toBe("n49");
    for (let i = 0; i < 100; i++) S().redo();
    expect(S().past).toHaveLength(100);
    expect(itemById(id).name).toBe("n149");
  });
});

describe("updateRoom", () => {
  it("patches fields", () => {
    S().updateRoom({ name: "Office", wallColor: "#ffffff" });
    expect(S().room.name).toBe("Office");
    expect(S().room.wallColor).toBe("#ffffff");
    expect(S().room.width).toBe(defaultRoom().width);
  });

  it("shrinking the room pulls items back inside", () => {
    const floor = S().addItem(box());
    S().updateItem(floor, { position: { x: 1.5, y: 0, z: 1.4 } });
    const lamp = S().addItem(box({ mount: "ceiling", dims: { w: 0.4, h: 0.9, d: 0.4 } }));
    const art = S().addItem(box({ mount: "wall", dims: { w: 0.8, h: 0.6, d: 0.04 } }));
    S().updateItem(art, { position: { x: 0, y: 1.8, z: -S().room.depth / 2 + 0.02 } });

    S().updateRoom({ width: 2, depth: 2, height: 2.2 });

    const f = itemById(floor).position;
    expect(f.x).toBeCloseTo(1 - 0.25, 9);
    expect(f.z).toBeCloseTo(1 - 0.25, 9);
    expect(itemById(lamp).position.y).toBeCloseTo(2.2 - 0.9, 9);
    const a = itemById(art).position;
    expect(a.y).toBeCloseTo(2.2 - 0.6, 9);
    expect(a.z).toBeCloseTo(-1 + 0.02, 9);
  });

  it("creates one undo step that restores items too", () => {
    const id = S().addItem(box());
    S().updateItem(id, { position: { x: 1.5, y: 0, z: 0 } });
    const before = itemById(id).position;
    const len = S().past.length;
    S().updateRoom({ width: 1 });
    expect(S().past).toHaveLength(len + 1);
    S().undo();
    expect(itemById(id).position).toEqual(before);
    expect(S().room.width).toBe(defaultRoom().width);
  });
});

describe("replaceRoom", () => {
  const room: Room = { ...defaultRoom(), name: "Scanned", width: 3, depth: 3, height: 2.5, openings: [] };
  const existing: PlacedItem = {
    id: "ex_1",
    name: "Dresser",
    position: { x: 5, y: 1, z: 0 },
    rotationY: 0,
    dims: { w: 1, h: 0.8, d: 0.5 },
    color: "#654321",
    mount: "floor",
    parts: [fullPart("box")],
    origin: "existing",
  };

  it("replaces room and items, constrains them and clears the selection", () => {
    S().addItem(box());
    S().replaceRoom(room, [existing]);
    expect(S().room).toEqual(room);
    expect(S().items).toHaveLength(1);
    expect(S().items[0].position).toEqual({ x: 1.5 - 0.5, y: 0, z: 0 });
    expect(S().selectedId).toBeNull();
  });

  it("keeps undo history", () => {
    const id = S().addItem(box());
    S().replaceRoom(room, [existing]);
    S().undo();
    expect(S().room).toEqual(defaultRoom());
    expect(S().items.map((it) => it.id)).toEqual([id]);
  });

  it("does not mutate the passed-in items", () => {
    S().replaceRoom(room, [existing]);
    expect(existing.position).toEqual({ x: 5, y: 1, z: 0 });
  });
});

describe("export / import", () => {
  it("round-trips room and items", () => {
    S().updateRoom({ name: "Den", width: 4.2, wallColor: "#abcdef" });
    const a = S().addItem(box({ name: "A" }));
    S().updateItem(a, { position: { x: 1, y: 0, z: -0.5 }, rotationY: 0.7 });
    S().addProduct(candidate());
    const json = S().exportJSON();
    const room = S().room;
    const items = S().items;

    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);

    S().resetAll();
    expect(S().items).toEqual([]);

    S().importJSON(json);
    expect(S().room).toEqual(room);
    expect(S().items).toEqual(items);
    expect(S().selectedId).toBeNull();
  });

  it("import is undoable", () => {
    const id = S().addItem(box());
    const json = JSON.stringify({ version: 1, room: { ...defaultRoom(), name: "Other" }, items: [] });
    S().importJSON(json);
    expect(S().room.name).toBe("Other");
    S().undo();
    expect(S().items.map((it) => it.id)).toEqual([id]);
  });

  it("fills in a missing openings list", () => {
    const { openings: _ignored, ...room } = defaultRoom();
    S().importJSON(JSON.stringify({ room, items: [] }));
    expect(S().room.openings).toEqual([]);
  });

  const bad: Array<[string, string]> = [
    ["malformed JSON", "{not json"],
    ["empty string", ""],
    ["null", "null"],
    ["a number", "42"],
    ["an array", "[]"],
    ["missing room", JSON.stringify({ items: [] })],
    ["missing items", JSON.stringify({ room: defaultRoom() })],
    ["items not an array", JSON.stringify({ room: defaultRoom(), items: {} })],
    ["room not an object", JSON.stringify({ room: "bedroom", items: [] })],
    ["room with non-numeric width", JSON.stringify({ room: { ...defaultRoom(), width: "12ft" }, items: [] })],
    ["room with zero height", JSON.stringify({ room: { ...defaultRoom(), height: 0 }, items: [] })],
    ["item without position", JSON.stringify({ room: defaultRoom(), items: [{ id: "x", dims: { w: 1, h: 1, d: 1 }, parts: [] }] })],
    [
      "item with bad dims",
      JSON.stringify({ room: defaultRoom(), items: [{ id: "x", position: { x: 0, y: 0, z: 0 }, dims: { w: -1, h: 1, d: 1 }, parts: [] }] }),
    ],
    ["item that is null", JSON.stringify({ room: defaultRoom(), items: [null] })],
  ];
  for (const [label, json] of bad) {
    it(`throws on ${label} and leaves state untouched`, () => {
      const id = S().addItem(box());
      const before = { room: S().room, items: S().items, past: S().past.length };
      expect(() => S().importJSON(json)).toThrow();
      expect(S().room).toBe(before.room);
      expect(S().items).toBe(before.items);
      expect(S().past).toHaveLength(before.past);
      expect(S().items[0].id).toBe(id);
    });
  }
});

describe("resetAll", () => {
  it("restores the default room, clears items, selection and preview, and is undoable", () => {
    S().updateRoom({ name: "Changed", width: 6 });
    const id = S().addItem(box());
    S().setPreview(candidate());
    S().setUnits("metric");

    S().resetAll();
    expect(S().room).toEqual(defaultRoom());
    expect(S().items).toEqual([]);
    expect(S().selectedId).toBeNull();
    expect(S().preview).toBeNull();
    expect(S().units).toBe("metric"); // units are a preference, not plan content

    S().undo();
    expect(S().room.name).toBe("Changed");
    expect(S().items.map((it) => it.id)).toEqual([id]);
  });
});

describe("simple setters", () => {
  it("select / setPreview / setUnits don't create undo steps", () => {
    const id = S().addItem(box());
    const len = S().past.length;
    S().select(null);
    S().select(id);
    S().setPreview(candidate());
    S().setPreview(null);
    S().setUnits("metric");
    expect(S().past).toHaveLength(len);
    expect(S().selectedId).toBe(id);
    expect(S().units).toBe("metric");
  });
});

describe("placement of new items", () => {
  it("doesn't stack a new floor item on top of one already at the center", () => {
    const a = S().addItem(box({ dims: { w: 1.6, h: 0.6, d: 2.1 } }));
    const b = S().addItem(box());
    const [A, B] = [itemById(a), itemById(b)];
    const overlapX = Math.abs(A.position.x - B.position.x) < (A.dims.w + B.dims.w) / 2 - 1e-6;
    const overlapZ = Math.abs(A.position.z - B.position.z) < (A.dims.d + B.dims.d) / 2 - 1e-6;
    expect(overlapX && overlapZ).toBe(false);
  });

  it("hangs new wall art beside the window instead of over it (default room)", () => {
    const id = S().addItem(box({ name: "Wall art", mount: "wall", dims: { w: 0.8, h: 0.6, d: 0.04 } }));
    const art = itemById(id);
    const win = S().room.openings.find((o) => o.kind === "window")!;
    const winX0 = -S().room.width / 2 + win.offset - win.width / 2;
    const winX1 = winX0 + win.width;
    const clear = art.position.x + 0.4 <= winX0 || art.position.x - 0.4 >= winX1 || art.position.y >= win.sill + win.height;
    expect(clear).toBe(true);
  });
});

describe("snapItemToCornerAt", () => {
  it("moves an item into the chosen corner in one undo step", () => {
    const id = S().addItem(box());
    const steps = S().past.length;
    S().snapItemToCornerAt(id, "ne");
    const p = itemById(id).position;
    expect(p.x).toBeCloseTo(S().room.width / 2 - 0.25, 9);
    expect(p.z).toBeCloseTo(-S().room.depth / 2 + 0.25, 9);
    expect(S().past).toHaveLength(steps + 1);
  });
});

describe("wall-mounted items stay on their wall", () => {
  const art = () => box({ name: "Wall art", mount: "wall", dims: { w: 0.8, h: 0.6, d: 0.04 } });

  it("a duplicate slides along the wall instead of floating 30 cm into the room", () => {
    const a = S().addItem(art());
    const c = S().duplicateItem(a)!;
    const [src, copy] = [itemById(a), itemById(c)];
    expect(copy.position.z).toBeCloseTo(src.position.z, 9);
    expect(copy.position.x).toBeCloseTo(src.position.x + 0.3, 9);
    expect(copy.rotationY).toBe(src.rotationY);
  });

  it("follows its wall when the room gets deeper", () => {
    const a = S().addItem(art());
    S().updateRoom({ depth: 4.5 });
    expect(itemById(a).position.z).toBeCloseTo(-4.5 / 2 + 0.02, 9);
  });

  it("switching an item to a wall mount hangs it on the nearest wall", () => {
    const id = S().addItem(box({ dims: { w: 0.6, h: 0.4, d: 0.1 } }));
    S().updateItem(id, { position: { x: S().room.width / 2 - 0.5, y: 0, z: 0.2 } });
    S().updateItem(id, { mount: "wall", position: { ...itemById(id).position, y: 1.2 } });
    const it1 = itemById(id);
    expect(it1.rotationY).toBeCloseTo(-Math.PI / 2, 9); // east wall, facing west
    expect(it1.position.x).toBeCloseTo(S().room.width / 2 - 0.05, 9);
    expect(it1.position.y).toBeCloseTo(1.2, 9);
  });

  it("stays on its wall when the room grows, even near a corner", () => {
    const a = S().addItem(art());
    const east = S().room.width / 2 - 0.4;
    S().updateItem(a, { position: { ...itemById(a).position, x: east } });
    S().updateRoom({ depth: 4.5 });
    expect(itemById(a).rotationY).toBe(0);
    expect(itemById(a).position.z).toBeCloseTo(-4.5 / 2 + 0.02, 9);
    expect(itemById(a).position.x).toBeCloseTo(east, 9);
  });

  it("items from photos/imports stay on the east or west wall they stand against, whatever their rotation", () => {
    const room = { ...defaultRoom(), width: 3.6, depth: 3.4 };
    const wallItem = (id: string, name: string, x: number, z: number, rotationY: number): PlacedItem => ({
      id,
      name,
      position: { x, y: 1, z },
      rotationY,
      dims: { w: 0.8, h: 0.6, d: 0.05 },
      color: "#333333",
      mount: "wall",
      parts: [fullPart("box")],
      origin: "existing",
    });
    S().replaceRoom(room, [
      wallItem("p", "Painting on east wall", 1.78, 0.3, 0),
      wallItem("t", "TV on west wall", -1.78, -0.5, 0),
      wallItem("m", "Mirror on east wall, flipped", 1.78, -0.6, Math.PI / 2),
    ]);
    const [p, t, m] = ["p", "t", "m"].map(itemById);
    expect(p.position.x).toBeCloseTo(1.8 - 0.025, 9);
    expect(p.position.z).toBeCloseTo(0.3, 9);
    expect(p.rotationY).toBeCloseTo(-Math.PI / 2, 9);
    expect(t.position.x).toBeCloseTo(-1.8 + 0.025, 9);
    expect(t.position.z).toBeCloseTo(-0.5, 9);
    expect(t.rotationY).toBeCloseTo(Math.PI / 2, 9);
    expect(m.position.x).toBeCloseTo(1.8 - 0.025, 9);
    expect(m.rotationY).toBeCloseTo(-Math.PI / 2, 9);
  });

  it("can't be turned off its wall", () => {
    const a = S().addItem(art());
    S().updateItem(a, { rotationY: Math.PI / 12 });
    expect(itemById(a).rotationY).toBe(0);
    expect(itemById(a).position.z).toBeCloseTo(-S().room.depth / 2 + 0.02, 9);
  });
});

describe("replaceItemWithProduct (placeholder → real product)", () => {
  beforeEach(() => usePlanner.setState({ previewTargetId: null }));

  it("swaps the placeholder for the product in the same spot, in one undo step", () => {
    const lamp = S().addItem(box({ name: "Hanging lamp", mount: "ceiling", dims: { w: 0.4, h: 0.9, d: 0.4 } }));
    S().snapItemToCornerAt(lamp, "nw");
    const spot = itemById(lamp).position;
    S().setPreviewTarget(lamp);
    S().setPreview(candidate());
    const steps = S().past.length;

    const id = S().replaceItemWithProduct(lamp, candidate())!;
    expect(S().items.some((it) => it.id === lamp)).toBe(false);
    const p = itemById(id);
    expect(p.origin).toBe("product");
    expect(p.product?.id).toBe("p1");
    expect(p.dims).toEqual(candidate().dims);
    expect(p.position.x).toBeCloseTo(spot.x, 9);
    expect(p.position.z).toBeCloseTo(spot.z, 9);
    expect(p.position.y).toBeCloseTo(S().room.height - 0.6, 9); // its own height, still touching the ceiling
    expect(S().selectedId).toBe(id);
    expect(S().preview).toBeNull();
    expect(S().previewTargetId).toBe(id); // keep comparing candidates in the same spot
    expect(S().past).toHaveLength(steps + 1);

    S().undo();
    expect(S().items.map((it) => it.id)).toEqual([lamp]);
  });

  it("a wall product replacing a floor placeholder hangs on the nearest wall", () => {
    const ph = S().addItem(box());
    S().updateItem(ph, { position: { x: 0, y: 0, z: S().room.depth / 2 - 0.4 } });
    const id = S().replaceItemWithProduct(ph, candidate({ mount: "wall", dims: { w: 0.6, h: 0.8, d: 0.03 } }))!;
    const p = itemById(id);
    expect(p.mount).toBe("wall");
    expect(p.rotationY).toBeCloseTo(Math.PI, 9); // south wall, facing north
    expect(p.position.z).toBeCloseTo(S().room.depth / 2 - 0.015, 9);
  });

  it("returns null for an unknown target", () => {
    expect(S().replaceItemWithProduct("nope", candidate())).toBeNull();
  });
});

describe("hanging products in a normal room", () => {
  it("a pendant listed with its maximum cord drop hangs at a normal height instead of sitting on the floor", () => {
    const parts = [
      { kind: "cylinder" as const, center: { x: 0, y: 0.995, z: 0 }, size: { x: 0.25, y: 0.01, z: 0.25 } },
      { kind: "cylinder" as const, center: { x: 0, y: 0.5545, z: 0 }, size: { x: 0.02, y: 0.871, z: 0.02 } },
      { kind: "sphere" as const, center: { x: 0, y: 0.06, z: 0 }, size: { x: 1, y: 0.12, z: 1 } },
    ];
    const id = S().addProduct(candidate({ dims: { w: 0.45, h: 3.3, d: 0.45 }, parts }));
    const it1 = itemById(id);
    expect(it1.position.y).toBeGreaterThan(1.8);
    expect(it1.position.y + it1.dims.h).toBeCloseTo(S().room.height, 9);
    expect(it1.product?.dims.h).toBe(3.3); // the listing itself is kept as-is
  });
});

describe("import / rehydration never let a malformed item reach the scene", () => {
  it("fills in rotation, mount and parts instead of producing NaN positions", () => {
    S().importJSON(JSON.stringify({ room: defaultRoom(), items: [{ id: "a", position: { x: 0, y: 0, z: 0 }, dims: { w: 1, h: 1, d: 1 }, parts: [{}] }] }));
    const it1 = itemById("a");
    expect(Number.isFinite(it1.position.x) && Number.isFinite(it1.position.z)).toBe(true);
    expect(it1.rotationY).toBe(0);
    expect(it1.mount).toBe("floor");
    expect(it1.parts).toHaveLength(1);
    expect(it1.parts[0].center).toBeDefined();
    expect(it1.parts[0].size).toBeDefined();
  });

  it("drops invalid stored items on reload instead of crashing every time", async () => {
    memory.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          room: defaultRoom(),
          units: "metric",
          items: [
            { id: "good", name: "Good", position: { x: 0, y: 0, z: 0 }, rotationY: 0, dims: { w: 1, h: 1, d: 1 }, color: "#ffffff", mount: "floor", parts: [], origin: "shape" },
            { id: "bad", position: { x: "a" }, dims: null },
            null,
          ],
        },
        version: 0,
      }),
    );
    vi.resetModules();
    const fresh = (await import("./store")).usePlanner;
    expect(fresh.getState().items.map((it) => it.id)).toEqual(["good"]);
    expect(fresh.getState().items[0].parts).toHaveLength(1);
    expect(fresh.getState().units).toBe("metric");
  });
});

describe("persistence (stubbed localStorage)", () => {
  it("writes room, items and units — but not history or selection — to localStorage", () => {
    const id = S().addItem(box({ name: "Saved" }));
    S().setUnits("metric");
    const raw = memory.getItem(PERSIST_KEY);
    expect(raw).not.toBeNull();
    const saved = JSON.parse(raw!) as { state: Partial<PlannerState> };
    expect(saved.state.items?.map((it) => it.id)).toEqual([id]);
    expect(saved.state.units).toBe("metric");
    expect(saved.state.room).toEqual(S().room);
    expect(saved.state).not.toHaveProperty("past");
    expect(saved.state).not.toHaveProperty("future");
    expect(saved.state).not.toHaveProperty("selectedId");
    expect(saved.state).not.toHaveProperty("preview");
  });

  it("rehydrates a fresh store from localStorage", async () => {
    const id = S().addItem(box({ name: "Persisted" }));
    S().updateRoom({ name: "Saved room" });
    vi.resetModules();
    const fresh = (await import("./store")).usePlanner;
    expect(fresh).not.toBe(usePlanner);
    expect(fresh.getState().room.name).toBe("Saved room");
    expect(fresh.getState().items.map((it) => it.id)).toEqual([id]);
    expect(fresh.getState().past).toEqual([]);
  });

  it("keeps working when localStorage throws (quota / blocked)", () => {
    const spy = vi.spyOn(memory, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      const id = S().addItem(box());
      expect(itemById(id)).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("without any localStorage (plain node)", () => {
  it("imports and works without crashing", async () => {
    vi.unstubAllGlobals();
    expect("localStorage" in globalThis && (globalThis as { localStorage?: unknown }).localStorage).toBeFalsy();
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = (await import("./store")).usePlanner;
      const st = store.getState;
      const id = st().addItem(box());
      st().updateItem(id, { name: "ok" });
      st().undo();
      expect(st().items[0].name).toBe("Box");
      expect(() => st().exportJSON()).not.toThrow();
    } finally {
      warn.mockRestore();
      vi.stubGlobal("localStorage", memory);
    }
  });
});
