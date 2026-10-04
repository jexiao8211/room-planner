// Demo-mode room estimate: a 12' × 11' bedroom with 8' ceilings (same shell as defaultRoom()),
// one door, one window and four pieces of existing furniture with multi-part shapes.
import type { ShapePart } from "../../src/shared/types";
import type { DraftRoomEstimate } from "../sanitize";

const W = 3.66;
const D = 3.35;

const box = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color?: string): ShapePart => ({
  kind: "box",
  center: { x: cx, y: cy, z: cz },
  size: { x: sx, y: sy, z: sz },
  ...(color ? { color } : {}),
});
const cyl = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color?: string): ShapePart => ({
  ...box(cx, cy, cz, sx, sy, sz, color),
  kind: "cylinder",
});

export function mockRoomDraft(): DraftRoomEstimate {
  return {
    room: {
      name: "Bedroom",
      width: W,
      depth: D,
      height: 2.44,
      wallColor: "#e9e4dc",
      floorColor: "#b89874",
    },
    openings: [
      { id: "door_1", kind: "door", wall: "south", offset: 0.6, width: 0.81, height: 2.03, sill: 0 },
      { id: "win_1", kind: "window", wall: "north", offset: 1.6, width: 1.2, height: 1.2, sill: 0.95 },
    ],
    items: [
      {
        id: "existing_bed",
        name: "Queen bed",
        dims: { w: 1.62, h: 0.92, d: 2.12 },
        mount: "floor",
        color: "#d9d4ca",
        // Headboard against the north wall, under the window.
        position: { x: -0.2, y: 0, z: -D / 2 + 1.06 },
        rotationY: 0,
        parts: [
          box(0, 0.13, 0.02, 1, 0.22, 0.96, "#7a5c3e"), // frame / base
          box(0, 0.38, 0.03, 0.96, 0.27, 0.93), // mattress
          box(0, 0.6, -0.475, 1, 0.8, 0.05, "#7a5c3e"), // headboard
          box(-0.24, 0.56, -0.36, 0.38, 0.1, 0.14, "#f4f1ea"), // pillow L
          box(0.24, 0.56, -0.36, 0.38, 0.1, 0.14, "#f4f1ea"), // pillow R
          box(0, 0.54, 0.22, 0.98, 0.04, 0.5, "#8fa3b8"), // folded duvet
        ],
      },
      {
        id: "existing_nightstand",
        name: "Nightstand",
        dims: { w: 0.5, h: 0.6, d: 0.4 },
        mount: "floor",
        color: "#8b6a4a",
        position: { x: -0.2 + 0.81 + 0.32, y: 0, z: -D / 2 + 0.2 },
        rotationY: 0,
        parts: [
          // Body stops short of the front so the drawer front sits proud of it (coplanar faces z-fight).
          box(0, 0.62, -0.02, 1, 0.76, 0.96), // body
          box(0, 0.78, 0.47, 0.86, 0.3, 0.06, "#a5835f"), // drawer front
          box(0, 0.4, 0.47, 0.86, 0.04, 0.06, "#6e5238"), // open shelf lip
          box(-0.44, 0.12, -0.42, 0.08, 0.24, 0.1), // legs
          box(0.44, 0.12, -0.42, 0.08, 0.24, 0.1),
          box(-0.44, 0.12, 0.42, 0.08, 0.24, 0.1),
          box(0.44, 0.12, 0.42, 0.08, 0.24, 0.1),
        ],
      },
      {
        id: "existing_dresser",
        name: "Six-drawer dresser",
        dims: { w: 1.2, h: 0.82, d: 0.48 },
        mount: "floor",
        color: "#f0ede6",
        // Back against the east wall, facing west into the room.
        position: { x: W / 2 - 0.24, y: 0, z: 0.55 },
        rotationY: -Math.PI / 2,
        parts: [
          box(0, 0.06, 0, 0.96, 0.12, 0.92, "#c9c3b8"), // plinth
          // Carcass front at z = 0.48; drawer fronts span 0.48-0.50 so they sit proud of it (no z-fighting).
          box(0, 0.54, -0.01, 1, 0.84, 0.98), // carcass
          box(-0.245, 0.27, 0.49, 0.47, 0.24, 0.02, "#e2ddd3"), // drawer fronts
          box(0.245, 0.27, 0.49, 0.47, 0.24, 0.02, "#e2ddd3"),
          box(-0.245, 0.53, 0.49, 0.47, 0.24, 0.02, "#e2ddd3"),
          box(0.245, 0.53, 0.49, 0.47, 0.24, 0.02, "#e2ddd3"),
          box(-0.245, 0.8, 0.49, 0.47, 0.2, 0.02, "#e2ddd3"),
          box(0.245, 0.8, 0.49, 0.47, 0.2, 0.02, "#e2ddd3"),
        ],
      },
      {
        id: "existing_chair",
        name: "Desk chair",
        dims: { w: 0.62, h: 1.0, d: 0.62 },
        mount: "floor",
        color: "#3b3f45",
        // By the west wall, facing east.
        position: { x: -W / 2 + 0.55, y: 0, z: 0.45 },
        rotationY: Math.PI / 2,
        parts: [
          cyl(0, 0.03, 0, 1, 0.06, 1, "#202226"), // star base
          cyl(0, 0.27, 0, 0.08, 0.42, 0.08, "#9aa0a6"), // gas lift
          box(0, 0.51, 0.04, 0.8, 0.08, 0.78), // seat
          box(0, 0.78, -0.4, 0.76, 0.44, 0.08), // backrest
          box(-0.44, 0.64, 0.05, 0.08, 0.04, 0.5, "#202226"), // armrests
          box(0.44, 0.64, 0.05, 0.08, 0.04, 0.5, "#202226"),
        ],
      },
    ],
  };
}

export const MOCK_ROOM_NOTES = [
  "Demo data: a typical 12' × 11' bedroom with 8' ceilings, not an analysis of your photos.",
  "Scale is based on the door (about 2.03 m tall) unless you give a known measurement. Confidence: medium.",
];
