// Placed items (selectable, draggable) and the translucent preview ghost.
import { memo, useCallback, useMemo, useRef, useState, type RefObject } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useCursor } from "@react-three/drei";
import { Raycaster, Vector2, Vector3, type MeshStandardMaterial } from "three";
import type { Dims, LightSettings, PlacedItem, ShapePart, Units, WallSide } from "../shared/types";
import { shadePartIndex } from "../lib/lighting";
import { lightingAnim } from "./Lighting";
import { usePlanner } from "../state/store";
import { findSurfaceAt, nearestWall, rotationFacingAwayFrom, storedSurfaceY, surfaceName } from "../lib/geometry";
import { ghostPlacement } from "./ghostPlacement";
import { formatDims } from "../lib/units";
import {
  alongOf,
  dragPlaneY,
  floorDragTarget,
  floorSpotTarget,
  intersectHorizontalPlane,
  type FloorDragTarget,
  screenDragMetersPerPx,
  screenDragMinDepth,
  screenDragStart,
  screenDragStep,
  screenFloorDragStep,
  snapStep,
  snapValue,
  wallDragStep,
  wallMountPlacement,
  type Ray,
  type ScreenDrag,
} from "./dragMath";
import { ACCENT, UNIT_BOX_EDGES, UNIT_GEOMETRY, labelStyle, noRaycast, partTransform } from "./shared3d";
import { Label } from "./Label";
import { dragState } from "./debugState";

/** Pixels the pointer must travel before a press on an item becomes a drag. */
const DRAG_THRESHOLD = 3;

export function Items() {
  const items = usePlanner((s) => s.items);
  const selectedId = usePlanner((s) => s.selectedId);
  const units = usePlanner((s) => s.units);
  // While a candidate is previewed in place of a target item, the target is drawn faded.
  const fadedId = usePlanner((s) => (s.preview ? s.previewTargetId : null));
  const startDrag = useItemDrag();
  return (
    <group name="items">
      {items.map((item) =>
        item.hidden ? null : (
          <ItemMesh
            key={item.id}
            item={item}
            selected={item.id === selectedId}
            faded={item.id === fadedId}
            units={units}
            onPressItem={startDrag}
          />
        ),
      )}
      <Ghost />
    </group>
  );
}

