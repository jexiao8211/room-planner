// Floor, grid and four walls (with door/window openings and camera-facing cutaway).
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useCursor } from "@react-three/drei";
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshStandardMaterial, DoubleSide, Vector3, type Group, type Intersection, type Raycaster } from "three";
import type { Opening, Room, Units, WallSide } from "../shared/types";
import { usePlanner } from "../state/store";
import { M_PER_FT } from "../lib/units";
import { WALL_SIDES, openingsOnWall, overlapPieces, wallFrame, wallPieces, type Rect } from "./wallPieces";
import { WALL_T, labelStyle, noRaycast } from "./shared3d";
import { Label } from "./Label";
import { wallOpacities } from "./debugState";
import { lightingAnim, markShadowsDirty } from "./Lighting";
import { useWindowPopover } from "./WindowPopover";
import { windowCovering } from "../lib/lighting";

/** Opacity of walls that sit between the camera and the room. */
const FADED_OPACITY = 0.1;
const FRAME_W = 0.05;
const BLIND_COLOR = "#ece4d6";
const SLAT_COLOR = "#d6ccbb";
/** Spacing of the slat lines on closed blinds (m). */
const SLAT_PITCH = 0.075;
/** Height walls are cut down to when looking (nearly) straight down, like a floor plan. */
export const TOP_CUT_HEIGHT = 0.3;
const tmpDir = new Vector3();

export function RoomMesh() {
  const room = usePlanner((s) => s.room);
  const units = usePlanner((s) => s.units);
  return (
    <group>
      <Floor room={room} />
      <FloorGrid width={room.width} depth={room.depth} units={units} />
      {WALL_SIDES.map((side) => (
        <Wall key={side} side={side} room={room} />
      ))}
    </group>
  );
}

function Floor({ room }: { room: Room }) {
  const select = usePlanner((s) => s.select);
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    // A click (not the end of an orbit drag) on empty floor deselects.
    if (e.delta <= 4) select(null);
  };
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} receiveShadow onClick={onClick} name="floor">
        <planeGeometry args={[room.width, room.depth]} />
        <meshStandardMaterial color={room.floorColor} roughness={0.92} />
      </mesh>
      {/* Base slab under the walls so the room reads as a solid model. */}
      <mesh position={[0, -0.031, 0]} raycast={noRaycast}>
        <boxGeometry args={[room.width + 2 * WALL_T + 0.002, 0.06, room.depth + 2 * WALL_T + 0.002]} />
        <meshStandardMaterial color="#d6d1c8" roughness={1} />
      </mesh>
    </group>
  );
}

function FloorGrid({ width, depth, units }: { width: number; depth: number; units: Units }) {
  const spacing = units === "imperial" ? M_PER_FT : 0.5;
  const geometry = useMemo(() => {
    const pts: number[] = [];
    const y = 0.002;
    // Lines measured from the west / north walls so they read as distances from a wall.
    for (let x = -width / 2 + spacing; x < width / 2 - 1e-6; x += spacing) pts.push(x, y, -depth / 2, x, y, depth / 2);
    for (let z = -depth / 2 + spacing; z < depth / 2 - 1e-6; z += spacing) pts.push(-width / 2, y, z, width / 2, y, z);
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pts, 3));
    return g;
  }, [width, depth, spacing]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <lineSegments geometry={geometry} raycast={noRaycast}>
      <lineBasicMaterial color="#000000" transparent opacity={0.1} depthWrite={false} />
    </lineSegments>
  );
}

function setFade(m: MeshStandardMaterial, opacity: number) {
  const transparent = opacity < 0.995;
  if (m.transparent !== transparent) {
    m.transparent = transparent;
    m.depthWrite = !transparent;
    m.needsUpdate = true;
  }
  m.opacity = opacity;
}

