import { describe, expect, it } from "vitest";
import { defaultPlacement as defaultPlacementForFull, footprintsOverlap as overlapsForFull, overlapArea } from "./geometry";
import type { Dims, Mount, PlacedItem, Room, WallSide } from "../shared/types";
import {
  attachToWall,
  constrainToRoom,
  cornerInset,
  coversOpening,
  defaultPlacement,
  describePlacement,
  fitHangingItem,
  MIN_HANGING_BOTTOM,
  nearestCorner,
  snapToCorner,
  TARGET_HANGING_BOTTOM,
  wallForItem,
  wallFromRotation,
  footprintHalfExtents,
  footprintsOverlap,
  freeCornerPlacement,
  placementForNewItem,
  nearestWall,
  rotationFacingAwayFrom,
  snapToNearestCorner,
  snapToNearestWall,
} from "./geometry";

// 4 m wide (x), 3 m deep (z), 2.5 m high.
const room: Room = {
  name: "Test",
  width: 4,
  depth: 3,
  height: 2.5,
  wallColor: "#ffffff",
  floorColor: "#000000",
  openings: [],
};

function item(over: Partial<PlacedItem> = {}): PlacedItem {
  return {
    id: "a",
    name: "A",
    position: { x: 0, y: 0, z: 0 },
    rotationY: 0,
    dims: { w: 1, h: 0.5, d: 0.4 },
    color: "#888888",
    mount: "floor",
    parts: [{ kind: "box", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } }],
    origin: "shape",
    ...over,
  };
}

const P = 9; // toBeCloseTo precision

describe("footprintHalfExtents", () => {
  const dims: Dims = { w: 2, h: 1, d: 1 };

  it("is half of w/d at 0°", () => {
    const e = footprintHalfExtents(dims, 0);
    expect(e.hx).toBeCloseTo(1, P);
    expect(e.hz).toBeCloseTo(0.5, P);
  });

  it("swaps w and d at ±90° and 270°", () => {
    for (const r of [Math.PI / 2, -Math.PI / 2, (3 * Math.PI) / 2]) {
      const e = footprintHalfExtents(dims, r);
      expect(e.hx).toBeCloseTo(0.5, P);
      expect(e.hz).toBeCloseTo(1, P);
    }
  });

  it("is unchanged at 180°", () => {
    const e = footprintHalfExtents(dims, Math.PI);
    expect(e.hx).toBeCloseTo(1, P);
    expect(e.hz).toBeCloseTo(0.5, P);
  });

  it("grows to the rotated bounding box at 45°", () => {
    const e = footprintHalfExtents(dims, Math.PI / 4);
    const expected = ((2 + 1) * Math.SQRT1_2) / 2;
    expect(e.hx).toBeCloseTo(expected, P);
    expect(e.hz).toBeCloseTo(expected, P);
  });

  it("ignores height", () => {
    expect(footprintHalfExtents({ w: 1, h: 99, d: 1 }, 0)).toEqual(footprintHalfExtents({ w: 1, h: 0.1, d: 1 }, 0));
  });
});