const ItemMesh = memo(function ItemMesh({
  item,
  selected,
  faded,
  units,
  onPressItem,
}: {
  item: PlacedItem;
  selected: boolean;
  faded: boolean;
  units: Units;
  onPressItem: (e: ThreeEvent<PointerEvent>, id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  useCursor(hovered);
  const { w, h, d } = item.dims;
  // While something is dragged onto / under this item, it lights up like a hover: that is where it will land.
  const dropTarget = usePlanner((s) => !!dragState.id && dragState.id !== item.id && s.items.some((it) => it.id === dragState.id && it.supportId === item.id));
  const emissive = selected ? 0.22 : hovered || dropTarget ? 0.1 : 0;
  // The dragged floor item's label says where it will land: on the desk, under it, a cat tower's level, the floor.
  const support = usePlanner((s) => (item.supportId ? s.items.find((it) => it.id === item.supportId) : undefined));
  const dragging = dragState.id === item.id && item.mount === "floor";
  const landing = dragging ? dropWords(item, support) : null;
  // A light's shade glows in its light color while it is on.
  const shade = item.light ? shadePartIndex(item.parts, item.mount) : -1;

  return (
    <group
      name={`item-${item.id}`}
      userData={{ itemId: item.id }}
      position={[item.position.x, item.position.y, item.position.z]}
      rotation-y={item.rotationY}
      onPointerDown={(e) => onPressItem(e, item.id)}
      onPointerOver={(e) => {
        e.stopPropagation();
        // While something is being dragged over this item (onto a desk), only the dragged item's label shows.
        if (!dragState.active) setHovered(true);
      }}
      onPointerOut={() => setHovered(false)}
      onClick={(e) => e.stopPropagation()}
    >
      {item.parts.map((part, i) => (
        <PartMesh
          key={i}
          index={i}
          part={part}
          dims={item.dims}
          color={part.color ?? item.color}
          itemId={item.id}
          emissive={emissive}
          faded={faded}
          lit={!!item.light}
          glow={i === shade && item.light?.on ? item.light : undefined}
        />
      ))}
      {item.mount === "ceiling" ? <CeilingDrop item={item} selected={selected} /> : null}
      {selected && (
        <lineSegments geometry={UNIT_BOX_EDGES} position={[0, h / 2, 0]} scale={[w + 0.02, h + 0.02, d + 0.02]} raycast={noRaycast}>
          <lineBasicMaterial color={ACCENT} />
        </lineSegments>
      )}
      {/* A target faded behind a preview gives its label spot to the preview's label. */}
      {(selected || hovered || dragging) && !faded && (
        <Label position={[0, h + 0.08, 0]}>
          <div data-testid={selected ? "selected-item-label" : dragging ? "dragged-item-label" : "hover-item-label"} style={{ ...labelStyle, opacity: selected || dragging ? 1 : 0.85, transform: "translateY(-50%)" }}>
            <div style={{ fontWeight: 600 }}>
              {item.name}
              {item.locked ? " (locked)" : ""}
            </div>
            <div style={{ color: "#5b6168" }}>{formatDims(item.dims, units)}</div>
            {landing ? (
              <div data-testid="drag-target-label" style={{ color: ACCENT, fontWeight: 600 }}>
                {landing}
              </div>
            ) : null}
          </div>
        </Label>
      )}
    </group>
  );
});

/** Where a dragged floor item lands, in the Inspector's words: "↑ On Desk", "↓ Under Desk", "Cat tower — middle level". */
export function dropWords(item: Pick<PlacedItem, "supportId" | "supportSurfaceY">, support: Pick<PlacedItem, "name" | "dims" | "parts"> | undefined): string {
  if (!item.supportId || !support) return "On the floor";
  const y = item.supportSurfaceY;
  if (y !== undefined && y < 0.01) return `↓ Under ${support.name}`;
  if (y !== undefined) {
    const name = surfaceName(support, y);
    if (name !== "top") return `${support.name} — ${name}`;
  }
  return `↑ On ${support.name}`;
}

function PartMesh({
  index,
  part,
  dims,
  color,
  itemId,
  emissive,
  faded,
  lit,
  glow,
}: {
  index: number;
  part: ShapePart;
  dims: Dims;
  color: string;
  itemId: string;
  emissive: number;
  faded: boolean;
  /** Part of a light-emitting item: it doesn't cast shadows (its own bulb sits inside it). */
  lit?: boolean;
  /** The glowing shade of a light that is on. */
  glow?: LightSettings;
}) {
  const { position, scale } = partTransform(part, dims);
  const mat = useRef<MeshStandardMaterial>(null);
  return (
    <mesh geometry={UNIT_GEOMETRY[part.kind]} position={position} scale={scale} userData={{ itemId }} castShadow={!lit} receiveShadow>
      {glow ? <ShadeGlow mat={mat} light={glow} /> : null}
      <meshStandardMaterial
        ref={mat}
        color={color}
        roughness={0.75}
        emissive={glow ? glow.color : ACCENT}
        emissiveIntensity={glow ? 0.6 : emissive}
        transparent={faded}
        opacity={faded ? 0.18 : 1}
        depthWrite={!faded}
        // Later parts win where two parts share a face (drawer fronts on a dresser body): no z-fighting.
        polygonOffset={index > 0}
        polygonOffsetFactor={-Math.min(index, 8) * 0.5}
        polygonOffsetUnits={-Math.min(index, 8)}
      />
    </mesh>
  );
}

/** Drives a lamp shade's glow from the light's brightness and the lighting mode (stronger at night). */
function ShadeGlow({ mat, light }: { mat: RefObject<MeshStandardMaterial | null>; light: LightSettings }) {
  useFrame(() => {
    if (mat.current) mat.current.emissiveIntensity = lightingAnim.glow * (0.3 + 0.7 * light.intensity);
  });
  return null;
}

/**
 * Floor marker for a ceiling-mounted item: a faint footprint on the floor plus (when selected) a drop line,
 * so a pendant in a corner reads as being in that corner instead of floating over the middle of the room.
 */
function CeilingDrop({ item, selected }: { item: PlacedItem; selected: boolean }) {
  const { w, d } = item.dims;
  const drop = item.position.y; // from the floor up to the item's bottom (local y = 0)
  if (drop < 0.05) return null;
  return (
    <group position={[0, -drop, 0]}>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.004, 0]} scale={[w, d, 1]} raycast={noRaycast} renderOrder={1}>
        <circleGeometry args={[0.5, 40]} />
        <meshBasicMaterial color={ACCENT} transparent opacity={selected ? 0.22 : 0.1} depthWrite={false} />
      </mesh>
      {selected ? (
        <mesh position={[0, drop / 2, 0]} scale={[0.006, drop, 0.006]} geometry={UNIT_GEOMETRY.box} raycast={noRaycast}>
          <meshBasicMaterial color={ACCENT} transparent opacity={0.5} depthWrite={false} />
        </mesh>
      ) : null}
    </group>
  );
}

