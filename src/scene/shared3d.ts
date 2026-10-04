// Shared constants and unit geometries used inside the Canvas.
import { BoxGeometry, ConeGeometry, CylinderGeometry, EdgesGeometry, SphereGeometry, type BufferGeometry } from "three";
import { createContext, type CSSProperties, type RefObject } from "react";
import type { Dims, ShapeKind, ShapePart } from "../shared/types";

/** Wall thickness in meters. Walls are built OUTSIDE the room bounds. */
export const WALL_T = 0.1;
export const ACCENT = "#2f7cf6";
export const BACKGROUND = "#f3f1ec";

/** Unit primitives (1×1×1 bounding box, centered) shared by every item part. */
export const UNIT_GEOMETRY: Record<ShapeKind, BufferGeometry> = {
  box: new BoxGeometry(1, 1, 1),
  cylinder: new CylinderGeometry(0.5, 0.5, 1, 32),
  sphere: new SphereGeometry(0.5, 32, 16),
  cone: new ConeGeometry(0.5, 1, 32),
};

/** Edges of a unit box, used for selection outlines. */
export const UNIT_BOX_EDGES = new EdgesGeometry(UNIT_GEOMETRY.box);

/** Local transform of a part inside its item's group (group origin = bottom-center of the bbox). */
export function partTransform(part: ShapePart, dims: Dims): { position: [number, number, number]; scale: [number, number, number] } {
  const s = (v: number) => Math.max(v, 1e-4); // avoid degenerate zero scales
  return {
    position: [part.center.x * dims.w, part.center.y * dims.h, part.center.z * dims.d],
    scale: [s(part.size.x * dims.w), s(part.size.y * dims.h), s(part.size.z * dims.d)],
  };
}

/** Raycast stub for helper objects that must never intercept pointer events. */
export const noRaycast = () => undefined;

export const labelStyle: CSSProperties = {
  pointerEvents: "none",
  userSelect: "none",
  whiteSpace: "nowrap",
  font: "500 11px/1.3 system-ui, -apple-system, Segoe UI, sans-serif",
  color: "#1f2328",
  background: "rgba(255,255,255,0.92)",
  border: "1px solid rgba(0,0,0,0.08)",
  borderRadius: 6,
  padding: "3px 7px",
  boxShadow: "0 1px 4px rgba(0,0,0,0.12)",
};

/**
 * Stable DOM container for drei <Html> labels (the scene wrapper div). Passing it as `portal` keeps the
 * labels' mount target fixed; otherwise drei re-creates each label root when R3F connects its events.
 */
export const LabelPortalContext = createContext<RefObject<HTMLElement | null> | null>(null);
