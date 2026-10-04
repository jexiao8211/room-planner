import type { Dims, Mount, Room, ShapeKind, ShapePart } from "../shared/types";

export function newId(prefix = "id"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 12' × 11' bedroom with 8' ceilings, one door and one window. */
export function defaultRoom(): Room {
  return {
    name: "My bedroom",
    width: 3.66,
    depth: 3.35,
    height: 2.44,
    wallColor: "#e9e4dc",
    floorColor: "#b89874",
    openings: [
      { id: "door_1", kind: "door", wall: "south", offset: 0.6, width: 0.81, height: 2.03, sill: 0 },
      { id: "win_1", kind: "window", wall: "north", offset: 1.83, width: 1.2, height: 1.2, sill: 0.9 },
    ],
  };
}

/** A single primitive that fills the whole bounding box. */
export function fullPart(kind: ShapeKind): ShapePart {
  return { kind, center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } };
}

export interface ShapePreset {
  key: string;
  label: string;
  dims: Dims;
  mount: Mount;
  color: string;
  parts: ShapePart[];
}

/** Quick-add palette: raw primitives plus a few common furniture silhouettes. */
export const SHAPE_PRESETS: ShapePreset[] = [
  { key: "box", label: "Box", dims: { w: 0.5, h: 0.5, d: 0.5 }, mount: "floor", color: "#8aa1b1", parts: [fullPart("box")] },
  { key: "cylinder", label: "Cylinder", dims: { w: 0.4, h: 0.6, d: 0.4 }, mount: "floor", color: "#b18a8a", parts: [fullPart("cylinder")] },
  { key: "sphere", label: "Sphere", dims: { w: 0.4, h: 0.4, d: 0.4 }, mount: "floor", color: "#a3b18a", parts: [fullPart("sphere")] },
  { key: "cone", label: "Cone", dims: { w: 0.4, h: 0.6, d: 0.4 }, mount: "floor", color: "#b1a38a", parts: [fullPart("cone")] },
  {
    key: "bed",
    label: "Queen bed",
    dims: { w: 1.6, h: 0.6, d: 2.1 },
    mount: "floor",
    color: "#c9c2b6",
    parts: [
      { kind: "box", center: { x: 0, y: 0.25, z: 0 }, size: { x: 1, y: 0.5, z: 1 } },
      { kind: "box", center: { x: 0, y: 0.75, z: -0.47 }, size: { x: 1, y: 0.5, z: 0.06 }, color: "#8b6f4e" },
    ],
  },
  {
    key: "desk",
    label: "Desk",
    dims: { w: 1.2, h: 0.75, d: 0.6 },
    mount: "floor",
    color: "#9c7b57",
    parts: [
      { kind: "box", center: { x: 0, y: 0.97, z: 0 }, size: { x: 1, y: 0.06, z: 1 } },
      { kind: "box", center: { x: -0.47, y: 0.47, z: 0 }, size: { x: 0.04, y: 0.94, z: 0.9 } },
      { kind: "box", center: { x: 0.47, y: 0.47, z: 0 }, size: { x: 0.04, y: 0.94, z: 0.9 } },
    ],
  },
  {
    key: "pendant",
    label: "Hanging lamp",
    dims: { w: 0.4, h: 0.9, d: 0.4 },
    mount: "ceiling",
    color: "#f2e6c9",
    parts: [
      { kind: "cylinder", center: { x: 0, y: 0.72, z: 0 }, size: { x: 0.03, y: 0.56, z: 0.03 }, color: "#333333" },
      { kind: "sphere", center: { x: 0, y: 0.22, z: 0 }, size: { x: 1, y: 0.44, z: 1 } },
    ],
  },
  {
    // Standing floor lamp: base disc, thin stem, drum shade on top (gets a warm light: its name says lamp).
    key: "floorlamp",
    label: "Floor lamp",
    dims: { w: 0.4, h: 1.6, d: 0.4 },
    mount: "floor",
    color: "#f2e6c9",
    parts: [
      { kind: "cylinder", center: { x: 0, y: 0.01, z: 0 }, size: { x: 0.6, y: 0.02, z: 0.6 }, color: "#333333" },
      { kind: "cylinder", center: { x: 0, y: 0.45, z: 0 }, size: { x: 0.06, y: 0.86, z: 0.06 }, color: "#333333" },
      { kind: "cylinder", center: { x: 0, y: 0.89, z: 0 }, size: { x: 1, y: 0.2, z: 1 } },
    ],
  },
  {
    // Table / bedside lamp: base, stem, cone shade. Small enough for a nightstand or a desk.
    key: "tablelamp",
    label: "Table lamp",
    dims: { w: 0.3, h: 0.5, d: 0.3 },
    mount: "floor",
    color: "#f2e6c9",
    parts: [
      { kind: "cylinder", center: { x: 0, y: 0.04, z: 0 }, size: { x: 0.5, y: 0.08, z: 0.5 }, color: "#444444" },
      { kind: "cylinder", center: { x: 0, y: 0.35, z: 0 }, size: { x: 0.08, y: 0.6, z: 0.08 }, color: "#444444" },
      { kind: "cone", center: { x: 0, y: 0.8, z: 0 }, size: { x: 1, y: 0.4, z: 1 } },
    ],
  },
  {
    key: "frame",
    label: "Wall art",
    dims: { w: 0.8, h: 0.6, d: 0.04 },
    mount: "wall",
    color: "#5d6d7e",
    parts: [fullPart("box")],
  },
  {
    // Sitting cat, facing +z (its front). Small enough to sit on a cat tower, desk or bed.
    key: "cat",
    label: "Cat",
    dims: { w: 0.25, h: 0.3, d: 0.45 },
    mount: "floor",
    color: "#c98a4b",
    parts: [
      { kind: "sphere", center: { x: 0, y: 0.35, z: 0.03 }, size: { x: 0.9, y: 0.6, z: 0.72 } },
      { kind: "sphere", center: { x: 0, y: 0.72, z: 0.3 }, size: { x: 0.7, y: 0.42, z: 0.33 } },
      { kind: "cone", center: { x: -0.17, y: 0.93, z: 0.3 }, size: { x: 0.18, y: 0.14, z: 0.12 } },
      { kind: "cone", center: { x: 0.17, y: 0.93, z: 0.3 }, size: { x: 0.18, y: 0.14, z: 0.12 } },
      { kind: "sphere", center: { x: 0.25, y: 0.08, z: -0.25 }, size: { x: 0.16, y: 0.12, z: 0.5 } },
    ],
  },
  {
    // Two-level cat tree: base with a condo box, sisal posts, a middle platform and a top perch.
    key: "cattower",
    label: "Cat tower",
    dims: { w: 0.6, h: 1.5, d: 0.6 },
    mount: "floor",
    color: "#cdbfa8",
    parts: [
      { kind: "box", center: { x: 0, y: 0.015, z: 0 }, size: { x: 1, y: 0.03, z: 1 } },
      { kind: "box", center: { x: 0.18, y: 0.24, z: 0.18 }, size: { x: 0.5, y: 0.42, z: 0.5 } },
      { kind: "cylinder", center: { x: -0.25, y: 0.31, z: -0.25 }, size: { x: 0.18, y: 0.56, z: 0.18 }, color: "#b59b7a" },
      { kind: "box", center: { x: 0, y: 0.61, z: 0 }, size: { x: 1, y: 0.04, z: 1 } },
      { kind: "cylinder", center: { x: 0.25, y: 0.8, z: 0.25 }, size: { x: 0.18, y: 0.34, z: 0.18 }, color: "#b59b7a" },
      { kind: "box", center: { x: 0, y: 0.98, z: 0 }, size: { x: 0.85, y: 0.04, z: 0.85 } },
    ],
  },
];