function Wall({ side, room }: { side: WallSide; room: Room }) {
  const frame = wallFrame(side, room);
  const along = side === "north" || side === "south";
  const holes = useMemo(() => openingsOnWall(room, side), [room, side]);
  const pieces = useMemo(() => {
    const rects = holes.map((h) => h.rect);
    // Neighbouring pieces overlap a hair so no seam line shows where they meet.
    return overlapPieces(wallPieces(frame.length, room.height, rects), rects);
  }, [frame.length, room.height, holes]);

  const mats = useMemo(
    () => ({
      wall: new MeshStandardMaterial({ roughness: 0.95, color: room.wallColor }),
      frame: new MeshStandardMaterial({ color: "#fbfaf7", roughness: 0.7 }),
      glass: new MeshStandardMaterial({
        color: "#a9cfe6",
        roughness: 0.32,
        metalness: 0,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: DoubleSide,
      }),
      // Closed blinds: a fabric panel with slats.
      blind: new MeshStandardMaterial({ color: BLIND_COLOR, roughness: 0.9 }),
      slat: new MeshStandardMaterial({ color: SLAT_COLOR, roughness: 0.8 }),
    }),
    [],
  );
  useEffect(() => {
    mats.wall.color.set(room.wallColor);
  }, [mats, room.wallColor]);
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);

  // Cutaway: fade the wall when the camera is outside it (or looking at the room through it).
  const opacity = useRef(1);
  const groupRef = useRef<Group>(null);
  useFrame(({ camera }, dt) => {
    const cam = camera.position;
    const outside = (cam.x - frame.origin.x) * frame.normal.x + (cam.z - frame.origin.z) * frame.normal.z;
    const len = Math.hypot(cam.x, cam.y - room.height / 2, cam.z) || 1;
    const facing = (cam.x * frame.normal.x + cam.z * frame.normal.z) / len;
    const target = outside > -0.05 || facing > 0.35 ? FADED_OPACITY : 1;
    const k = 1 - Math.exp(-dt * 12);
    opacity.current += (target - opacity.current) * k;
    if (Math.abs(target - opacity.current) < 0.002) opacity.current = target;
    setFade(mats.wall, opacity.current);
    setFade(mats.frame, opacity.current);
    setFade(mats.blind, opacity.current);
    setFade(mats.slat, opacity.current);
    // Sky seen through the glass follows the lighting mode (day blue, evening glow, night dark blue).
    mats.glass.color.copy(lightingAnim.glassColor);
    mats.glass.emissive.copy(lightingAnim.glassColor).multiplyScalar(lightingAnim.glassEmissive);
    mats.glass.opacity = lightingAnim.glassOpacity * opacity.current;
    // Top-down: shrink every wall to a low stub so the plan reads clearly.
    const steep = -camera.getWorldDirection(tmpDir).y > 0.92;
    const targetScale = steep ? Math.min(1, TOP_CUT_HEIGHT / Math.max(room.height, 0.01)) : 1;
    const g = groupRef.current;
    if (g) {
      const prevScale = g.scale.y;
      g.scale.y += (targetScale - g.scale.y) * k;
      if (Math.abs(targetScale - g.scale.y) < 0.002) g.scale.y = targetScale;
      if (g.scale.y !== prevScale) markShadowsDirty(1);
      g.userData.opacity = opacity.current;
    }
    wallOpacities[side] = opacity.current;
  });

  // Group sits on the wall's center plane (half a thickness outside the room); local +x runs along u.
  const gx = frame.origin.x + frame.normal.x * (WALL_T / 2);
  const gz = frame.origin.z + frame.normal.z * (WALL_T / 2);
  const rotY = along ? 0 : -Math.PI / 2;
  // Which local z direction points into the room (local +z is world (sin rotY, cos rotY)).
  const inward = Math.sign(-frame.normal.x * Math.sin(rotY) - frame.normal.z * Math.cos(rotY)) || 1;

  return (
    <group ref={groupRef} position={[gx, 0, gz]} rotation-y={rotY} name={`wall-${side}`} userData={{ wall: side }}>
      {pieces.map((p, i) => {
        // North/south walls run past the corners so the four walls close up.
        const u0 = along && p.u0 <= 1e-6 ? -WALL_T : p.u0;
        const u1 = along && p.u1 >= frame.length - 1e-6 ? frame.length + WALL_T : p.u1;
        return (
          <mesh key={i} material={mats.wall} position={[(u0 + u1) / 2, (p.v0 + p.v1) / 2, 0]} raycast={noRaycast} castShadow receiveShadow>
            <boxGeometry args={[u1 - u0, p.v1 - p.v0, WALL_T]} />
          </mesh>
        );
      })}
      {holes.map(({ opening, rect }) => {
        const w = rect.u1 - rect.u0;
        const h = rect.v1 - rect.v0;
        const cu = (rect.u0 + rect.u1) / 2;
        const cv = (rect.v0 + rect.v1) / 2;
        const depth = WALL_T + 0.02;
        const bars: [number, number, number, number][] = [
          [rect.u0 + FRAME_W / 2, cv, FRAME_W, h],
          [rect.u1 - FRAME_W / 2, cv, FRAME_W, h],
          [cu, rect.v1 - FRAME_W / 2, w, FRAME_W],
        ];
        if (opening.kind === "window") bars.push([cu, rect.v0 + FRAME_W / 2, w, FRAME_W]);
        return (
          <group key={opening.id} userData={{ openingId: opening.id }}>
            {bars.map(([u, v, bw, bh], i) => (
              <mesh key={i} material={mats.frame} position={[u, v, 0]} raycast={noRaycast} castShadow receiveShadow>
                <boxGeometry args={[bw, bh, depth]} />
              </mesh>
            ))}
            {opening.kind === "window" && (
              <WindowPane
                opening={opening}
                rect={rect}
                inward={inward}
                glass={mats.glass}
                blind={mats.blind}
                slat={mats.slat}
                visible={() => opacity.current > 0.5}
              />
            )}
          </group>
        );
      })}
    </group>
  );
}