/** Translucent preview of the product candidate currently being previewed. */
function Ghost() {
  const preview = usePlanner((s) => s.preview);
  const room = usePlanner((s) => s.room);
  const items = usePlanner((s) => s.items);
  const targetId = usePlanner((s) => s.previewTargetId);
  const hint = usePlanner((s) => s.placementHint);
  const placement = useMemo(() => {
    if (!preview) return null;
    const target = targetId ? items.find((it) => it.id === targetId) : undefined;
    return ghostPlacement(preview, room, items, target, hint);
  }, [preview, room, items, targetId, hint]);
  if (!preview || !placement) return null;
  const { w, h, d } = placement.fields.dims;
  const color = preview.colors[0]?.hex ?? "#999999";
  const parts = placement.fields.parts;
  return (
    <group
      name="preview-ghost"
      userData={{ previewId: preview.id }}
      position={[placement.position.x, placement.position.y, placement.position.z]}
      rotation-y={placement.rotationY}
    >
      {parts.map((part, i) => {
        const t = partTransform(part, placement.fields.dims);
        return (
          <mesh key={i} geometry={UNIT_GEOMETRY[part.kind]} position={t.position} scale={t.scale} raycast={noRaycast} renderOrder={2}>
            <meshStandardMaterial color={part.color ?? color} transparent opacity={0.45} depthWrite={false} roughness={0.6} />
          </mesh>
        );
      })}
      <lineSegments geometry={UNIT_BOX_EDGES} position={[0, h / 2, 0]} scale={[w, h, d]} raycast={noRaycast}>
        <lineBasicMaterial color={ACCENT} transparent opacity={0.6} />
      </lineSegments>
      <Label position={[0, h + 0.08, 0]}>
        <div data-testid="preview-label" style={{ ...labelStyle, transform: "translateY(-50%)", borderColor: ACCENT }}>
          <span style={{ color: ACCENT, fontWeight: 700 }}>Preview</span> · {preview.name}
        </div>
      </Label>
    </group>
  );
}

/**
 * Pointer-down handler for items: selects the item and, unless it is locked, starts a drag that follows
 * the pointer until release. Floor/ceiling mounts move in x/z; wall mounts slide along walls and up/down.
 */