describe("constrainToRoom", () => {
  it("leaves an in-bounds floor item where it is (y = 0)", () => {
    const p = constrainToRoom(item({ position: { x: 0.5, y: 0, z: -0.3 } }), room);
    expect(p).toEqual({ x: 0.5, y: 0, z: -0.3 });
  });

  it("forces floor items onto the floor", () => {
    expect(constrainToRoom(item({ position: { x: 0, y: 1.2, z: 0 } }), room).y).toBe(0);
  });

  it("clamps x/z so the footprint stays inside the walls", () => {
    const p = constrainToRoom(item({ position: { x: 10, y: 0, z: -10 } }), room);
    expect(p.x).toBeCloseTo(2 - 0.5, P);
    expect(p.z).toBeCloseTo(-1.5 + 0.2, P);
    const q = constrainToRoom(item({ position: { x: -10, y: 0, z: 10 } }), room);
    expect(q.x).toBeCloseTo(-2 + 0.5, P);
    expect(q.z).toBeCloseTo(1.5 - 0.2, P);
  });

  it("uses the rotated footprint when clamping", () => {
    const p = constrainToRoom(item({ position: { x: 10, y: 0, z: 10 }, rotationY: Math.PI / 2 }), room);
    expect(p.x).toBeCloseTo(2 - 0.2, P);
    expect(p.z).toBeCloseTo(1.5 - 0.5, P);
  });

  it("hangs ceiling items from the ceiling regardless of the requested y", () => {
    const it1 = item({ mount: "ceiling", dims: { w: 0.4, h: 0.9, d: 0.4 }, position: { x: 0, y: 0, z: 0 } });
    expect(constrainToRoom(it1, room).y).toBeCloseTo(2.5 - 0.9, P);
    expect(constrainToRoom({ ...it1, position: { x: 0, y: 5, z: 0 } }, room).y).toBeCloseTo(1.6, P);
  });

  it("keeps an oversize ceiling item at y = 0 rather than below the floor", () => {
    const p = constrainToRoom(item({ mount: "ceiling", dims: { w: 0.4, h: 3, d: 0.4 } }), room);
    expect(p.y).toBe(0);
  });

  it("keeps wall items between floor and ceiling", () => {
    const base = item({ mount: "wall", dims: { w: 0.8, h: 0.6, d: 0.04 } });
    expect(constrainToRoom({ ...base, position: { x: 0, y: 1.2, z: 0 } }, room).y).toBeCloseTo(1.2, P);
    expect(constrainToRoom({ ...base, position: { x: 0, y: -1, z: 0 } }, room).y).toBe(0);
    expect(constrainToRoom({ ...base, position: { x: 0, y: 5, z: 0 } }, room).y).toBeCloseTo(2.5 - 0.6, P);
  });

  it("puts a wall item taller than the room on the floor (never below it)", () => {
    const p = constrainToRoom(item({ mount: "wall", dims: { w: 0.8, h: 3, d: 0.04 }, position: { x: 0, y: 1, z: 0 } }), room);
    expect(p.y).toBe(0);
  });

  it("centers an item that is wider/deeper than the room on that axis", () => {
    const p = constrainToRoom(item({ dims: { w: 6, h: 1, d: 5 }, position: { x: 1, y: 0, z: -1 } }), room);
    expect(p.x).toBeCloseTo(0, P);
    expect(p.z).toBeCloseTo(0, P);
  });

  it("centers an oversize axis but still clamps the other axis", () => {
    const p = constrainToRoom(item({ dims: { w: 6, h: 1, d: 0.4 }, position: { x: 1, y: 0, z: 9 } }), room);
    expect(p.x).toBeCloseTo(0, P);
    expect(p.z).toBeCloseTo(1.5 - 0.2, P);
  });

  it("allows an item exactly as wide as the room", () => {
    const p = constrainToRoom(item({ dims: { w: 4, h: 1, d: 1 }, position: { x: 0.7, y: 0, z: 0 } }), room);
    expect(p.x).toBeCloseTo(0, P);
  });

  it("does not mutate its input", () => {
    const it1 = item({ position: { x: 10, y: 3, z: 10 } });
    constrainToRoom(it1, room);
    expect(it1.position).toEqual({ x: 10, y: 3, z: 10 });
  });
});

describe("nearestWall", () => {
  it("finds each wall", () => {
    expect(nearestWall({ x: 0, z: -1.4 }, room)).toBe("north");
    expect(nearestWall({ x: 0, z: 1.4 }, room)).toBe("south");
    expect(nearestWall({ x: -1.9, z: 0 }, room)).toBe("west");
    expect(nearestWall({ x: 1.9, z: 0 }, room)).toBe("east");
  });

  it("picks the closer wall near a corner", () => {
    expect(nearestWall({ x: 1.95, z: -1.3 }, room)).toBe("east"); // 0.05 from east, 0.2 from north
    expect(nearestWall({ x: 1.7, z: -1.45 }, room)).toBe("north"); // 0.05 from north, 0.3 from east
  });

  it("is deterministic on ties and in the center", () => {
    // Center of a 4×3 room is 1.5 from north/south, 2 from east/west.
    expect(nearestWall({ x: 0, z: 0 }, room)).toBe("north");
  });

  it("handles points outside the room", () => {
    expect(nearestWall({ x: 0, z: -5 }, room)).toBe("north");
    expect(nearestWall({ x: 7, z: 0 }, room)).toBe("east");
  });
});

