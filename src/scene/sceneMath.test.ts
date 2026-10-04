// Pure scene helpers added for the review round: drag plane, label clamping, clip planes, wall seams, ghost spot.
import { describe, expect, it } from "vitest";
import type { PlacedItem, ProductCandidate, Room } from "../shared/types";
import { defaultRoom } from "../lib/presets";
import { clampLabelPosition } from "./labelMath";
import { PRESET_FOV, clipPlanes, presetView } from "./cameraViews";
import { overlapPieces, piecesArea, wallPieces } from "./wallPieces";
import { ghostPlacement } from "./ghostPlacement";

describe("clampLabelPosition", () => {
  const view = { width: 800, height: 600, insetRight: 300 };
  const label = { width: 120, height: 40 };
  it("leaves labels that fit alone", () => {
    expect(clampLabelPosition(200, 300, label, view)).toEqual([200, 300]);
  });
  it("slides labels out from under the inspector and back inside the top/left edges", () => {
    const [x] = clampLabelPosition(490, 300, label, view);
    expect(x + label.width / 2).toBeLessThanOrEqual(800 - 300);
    const [lx, ty] = clampLabelPosition(-50, -80, label, view);
    expect(lx - label.width / 2).toBeGreaterThanOrEqual(0);
    expect(ty - label.height).toBeGreaterThanOrEqual(0); // labels sit above their anchor
  });
});

describe("camera presets", () => {
  it("top view uses a long lens so raised items don't splay past the walls", () => {
    expect(PRESET_FOV.top).toBeLessThanOrEqual(5);
    const room = defaultRoom();
    const v = presetView("top", room, 1.4, PRESET_FOV.top);
    // A point at ceiling height 1.6 m off-center projects within a few cm of its floor position.
    const splay = (1.6 * room.height) / (v.position.y - room.height);
    expect(splay).toBeLessThan(0.06);
  });

  it("clip planes follow the viewing distance and always reach past the room", () => {
    const far = clipPlanes(85, 3.66);
    expect(far.near).toBeGreaterThan(1);
    expect(far.far).toBeGreaterThan(85 + 3.66);
    const close = clipPlanes(0.5, 3.66);
    expect(close.near).toBeCloseTo(0.02, 9);
  });
});

describe("overlapPieces (wall seams)", () => {
  const hole = { u0: 1.23, u1: 2.43, v0: 0.9, v1: 2.1 };
  const pieces = wallPieces(3.66, 2.44, [hole]);

  it("overlaps neighbouring pieces a hair but keeps the hole's edges exact", () => {
    const grown = overlapPieces(pieces, [hole], 0.002);
    expect(grown).toHaveLength(pieces.length);
    expect(piecesArea(grown)).toBeGreaterThan(piecesArea(pieces));
    for (const r of grown) {
      const intoHole = r.u0 < hole.u1 && r.u1 > hole.u0 && r.v0 < hole.v1 && r.v1 > hole.v0;
      expect(intoHole).toBe(false);
    }
    // The left strip's right edge also borders the window, so it stays put; the piece under the window grows
    // left into the strip instead, which covers the seam beside the window.
    const left = grown.find((r) => r.u0 === 0)!;
    expect(left.u1).toBeCloseTo(1.23, 9);
    const below = grown.find((r) => r.v1 > 0.85 && r.v1 < 0.95)!;
    expect(below.u0).toBeCloseTo(1.23 - 0.002, 9);
    expect(below.u1).toBeCloseTo(2.43 + 0.002, 9);
  });

  it("a wall with no holes is a single piece and stays as-is", () => {
    const solid = wallPieces(3, 2.4, []);
    expect(overlapPieces(solid, [])).toEqual(solid);
  });
});

describe("ghostPlacement", () => {
  const room: Room = defaultRoom();
  const candidate: ProductCandidate = {
    id: "c1",
    name: "Nightstand",
    retailer: "r",
    url: "https://example.com/n",
    dims: { w: 0.5, h: 0.6, d: 0.4 },
    dimsSource: "listed",
    colors: [{ name: "Walnut", hex: "#6b4a33" }],
    style: [],
    materials: [],
    mount: "floor",
    parts: [{ kind: "box", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } }],
  };
  const bed: PlacedItem = {
    id: "bed",
    name: "Queen bed",
    position: { x: -0.2, y: 0, z: -0.61 },
    rotationY: 0,
    dims: { w: 1.62, h: 0.92, d: 2.12 },
    color: "#ffffff",
    mount: "floor",
    parts: [],
    origin: "existing",
  };

  it("without a target, previews where Add would put it — not inside the bed at the center", () => {
    const g = ghostPlacement(candidate, room, [bed]);
    const inBed = Math.abs(g.position.x - bed.position.x) < (0.5 + 1.62) / 2 && Math.abs(g.position.z - bed.position.z) < (0.4 + 2.12) / 2;
    expect(inBed).toBe(false);
  });

  it("previews in a free corner when the search asked for one (and Add to room uses the same spot)", () => {
    const lamp: ProductCandidate = { ...candidate, name: "Paper lantern", mount: "ceiling", dims: { w: 0.45, h: 0.6, d: 0.45 } };
    const g = ghostPlacement(lamp, room, [bed], undefined, "corner");
    // The bed is low, so the lamp still hangs in the back-left corner, 0.3 m off both walls.
    expect(g.position.x).toBeCloseTo(-room.width / 2 + 0.225 + 0.3, 9);
    expect(g.position.z).toBeCloseTo(-room.depth / 2 + 0.225 + 0.3, 9);
  });

  it("with a target, previews in the target's spot and rotation", () => {
    const target: PlacedItem = { ...bed, id: "ph", name: "Box", dims: { w: 0.5, h: 0.5, d: 0.5 }, position: { x: 1.2, y: 0, z: 1.1 }, rotationY: Math.PI / 2 };
    const g = ghostPlacement(candidate, room, [bed, target], target);
    expect(g.position.x).toBeCloseTo(1.2, 9);
    expect(g.position.z).toBeCloseTo(1.1, 9);
    expect(g.rotationY).toBeCloseTo(Math.PI / 2, 9);
  });
});
