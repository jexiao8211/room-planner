import { useEffect, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ContactShadows } from "@react-three/drei";
import { PCFShadowMap, Vector3, type Group } from "three";
import type { ShapePart } from "../shared/types";
import { usePlanner } from "../state/store";
import { formatLength } from "../lib/units";
import { MODE_PARAMS, lightingMode } from "../lib/lighting";
import { RoomMesh } from "./RoomMesh";
import { Items } from "./Items";
import { CameraRig } from "./CameraRig";
import { KeyboardShortcuts } from "./KeyboardShortcuts";
import { BACKGROUND, LabelPortalContext, WALL_T, labelStyle, partTransform } from "./shared3d";
import { Label } from "./Label";
import { ThumbnailSource } from "./thumbnail";
import { LightingRig, lightingAnim } from "./Lighting";
import { WindowPopover } from "./WindowPopover";
import { cameraState, dragState, pointerState, wallOpacities } from "./debugState";

/** Full-size 3D view of the room. Fills its parent element. */
export function Scene() {
  const select = usePlanner((s) => s.select);
  const wrapperRef = useRef<HTMLDivElement>(null);
  return (
    <LabelPortalContext.Provider value={wrapperRef}>
      <div
        ref={wrapperRef}
        data-testid="scene-canvas"
        onPointerDownCapture={() => {
          pointerState.down = true;
          dragState.moved = false;
        }}
        style={{ position: "relative", width: "100%", height: "100%", minHeight: 0, overflow: "hidden", background: BACKGROUND }}
      >
        <Canvas
          dpr={[1, 2]}
          camera={{ fov: 45, near: 0.05, far: 300, position: [5, 4, 6] }}
          gl={{ antialias: true }}
          // Real-time shadows for lamps and window sun; maps only re-render when the plan changes (see Lighting.tsx).
          shadows={{ enabled: true, type: PCFShadowMap, autoUpdate: false }}
          flat
          // R3F only calls this for clicks that moved <= 2px, so orbit drags don't deselect.
          onPointerMissed={() => select(null)}
        >
          {/* Day / Evening / Night lights, lamp point lights and window sun beams (also sets the background). */}
          <LightingRig />
          <WindowPopover />
          <RoomMesh />
          <RoomShadows />
          <Items />
          <RoomDimensionLabels />
          <CameraRig />
          <KeyboardShortcuts />
          <DebugBridge />
          <ThumbnailSource />
        </Canvas>
      </div>
    </LabelPortalContext.Provider>
  );
}

function RoomShadows() {
  const room = usePlanner((s) => s.room);
  const opacity = MODE_PARAMS[lightingMode(room.lighting)].contactShadow;
  return (
    <ContactShadows
      position={[0, 0.003, 0]}
      scale={[room.width, room.depth]}
      resolution={512}
      far={room.height}
      blur={2.4}
      opacity={opacity}
      color="#3a3026"
      frames={Infinity}
    />
  );
}

/** Width/depth labels on the floor edges nearest the camera. */
function RoomDimensionLabels() {
  const room = usePlanner((s) => s.room);
  const units = usePlanner((s) => s.units);
  const widthRef = useRef<Group>(null);
  const depthRef = useRef<Group>(null);
  const gap = WALL_T + 0.22;
  useFrame(({ camera }) => {
    const sz = camera.position.z >= 0 ? 1 : -1;
    const sx = camera.position.x >= 0 ? 1 : -1;
    widthRef.current?.position.set(0, 0, sz * (room.depth / 2 + gap));
    depthRef.current?.position.set(sx * (room.width / 2 + gap), 0, 0);
  });
  const style = { ...labelStyle, background: "rgba(255,255,255,0.75)", color: "#4a4f55", fontWeight: 500 };
  return (
    <>
      <group ref={widthRef}>
        <Label zIndex={10}>
          <div data-testid="room-width-label" style={style}>
            {formatLength(room.width, units)}
          </div>
        </Label>
      </group>
      <group ref={depthRef}>
        <Label zIndex={10}>
          <div data-testid="room-depth-label" style={style}>
            {formatLength(room.depth, units)}
          </div>
        </Label>
      </group>
    </>
  );
}

/**
 * Test hook: window.__plannerDebug lets E2E tests find items on screen and inspect the camera.
 * Item meshes also carry userData.itemId.
 */
function DebugBridge() {
  const get = useThree((s) => s.get);
  useEffect(() => {
    const w = window as unknown as { __plannerDebug?: unknown };
    w.__plannerDebug = {
      getCameraPreset: () => cameraState.preset,
      isCameraAnimating: () => cameraState.animating,
      isDragging: () => dragState.active,
      /** World position (bottom-center) of the preview ghost, or null when nothing is previewed. */
      getPreviewPosition: () => {
        const g = get().scene.getObjectByName("preview-ghost");
        return g ? g.position.toArray() : null;
      },
      getWallOpacities: () => ({ ...wallOpacities }),
      /** Animated lighting state: mode, how many lamp lights / shadowed lamps / window sun beams there are. */
      getLighting: () => ({
        mode: lightingAnim.mode,
        animating: lightingAnim.animating,
        darkness: lightingAnim.darkness,
        lampLights: lightingAnim.lampLights,
        lampShadows: lightingAnim.lampShadows,
        sunBeams: lightingAnim.sunBeams,
        lights: (() => {
          const out: { name: string; type: string; intensity: number; castShadow: boolean; color: string }[] = [];
          get().scene.traverse((o) => {
            const l = o as unknown as { isLight?: boolean; intensity: number; color: { getHexString: () => string } };
            if (l.isLight) out.push({ name: o.name, type: o.type, intensity: l.intensity, castShadow: o.castShadow, color: `#${l.color.getHexString()}` });
          });
          return out;
        })(),
      }),
      getCamera: () => {
        const { camera, controls } = get();
        const t = (controls as unknown as { target?: Vector3 } | null)?.target;
        return { position: camera.position.toArray(), target: t ? t.toArray() : null };
      },
      /**
       * Client (page) coordinates of the center of an item's largest part (a point that is actually on the
       * item, unlike the bbox center of e.g. a desk), or null if not found / behind the camera.
       */
      itemScreenPosition: (id: string) => {
        const item = usePlanner.getState().items.find((it) => it.id === id);
        if (!item) return null;
        const { camera, gl } = get();
        const vol = (p: ShapePart) => p.size.x * p.size.y * p.size.z;
        const part = [...item.parts].sort((a, b) => vol(b) - vol(a))[0];
        const local = part ? partTransform(part, item.dims).position : [0, item.dims.h / 2, 0];
        const v = new Vector3(...local)
          .applyAxisAngle(new Vector3(0, 1, 0), item.rotationY)
          .add(new Vector3(item.position.x, item.position.y, item.position.z))
          .project(camera);
        if (v.z > 1) return null;
        const rect = gl.domElement.getBoundingClientRect();
        return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
      },
      /** Client (page) coordinates of a room-space point, or null if it is behind the camera. */
      worldToScreen: (x: number, y: number, z: number) => {
        const { camera, gl } = get();
        const v = new Vector3(x, y, z).project(camera);
        if (v.z > 1) return null;
        const rect = gl.domElement.getBoundingClientRect();
        return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
      },
    };
    return () => {
      delete w.__plannerDebug;
    };
  }, [get]);
  return null;
}