describe("rotationFacingAwayFrom", () => {
  // Rotating the local +z (front) vector by rotationY about Y gives (sin r, cos r) in x/z.
  const front = (r: number) => ({ x: Math.sin(r), z: Math.cos(r) });
  const inward: Record<WallSide, { x: number; z: number }> = {
    north: { x: 0, z: 1 },
    south: { x: 0, z: -1 },
    west: { x: 1, z: 0 },
    east: { x: -1, z: 0 },
  };
  for (const wall of Object.keys(inward) as WallSide[]) {
    it(`points the front into the room from the ${wall} wall`, () => {
      const f = front(rotationFacingAwayFrom(wall));
      expect(f.x).toBeCloseTo(inward[wall].x, P);
      expect(f.z).toBeCloseTo(inward[wall].z, P);
    });
  }
});

describe("snapToNearestWall", () => {
  // Deep, non-square item so rotation matters: 1.0 wide, 0.4 deep.
  const dims: Dims = { w: 1, h: 0.8, d: 0.4 };

  const cases: Array<{ wall: WallSide; start: { x: number; z: number }; rot: number }> = [
    { wall: "north", start: { x: 0.3, z: -1.0 }, rot: 0 },
    { wall: "south", start: { x: -0.3, z: 1.0 }, rot: Math.PI },
    { wall: "west", start: { x: -1.6, z: 0.2 }, rot: Math.PI / 2 },
    { wall: "east", start: { x: 1.6, z: -0.2 }, rot: -Math.PI / 2 },
  ];

  for (const c of cases) {
    it(`puts the back flush to the ${c.wall} wall, facing in`, () => {
      const src = item({ dims, position: { x: c.start.x, y: 0, z: c.start.z }, rotationY: 0.3 });
      const { position, rotationY } = snapToNearestWall(src, room);
      expect(rotationY).toBeCloseTo(c.rot, P);

      // The back (local -z face) lies on the wall: the item's center is d/2 from the wall.
      const half = dims.d / 2;
      switch (c.wall) {
        case "north":
          expect(position.z).toBeCloseTo(-room.depth / 2 + half, P);
          expect(position.x).toBeCloseTo(c.start.x, P); // slides only toward the wall
          break;
        case "south":
          expect(position.z).toBeCloseTo(room.depth / 2 - half, P);
          expect(position.x).toBeCloseTo(c.start.x, P);
          break;
        case "west":
          expect(position.x).toBeCloseTo(-room.width / 2 + half, P);
          expect(position.z).toBeCloseTo(c.start.z, P);
          break;
        case "east":
          expect(position.x).toBeCloseTo(room.width / 2 - half, P);
          expect(position.z).toBeCloseTo(c.start.z, P);
          break;
      }

      // Back face in world space: center minus the rotated front vector × d/2.
      const back = { x: position.x - Math.sin(rotationY) * half, z: position.z - Math.cos(rotationY) * half };
      if (c.wall === "north") expect(back.z).toBeCloseTo(-room.depth / 2, P);
      if (c.wall === "south") expect(back.z).toBeCloseTo(room.depth / 2, P);
      if (c.wall === "west") expect(back.x).toBeCloseTo(-room.width / 2, P);
      if (c.wall === "east") expect(back.x).toBeCloseTo(room.width / 2, P);
    });
  }

  it("keeps the item inside the room along the wall", () => {
    const src = item({ dims, position: { x: 1.9, y: 0, z: -1.45 } }); // nearest: north
    const { position } = snapToNearestWall(src, room);
    expect(position.z).toBeCloseTo(-1.5 + 0.2, P);
    expect(position.x).toBeCloseTo(2 - 0.5, P);
  });

  it("keeps a wall-mounted item's height", () => {
    const src = item({ mount: "wall", dims: { w: 0.8, h: 0.6, d: 0.04 }, position: { x: 1.8, y: 1.3, z: 0 } });
    const { position, rotationY } = snapToNearestWall(src, room);
    expect(rotationY).toBeCloseTo(-Math.PI / 2, P);
    expect(position.x).toBeCloseTo(2 - 0.02, P);
    expect(position.y).toBeCloseTo(1.3, P);
  });

  it("does not mutate the input item", () => {
    const src = item({ dims, position: { x: 0, y: 0, z: -1 } });
    snapToNearestWall(src, room);
    expect(src.position).toEqual({ x: 0, y: 0, z: -1 });
    expect(src.rotationY).toBe(0);
  });
});