function useItemDrag() {
  const get = useThree((s) => s.get);
  return useCallback(
    (e: ThreeEvent<PointerEvent>, id: string) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      dragState.moved = false;
      const store = usePlanner.getState();
      const item = store.items.find((it) => it.id === id);
      // With nothing selected the inspector is closed. Opening it on the press would cover the right part of the
      // view for the whole drag (hiding drop targets there), so the item is selected on release instead.
      const selectOnRelease = !!item && !item.locked && store.selectedId == null;
      if (!selectOnRelease) store.select(id);
      if (!item || item.locked) return;

      const { camera, gl, controls } = get();
      const orbit = controls as unknown as { enabled: boolean } | null;
      if (orbit) orbit.enabled = false;
      dragState.active = true;

      const raycaster = new Raycaster();
      const ndc = new Vector2();
      const rayAt = (clientX: number, clientY: number): Ray => {
        const rect = gl.domElement.getBoundingClientRect();
        ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        const { origin, direction } = raycaster.ray;
        return { origin: { x: origin.x, y: origin.y, z: origin.z }, dir: { x: direction.x, y: direction.y, z: direction.z } };
      };

      const startX = e.nativeEvent.clientX;
      const startY = e.nativeEvent.clientY;
      const startRay = rayAt(startX, startY);
      let started = false;

      // Grab offsets so the item doesn't jump to the pointer.
      let offX = 0;
      let offZ = 0;
      let offAlong = 0;
      let offY = 0;
      let planeY: number | null = 0;
      // Floor items: height of the grabbed point above the item's bottom (it may be stacked on something).
      const grabLocalY = Math.max(0, e.point.y - item.position.y);
      let screen: ScreenDrag | null = null;
      let currentWall: WallSide = nearestWall(item.position, store.room);
      if (item.mount === "wall") {
        const hit = wallDragStep(startRay, store.room, currentWall);
        if (hit && hit.wall === currentWall) {
          offAlong = alongOf(currentWall, item.position) - hit.along;
          if (hit.y !== null) offY = item.position.y - hit.y;
        } else {
          offY = -item.dims.h / 2;
        }
      } else {
        // Drag on a horizontal plane through the grabbed point so the item stays under the cursor. When that plane
        // is close to eye level (a pendant seen from the Eye view) rays graze it, so drag in screen space instead.
        planeY = dragPlaneY(e.point.y, camera.position.y);
        if (planeY === null) {
          const fwd = camera.getWorldDirection(new Vector3());
          const rect = gl.domElement.getBoundingClientRect();
          const mpp = screenDragMetersPerPx(store.room, rect.height);
          screen = screenDragStart(startRay, e.point, item.position, { x: fwd.x, z: fwd.z }, startY, mpp);
          if (!screen) planeY = Math.max(0, e.point.y);
          // A floor item is never pulled in under the camera (out of view at the bottom of the Eye view).
          else if (item.mount === "floor") {
            screen.minDepth = screenDragMinDepth(rayAt(rect.left + rect.width / 2, rect.bottom - 2), { x: fwd.x, z: fwd.z }, Math.max(item.dims.w, item.dims.d) / 2);
          }
        }
        const p = planeY === null ? null : intersectHorizontalPlane(startRay, planeY);
        if (p) {
          offX = item.position.x - p.x;
          offZ = item.position.z - p.z;
        }
      }

      const onMove = (ev: PointerEvent) => {
        if (!started) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
          started = true;
          dragState.moved = true;
          dragState.id = id;
          usePlanner.getState().checkpoint();
          document.body.style.cursor = "grabbing";
        }
        const s = usePlanner.getState();
        const cur = s.items.find((it) => it.id === id);
        if (!cur) return;
        const step = snapStep(s.units);
        const ray = rayAt(ev.clientX, ev.clientY);

        if (cur.mount === "wall") {
          const hit = wallDragStep(ray, s.room, currentWall);
          if (!hit) return;
          let rotationY = cur.rotationY;
          if (hit.wall !== currentWall) {
            currentWall = hit.wall;
            offAlong = 0;
            rotationY = rotationFacingAwayFrom(hit.wall);
          }
          const along = snapValue(hit.along + offAlong, step);
          const y = hit.y === null ? cur.position.y : snapValue(hit.y + offY, step);
          const placed = wallMountPlacement(hit.wall, along, y, cur.dims, s.room, rotationY);
          s.updateItem(id, placed, { transient: true });
        } else if (cur.mount === "floor") {
          // Floor items stack onto whatever valid support is under the pointer, and step back down off it.
          // Part-aware: a cat tower's middle platform, or the floor under a desk (supportSurfaceY).
          let target: FloorDragTarget | null;
          if (screen) {
            // Pointing at a surface (a cat tower's platform, a desk top, the floor under a desk) puts it there, as in
            // the other views; only elsewhere does vertical pointer movement push / pull the item in depth.
            // While the pointer is on the floor (not on a surface), the item stays on the floor (at most as far as the
            // pointer): it never jumps back up onto the support it started on.
            const onSurface = floorDragTarget(ray, cur, s.items, grabLocalY, screen.offset, step, camera.position.y, s.room, true);
            const p = onSurface ? null : screenFloorDragStep(screen, ray, ev.clientY);
            const xz = p ? { x: snapValue(p.x, step), z: snapValue(p.z, step) } : null;
            const found = xz && !p?.aim ? findSurfaceAt(cur, xz, s.items) : null;
            target =
              onSurface ??
              (xz && p?.aim
                ? floorSpotTarget(cur, xz, s.items, p.aim, screen.forward, step)
                : xz
                  ? found
                    ? { ...xz, support: found.support, surfaceY: storedSurfaceY(found.support, found.surface), y: found.support.position.y + found.surface.y }
                    : { ...xz, support: null, y: 0 }
                  : null);
          } else {
            target = floorDragTarget(ray, cur, s.items, grabLocalY, { x: offX, z: offZ }, step, camera.position.y, s.room);
          }
          if (!target) return;
          const position = { x: target.x, y: target.y, z: target.z };
          s.updateItem(id, { position, supportId: target.support?.id, supportSurfaceY: target.support ? target.surfaceY : undefined }, { transient: true });
        } else {
          const p = screen ? screenDragStep(screen, ray, ev.clientY) : planeY === null ? null : intersectHorizontalPlane(ray, planeY);
          if (!p) return;
          const [dx, dz] = screen ? [0, 0] : [offX, offZ];
          const position = { x: snapValue(p.x + dx, step), y: cur.position.y, z: snapValue(p.z + dz, step) };
          s.updateItem(id, { position }, { transient: true });
        }
      };

      const end = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", end, true);
        window.removeEventListener("pointercancel", end, true);
        window.removeEventListener("blur", end);
        if (orbit) orbit.enabled = true;
        dragState.active = false;
        dragState.id = null;
        if (started) document.body.style.cursor = "";
        // Selected while the press still counts as down (this listener runs in the capture phase, before the camera
        // rig sees the release), so the camera re-frames for the inspector a moment later, as after a click.
        if (selectOnRelease) {
          const s = usePlanner.getState();
          if (s.items.some((it) => it.id === id)) s.select(id);
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", end, true);
      window.addEventListener("pointercancel", end, true);
      window.addEventListener("blur", end);
    },
    [get],
  );
}
