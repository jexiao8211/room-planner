import { describe, expect, it } from "vitest";
import { defaultRoom } from "../lib/presets";
import { clampOpening, openingsOnWall, piecesArea, wallFrame, wallPieces, type Rect } from "./wallPieces";

const overlaps = (a: Rect, b: Rect) => a.u0 < b.u1 - 1e-9 && b.u0 < a.u1 - 1e-9 && a.v0 < b.v1 - 1e-9 && b.v0 < a.v1 - 1e-9;

describe("wallPieces", () => {
  it("returns the whole wall when there are no openings", () => {
    expect(wallPieces(4, 2.5, [])).toEqual([{ u0: 0, u1: 4, v0: 0, v1: 2.5 }]);
  });

  it("cuts a window into left, right, below and above pieces", () => {
    const hole = { u0: 1, u1: 2, v0: 0.9, v1: 2.1 };
    const pieces = wallPieces(4, 2.5, [hole]);
    expect(pieces).toHaveLength(4);
    expect(pieces).toContainEqual({ u0: 0, u1: 1, v0: 0, v1: 2.5 });
    expect(pieces).toContainEqual({ u0: 2, u1: 4, v0: 0, v1: 2.5 });
    expect(pieces).toContainEqual({ u0: 1, u1: 2, v0: 0, v1: 0.9 });
    expect(pieces).toContainEqual({ u0: 1, u1: 2, v0: 2.1, v1: 2.5 });
    expect(piecesArea(pieces)).toBeCloseTo(4 * 2.5 - 1 * 1.2);
  });

  it("leaves no piece below a door", () => {
    const pieces = wallPieces(3, 2.4, [{ u0: 0.5, u1: 1.3, v0: 0, v1: 2 }]);
    expect(pieces).toHaveLength(3);
    expect(pieces.some((p) => p.u0 >= 0.5 && p.u1 <= 1.3 && p.v0 < 2)).toBe(false);
  });

  it("handles several openings on one wall without overlapping pieces", () => {
    const holes = [
      { u0: 0.5, u1: 1.3, v0: 0, v1: 2 },
      { u0: 2, u1: 3, v0: 1, v1: 2 },
      { u0: 2.5, u1: 3.5, v0: 1.5, v1: 2.2 }, // overlaps the previous one
    ];
    const pieces = wallPieces(4, 2.5, holes);
    for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) expect(overlaps(pieces[i], pieces[j])).toBe(false);
    for (const p of pieces) for (const h of holes) expect(overlaps(p, h)).toBe(false);
    // union of holes: 0.8*2 + (1*1 + 1*0.7 - 0.5*0.5)
    expect(piecesArea(pieces)).toBeCloseTo(10 - 1.6 - (1 + 0.7 - 0.25));
  });

  it("handles an opening touching the wall end", () => {
    const pieces = wallPieces(3, 2.4, [{ u0: 0, u1: 1, v0: 0, v1: 2 }]);
    expect(piecesArea(pieces)).toBeCloseTo(3 * 2.4 - 2);
    expect(pieces.every((p) => p.u0 >= 0 && p.u1 <= 3)).toBe(true);
  });
});

describe("clampOpening", () => {
  it("clamps an opening that runs past the wall ends and ceiling", () => {
    expect(clampOpening({ offset: 0.2, width: 1, height: 3, sill: 0 }, 3, 2.4)).toEqual({ u0: 0, u1: 0.7, v0: 0, v1: 2.4 });
    expect(clampOpening({ offset: 2.9, width: 1, height: 1, sill: 1 }, 3, 2.4)).toEqual({ u0: 2.4, u1: 3, v0: 1, v1: 2 });
  });

  it("drops openings entirely outside the wall", () => {
    expect(clampOpening({ offset: 5, width: 1, height: 1, sill: 1 }, 3, 2.4)).toBeNull();
    expect(clampOpening({ offset: 1, width: 1, height: 1, sill: 3 }, 3, 2.4)).toBeNull();
    expect(clampOpening({ offset: 1, width: 0, height: 1, sill: 1 }, 3, 2.4)).toBeNull();
  });
});

describe("openingsOnWall / wallFrame", () => {
  it("finds the default room's door and window on their walls", () => {
    const room = defaultRoom();
    expect(openingsOnWall(room, "south").map((o) => o.opening.kind)).toEqual(["door"]);
    expect(openingsOnWall(room, "north").map((o) => o.opening.kind)).toEqual(["window"]);
    expect(openingsOnWall(room, "east")).toEqual([]);
  });

  it("puts walls on the room boundary with outward normals", () => {
    const room = { width: 4, depth: 3 };
    expect(wallFrame("north", room)).toMatchObject({ origin: { x: -2, z: -1.5 }, normal: { x: 0, z: -1 }, length: 4 });
    expect(wallFrame("east", room)).toMatchObject({ origin: { x: 2, z: -1.5 }, axis: { x: 0, z: 1 }, normal: { x: 1, z: 0 }, length: 3 });
  });
});