describe("snapToNearestCorner", () => {
  const dims: Dims = { w: 1, h: 0.5, d: 0.4 };
  const corners: Array<[string, { x: number; z: number }, { x: number; z: number }]> = [
    ["north-west", { x: -0.5, z: -0.5 }, { x: -2 + 0.5, z: -1.5 + 0.2 }],
    ["north-east", { x: 0.5, z: -0.5 }, { x: 2 - 0.5, z: -1.5 + 0.2 }],
    ["south-west", { x: -0.5, z: 0.5 }, { x: -2 + 0.5, z: 1.5 - 0.2 }],
    ["south-east", { x: 0.5, z: 0.5 }, { x: 2 - 0.5, z: 1.5 - 0.2 }],
  ];
  for (const [name, start, expected] of corners) {
    it(`pushes into the ${name} corner`, () => {
      const { position } = snapToNearestCorner(item({ dims, position: { ...start, y: 0 } }), room);
      expect(position.x).toBeCloseTo(expected.x, P);
      expect(position.z).toBeCloseTo(expected.z, P);
      expect(position.y).toBe(0);
    });
  }

  it("uses the rotated footprint", () => {
    const { position } = snapToNearestCorner(item({ dims, rotationY: Math.PI / 2, position: { x: 0.5, y: 0, z: 0.5 } }), room);
    expect(position.x).toBeCloseTo(2 - 0.2, P);
    expect(position.z).toBeCloseTo(1.5 - 0.5, P);
  });

  it("keeps the mount's vertical rule (ceiling) and keeps a hanging lamp 30 cm off both walls", () => {
    const { position } = snapToNearestCorner(
      item({ mount: "ceiling", dims: { w: 0.4, h: 0.9, d: 0.4 }, position: { x: 1, y: 1.6, z: 1 } }),
      room,
    );
    expect(position.y).toBeCloseTo(1.6, P);
    expect(position.x).toBeCloseTo(2 - 0.2 - 0.3, P);
    expect(position.z).toBeCloseTo(1.5 - 0.2 - 0.3, P);
  });

  it("sends a centered item to the back-left (north-west) corner, not the cut-away one by the camera", () => {
    expect(nearestCorner({ x: 0, z: 0 })).toBe("nw");
    const { position } = snapToNearestCorner(item({ dims, position: { x: 0, y: 0, z: 0 } }), room);
    expect(position.x).toBeCloseTo(-2 + 0.5, P);
    expect(position.z).toBeCloseTo(-1.5 + 0.2, P);
  });
});