/**
 * A window's glass (click it to open the blinds popover) and, when its blinds are closed, the blind panel on the room
 * side. Only clickable while its wall is solid: through a cut-away wall, clicks go to the items behind it.
 */
function WindowPane({
  opening,
  rect,
  inward,
  glass,
  blind,
  slat,
  visible,
}: {
  opening: Opening;
  rect: Rect;
  inward: number;
  glass: MeshStandardMaterial;
  blind: MeshStandardMaterial;
  slat: MeshStandardMaterial;
  visible: () => boolean;
}) {
  const [hovered, setHovered] = useState(false);
  useCursor(hovered);
  const openPopover = useWindowPopover((s) => s.open);
  const w = rect.u1 - rect.u0;
  const h = rect.v1 - rect.v0;
  const cu = (rect.u0 + rect.u1) / 2;
  const cv = (rect.v0 + rect.v1) / 2;
  const closed = windowCovering(opening) === "closed";
  const raycast = useMemo(
    () =>
      function (this: Mesh, raycaster: Raycaster, hits: Intersection[]) {
        if (visible()) Mesh.prototype.raycast.call(this, raycaster, hits);
      },
    [visible],
  );
  const handlers = {
    raycast,
    userData: { openingId: opening.id },
    onClick: (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      if (e.delta <= 4) openPopover(opening.id);
    },
    onPointerOver: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      setHovered(true);
    },
    onPointerOut: () => setHovered(false),
  };
  // Blind panel just inside the room, a little wider than the opening, with slat lines.
  const bw = w + 0.06;
  const bh = h + 0.04;
  const z = inward * (WALL_T / 2 + 0.012);
  const slats = closed ? Math.max(1, Math.floor(bh / SLAT_PITCH) - 1) : 0;
  return (
    <group>
      <mesh material={glass} position={[cu, cv, 0]} name={`window-glass-${opening.id}`} {...handlers}>
        <planeGeometry args={[Math.max(w - 2 * FRAME_W, 0.01), Math.max(h - 2 * FRAME_W, 0.01)]} />
      </mesh>
      {/* Hovering a window says what a click does (the blinds are otherwise easy to miss). */}
      {hovered ? (
        <Label position={[cu, cv + h / 2 + 0.1, 0]}>
          <div data-testid="window-hover-tip" style={{ ...labelStyle, transform: "translateY(-50%)" }}>
            {closed ? "Click to open the blinds" : "Click to close the blinds"}
          </div>
        </Label>
      ) : null}
      {closed ? (
        <group name={`window-blind-${opening.id}`} position={[cu, cv, z]}>
          <mesh material={blind} receiveShadow castShadow {...handlers}>
            <boxGeometry args={[bw, bh, 0.012]} />
          </mesh>
          {Array.from({ length: slats }, (_, i) => (
            <mesh key={i} material={slat} position={[0, -bh / 2 + (i + 1) * (bh / (slats + 1)), inward * 0.008]} raycast={noRaycast}>
              <boxGeometry args={[bw - 0.01, 0.008, 0.006]} />
            </mesh>
          ))}
          {/* Bottom bar and the head rail. */}
          <mesh material={slat} position={[0, -bh / 2 + 0.012, inward * 0.01]} raycast={noRaycast}>
            <boxGeometry args={[bw, 0.024, 0.02]} />
          </mesh>
          <mesh material={slat} position={[0, bh / 2 - 0.02, inward * 0.012]} raycast={noRaycast}>
            <boxGeometry args={[bw + 0.02, 0.04, 0.03]} />
          </mesh>
        </group>
      ) : null}
    </group>
  );
}