describe("defaultPlacement", () => {
  it("puts floor items at the room center on the floor", () => {
    const r = defaultPlacement({ w: 1, h: 1, d: 1 }, "floor", room);
    expect(r.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(r.rotationY).toBe(0);
  });

  it("hangs ceiling items from the ceiling at the center", () => {
    const r = defaultPlacement({ w: 0.4, h: 0.9, d: 0.4 }, "ceiling", room);
    expect(r.position.x).toBe(0);
    expect(r.position.z).toBe(0);
    expect(r.position.y).toBeCloseTo(2.5 - 0.9, P);
  });

  it("puts wall items flush against the north wall at ~1.5 m", () => {
    const dims: Dims = { w: 0.8, h: 0.6, d: 0.04 };
    const r = defaultPlacement(dims, "wall", room);
    expect(r.rotationY).toBe(0);
    expect(r.position.x).toBe(0);
    expect(r.position.z).toBeCloseTo(-room.depth / 2 + dims.d / 2, P);
    expect(r.position.y).toBeCloseTo(1.5, P);
  });

  it("lowers a tall wall item so it fits under the ceiling", () => {
    const r = defaultPlacement({ w: 0.8, h: 1.8, d: 0.04 }, "wall", room);
    expect(r.position.y).toBeCloseTo(2.5 - 1.8, P);
  });

  it("puts a wall item taller than the room on the floor", () => {
    const r = defaultPlacement({ w: 0.8, h: 3, d: 0.04 }, "wall", room);
    expect(r.position.y).toBe(0);
  });

  it("centers an oversize floor item", () => {
    const r = defaultPlacement({ w: 9, h: 1, d: 9 }, "floor", room);
    expect(r.position.x).toBeCloseTo(0, P);
    expect(r.position.z).toBeCloseTo(0, P);
  });

  it.each<Mount>(["floor", "wall", "ceiling"])("result for %s is already constrained", (mount) => {
    const dims: Dims = { w: 0.5, h: 0.5, d: 0.5 };
    const r = defaultPlacement(dims, mount, room);
    expect(constrainToRoom({ position: r.position, dims, rotationY: r.rotationY, mount }, room)).toEqual(r.position);
  });
});

describe("footprintsOverlap", () => {
  const a = item({ id: "a", dims: { w: 1, h: 1, d: 1 }, position: { x: 0, y: 0, z: 0 } });

  it("detects overlapping footprints", () => {
    expect(footprintsOverlap(a, item({ id: "b", dims: { w: 1, h: 1, d: 1 }, position: { x: 0.5, y: 0, z: 0.5 } }))).toBe(true);
  });

  it("is symmetric", () => {
    const b = item({ id: "b", dims: { w: 1, h: 1, d: 1 }, position: { x: 0.9, y: 0, z: 0 } });
    expect(footprintsOverlap(a, b)).toBe(footprintsOverlap(b, a));
  });

  it("treats touching edges as not overlapping", () => {
    expect(footprintsOverlap(a, item({ id: "b", dims: { w: 1, h: 1, d: 1 }, position: { x: 1, y: 0, z: 0 } }))).toBe(false);
    expect(footprintsOverlap(a, item({ id: "b", dims: { w: 1, h: 1, d: 1 }, position: { x: 0, y: 0, z: 1 } }))).toBe(false);
  });

  it("detects separation along either axis", () => {
    expect(footprintsOverlap(a, item({ id: "b", dims: { w: 1, h: 1, d: 1 }, position: { x: 1.5, y: 0, z: 0 } }))).toBe(false);
    expect(footprintsOverlap(a, item({ id: "b", dims: { w: 1, h: 1, d: 1 }, position: { x: 0, y: 0, z: -1.5 } }))).toBe(false);
  });

  it("uses rotated extents", () => {
    const long = item({ id: "b", dims: { w: 2, h: 1, d: 0.2 }, position: { x: 0, y: 0, z: 1.2 } });
    expect(footprintsOverlap(a, long)).toBe(false);
    expect(footprintsOverlap(a, { ...long, rotationY: Math.PI / 2 })).toBe(true);
  });

  it("does not overlap when stacked vertically (lamp above a table)", () => {
    const lamp = item({ id: "lamp", mount: "ceiling", dims: { w: 0.4, h: 0.9, d: 0.4 }, position: { x: 0, y: 1.6, z: 0 } });
    expect(footprintsOverlap(a, lamp)).toBe(false);
    expect(footprintsOverlap(a, { ...lamp, position: { x: 0, y: 0.9, z: 0 } })).toBe(true);
  });

  it("detects containment", () => {
    expect(footprintsOverlap(a, item({ id: "b", dims: { w: 0.2, h: 0.2, d: 0.2 }, position: { x: 0.1, y: 0.2, z: -0.1 } }))).toBe(true);
  });
});

describe("snapToCorner (corner picker)", () => {
  const dims: Dims = { w: 1, h: 0.5, d: 0.4 };
  it.each<["nw" | "ne" | "sw" | "se", number, number]>([
    ["nw", -1.5, -1.3],
    ["ne", 1.5, -1.3],
    ["sw", -1.5, 1.3],
    ["se", 1.5, 1.3],
  ])("puts furniture flush into the %s corner", (corner, x, z) => {
    const { position } = snapToCorner(item({ dims, position: { x: 1, y: 0, z: 1 } }), room, corner);
    expect(position.x).toBeCloseTo(x, P);
    expect(position.z).toBeCloseTo(z, P);
  });

  it("insets lamps from the walls (ceiling and floor lamps), not other furniture", () => {
    expect(cornerInset({ mount: "ceiling", name: "Washi pendant" })).toBe(0.3);
    expect(cornerInset({ mount: "floor", name: "Paper Column Floor Lamp" })).toBe(0.3);
    expect(cornerInset({ mount: "floor", name: "Nightstand" })).toBe(0);
    const lamp = item({ mount: "ceiling", name: "Pendant", dims: { w: 0.4, h: 0.9, d: 0.4 } });
    const { position } = snapToCorner(lamp, room, "nw");
    expect(position.x).toBeCloseTo(-2 + 0.2 + 0.3, P);
    expect(position.z).toBeCloseTo(-1.5 + 0.2 + 0.3, P);
    expect(position.y).toBeCloseTo(2.5 - 0.9, P);
  });
});

describe("defaultPlacement with existing items (free spot)", () => {
  const bed = item({ id: "bed", dims: { w: 1.6, h: 0.9, d: 2.1 }, position: { x: -0.2, y: 0, z: -0.45 } });

  it("does not bury a new floor item inside furniture at the center", () => {
    const dims: Dims = { w: 0.5, h: 0.6, d: 0.4 };
    const r = defaultPlacement(dims, "floor", room, [bed]);
    expect(footprintsOverlap(item({ id: "new", dims, position: r.position }), bed)).toBe(false);
    // ...and it is a spot near the center, inside the room.
    expect(Math.hypot(r.position.x, r.position.z)).toBeLessThan(1.5);
  });

  it("ignores hidden items", () => {
    const r = defaultPlacement({ w: 0.5, h: 0.6, d: 0.4 }, "floor", room, [{ ...bed, hidden: true }]);
    expect(r.position).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("a ceiling item only avoids things that reach up to it", () => {
    const lamp: Dims = { w: 0.4, h: 0.6, d: 0.4 };
    expect(defaultPlacement(lamp, "ceiling", room, [bed]).position.x).toBe(0);
    const other = item({ id: "l1", mount: "ceiling", dims: lamp, position: { x: 0, y: 1.9, z: 0 } });
    const r = defaultPlacement(lamp, "ceiling", room, [other]);
    expect(footprintsOverlap(item({ id: "l2", mount: "ceiling", dims: lamp, position: r.position }), other)).toBe(false);
  });
});

describe("wall items keep clear of openings", () => {
  const withWindow: Room = {
    ...room,
    openings: [{ id: "w", kind: "window", wall: "north", offset: 2, width: 1.2, height: 1.2, sill: 0.9 }],
  };
  const art: Dims = { w: 0.8, h: 0.6, d: 0.04 };

  it("coversOpening detects overlap with a window", () => {
    expect(coversOpening("north", 0, 1.5, art, withWindow)).toBe(true);
    expect(coversOpening("north", 1.5, 1.5, art, withWindow)).toBe(false);
    expect(coversOpening("west", 0, 1.5, art, withWindow)).toBe(false);
  });

  it("a new wall item does not land on the window in the middle of the north wall", () => {
    const r = defaultPlacement(art, "wall", withWindow);
    expect(r.position.z).toBeCloseTo(-1.5 + 0.02, P); // still on the north wall
    expect(coversOpening("north", r.position.x, r.position.y, art, withWindow)).toBe(false);
    expect(Math.abs(r.position.x)).toBeLessThanOrEqual(2 - 0.4 + 1e-9);
  });

  it("moves to the next wall when the north wall is full", () => {
    const full: Room = { ...withWindow, openings: [{ id: "w", kind: "window", wall: "north", offset: 2, width: 3.9, height: 1.2, sill: 0.9 }] };
    const r = defaultPlacement(art, "wall", full);
    expect(r.rotationY).toBeCloseTo(Math.PI / 2, P); // west wall, facing east into the room
    expect(r.position.x).toBeCloseTo(-2 + 0.02, P);
  });

  it("avoids other wall items", () => {
    const first = defaultPlacement(art, "wall", room);
    const placed = item({ id: "a1", mount: "wall", dims: art, position: first.position, rotationY: first.rotationY });
    const second = defaultPlacement(art, "wall", room, [placed]);
    const probe = item({ id: "a2", mount: "wall", dims: art, position: second.position, rotationY: second.rotationY });
    expect(footprintsOverlap(probe, placed)).toBe(false);
  });
});

describe("attachToWall", () => {
  const art = item({ mount: "wall", dims: { w: 0.8, h: 0.6, d: 0.04 }, position: { x: 0.5, y: 1.4, z: 0.3 }, rotationY: 0 });

  it("keeps a wall item flush with the wall its rotation faces away from", () => {
    expect(wallFromRotation(0)).toBe("north");
    expect(wallFromRotation(Math.PI / 2)).toBe("west");
    expect(wallFromRotation(0.3)).toBeNull();
    // Off its wall (e.g. after a resize), on the north half of the room: pushed back flush against the north wall.
    const { position, rotationY } = attachToWall({ ...art, position: { ...art.position, z: -0.3 } }, room);
    expect(position.x).toBeCloseTo(0.5, P);
    expect(position.y).toBeCloseTo(1.4, P);
    expect(position.z).toBeCloseTo(-1.5 + 0.02, P);
    expect(rotationY).toBe(0);
  });

  it("trusts the position over a rotation that names a far wall (photo estimates)", () => {
    const tv = { position: { x: 1.97, y: 1, z: 0.2 }, dims: { w: 1, h: 0.6, d: 0.06 } };
    // Against the east wall, but with the default rotation 0 (north) or the wrong sign (west).
    for (const rotationY of [0, Math.PI / 2]) {
      expect(wallForItem({ ...tv, rotationY }, room)).toBe("east");
      const placed = attachToWall({ ...tv, rotationY }, room);
      expect(placed.rotationY).toBeCloseTo(-Math.PI / 2, P);
      expect(placed.position.x).toBeCloseTo(2 - 0.03, P);
      expect(placed.position.z).toBeCloseTo(0.2, P);
    }
    // The right rotation keeps it where it is.
    expect(attachToWall({ ...tv, rotationY: -Math.PI / 2 }, room).position.x).toBeCloseTo(2 - 0.03, P);
  });

  it("keeps the rotation's wall when it is flush with it or about as close as the nearest wall", () => {
    // Flush on the north wall right at the east end (the east wall is closer to its center).
    const narrow = { position: { x: 1.9, y: 1, z: -1.5 + 0.15 }, dims: { w: 0.2, h: 0.4, d: 0.3 }, rotationY: 0 };
    expect(nearestWall(narrow.position, room)).toBe("east");
    expect(wallForItem(narrow, room)).toBe("north");
    // Not flush, but the north wall is only a little farther than the east one.
    expect(wallForItem({ position: { x: 1.6, y: 1, z: -1.0 }, dims: { w: 0.4, h: 0.4, d: 0.04 }, rotationY: 0 }, room)).toBe("north");
  });

  it("can move it to a given wall, facing into the room", () => {
    const { position, rotationY } = attachToWall(art, room, "east");
    expect(rotationY).toBeCloseTo(-Math.PI / 2, P);
    expect(position.x).toBeCloseTo(2 - 0.02, P);
    expect(position.z).toBeCloseTo(0.3, P);
  });
});

describe("freeCornerPlacement (\"... in the corner\")", () => {
  const lamp = { w: 0.4, h: 0.6, d: 0.4 };
  it("puts a hanging lamp in the back-left corner first, kept 0.3 m off both walls", () => {
    const p = freeCornerPlacement(lamp, "ceiling", "Paper lantern", room)!;
    expect(p.position.x).toBeCloseTo(-2 + 0.2 + 0.3, P);
    expect(p.position.z).toBeCloseTo(-1.5 + 0.2 + 0.3, P);
    expect(p.position.y).toBeCloseTo(2.5 - 0.6, P);
  });
  it("skips a corner that is taken and returns null for wall items", () => {
    const first = freeCornerPlacement(lamp, "ceiling", "Lamp", room)!;
    const taken = item({ mount: "ceiling", dims: lamp, position: first.position });
    const second = freeCornerPlacement(lamp, "ceiling", "Lamp", room, [taken])!;
    expect(second.position.x).toBeGreaterThan(0); // back-right
    expect(second.position.z).toBeLessThan(0);
    expect(freeCornerPlacement({ w: 0.6, h: 0.4, d: 0.03 }, "wall", "Art", room)).toBeNull();
  });
  it("without the hint, new items still go to the free spot nearest the middle", () => {
    expect(placementForNewItem(lamp, "ceiling", "Lamp", room, []).position.x).toBeCloseTo(0, P);
    expect(placementForNewItem(lamp, "ceiling", "Lamp", room, [], "corner").position.x).toBeLessThan(-1);
  });
});

describe("fitHangingItem", () => {
  const parts = [
    { kind: "cylinder" as const, center: { x: 0, y: 0.98, z: 0 }, size: { x: 0.25, y: 0.04, z: 0.25 } },
    { kind: "cylinder" as const, center: { x: 0, y: 0.7, z: 0 }, size: { x: 0.025, y: 0.52, z: 0.025 } },
    { kind: "sphere" as const, center: { x: 0, y: 0.2, z: 0 }, size: { x: 1, y: 0.4, z: 1 } },
  ];

  it("leaves a pendant that already clears the floor alone", () => {
    const dims = { w: 0.45, h: 0.9, d: 0.45 };
    expect(fitHangingItem(dims, parts, 2.44)).toEqual({ dims, parts });
  });

  it("shortens a listed maximum drop so the shade hangs at a normal height, keeping the shade's real size", () => {
    const dims = { w: 0.45, h: 3.3, d: 0.45 }; // "cord adjustable to 130 in"
    const tallParts = [
      { kind: "cylinder" as const, center: { x: 0, y: 0.995, z: 0 }, size: { x: 0.25, y: 0.01, z: 0.25 } },
      { kind: "cylinder" as const, center: { x: 0, y: 0.5545, z: 0 }, size: { x: 0.005, y: 0.871, z: 0.005 } },
      { kind: "sphere" as const, center: { x: 0, y: 0.06, z: 0 }, size: { x: 1, y: 0.12, z: 1 } },
    ];
    const roomH = 2.44;
    expect(roomH - dims.h).toBeLessThan(MIN_HANGING_BOTTOM);
    const fitted = fitHangingItem(dims, tallParts, roomH);
    expect(fitted.dims.h).toBeCloseTo(roomH - TARGET_HANGING_BOTTOM, 6);
    const realH = (p: { size: { y: number } }, h: number) => p.size.y * h;
    expect(realH(fitted.parts[2], fitted.dims.h)).toBeCloseTo(realH(tallParts[2], dims.h), 6); // shade unchanged
    const canopyTop = (fitted.parts[0].center.y + fitted.parts[0].size.y / 2) * fitted.dims.h;
    expect(canopyTop).toBeCloseTo(fitted.dims.h, 6); // canopy still at the ceiling
  });

  it("returns items without a recognizable cord unchanged", () => {
    const dims = { w: 0.6, h: 3, d: 0.6 };
    const solid = [{ kind: "box" as const, center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } }];
    expect(fitHangingItem(dims, solid, 2.44)).toEqual({ dims, parts: solid });
  });
});

describe("describePlacement", () => {
  it("names corners, walls and the middle", () => {
    const lamp = { mount: "ceiling" as const, rotationY: 0, dims: { w: 0.4, h: 0.9, d: 0.4 } };
    expect(describePlacement({ ...lamp, position: { x: -1.5, y: 1.6, z: -1 } }, room)).toBe("in the back-left (north-west) corner");
    expect(describePlacement({ ...lamp, position: { x: 0, y: 1.6, z: 0 } }, room)).toBe("hanging over the middle of the room");
    expect(describePlacement({ ...lamp, mount: "floor", position: { x: 1.6, y: 0, z: 0 } }, room)).toBe("against the right (east) wall");
    expect(describePlacement({ ...lamp, mount: "wall", position: { x: 0, y: 1.5, z: -1.48 } }, room)).toBe("on the back (north) wall");
  });
});

describe("defaultPlacement in a full room", () => {
  it("picks the spot that overlaps the least instead of the room center", () => {
    const room = { name: "T", width: 3, depth: 3, height: 2.5, wallColor: "#ffffff", floorColor: "#000000", openings: [] };
    const block = (id: string, x: number, z: number, w: number, d: number) => ({
      id,
      name: id,
      position: { x, y: 0, z },
      rotationY: 0,
      dims: { w, h: 0.8, d },
      color: "#888888",
      mount: "floor" as const,
      parts: [],
      origin: "shape" as const,
    });
    // A desk in the middle and furniture along every wall: a 1.6 × 2.1 bed fits nowhere.
    const items = [block("desk", 0, 0, 1.2, 0.6), block("n", 0, -1.2, 3, 0.6), block("s", 0, 1.2, 3, 0.6)];
    const { position } = defaultPlacementForFull({ w: 1.6, h: 0.6, d: 2.1 }, "floor", room, items);
    const bed = { ...block("bed", position.x, position.z, 1.6, 2.1) };
    expect(items.some((o) => overlapsForFull(bed, o))).toBe(true);
    const area = items.reduce((sum, o) => sum + overlapArea(bed, o), 0);
    const atCenter = items.reduce((sum, o) => sum + overlapArea(block("bed", 0, 0, 1.6, 2.1), o), 0);
    expect(area).toBeLessThan(atCenter);
  });
});
