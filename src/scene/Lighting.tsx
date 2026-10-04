// Lighting rig: the mode's ambient / sky / key lights (tweened between Day, Evening and Night), a point light per
// lamp (only the brightest few cast real-time shadows) and a sun beam through every open window (Day / Evening).
// Shadow maps are only re-rendered when something that casts or receives them changes (gl.shadowMap.autoUpdate is
// off), so a still room with ~8 lamps costs no more per frame than one without shadows.
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { AdditiveBlending, BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Object3D, Vector3, type MeshBasicMaterial, type AmbientLight, type DirectionalLight, type HemisphereLight, type PointLight, type SpotLight } from "three";
import type { LightingMode, PlacedItem, Room } from "../shared/types";
import { usePlanner } from "../state/store";
import { LAMP_DECAY, MODE_PARAMS, lampCandela, lightAnchorWorld, lightingMode, shadowCasters, windowCovering } from "../lib/lighting";
import { SUN_DISTANCE, sunBeamFor, sunShaft, type SunInfo } from "./sunMath";
import { noRaycast } from "./shared3d";
import { dragState } from "./debugState";

/** Lamps that cast real-time (cube map) shadows; the rest light the room without them. */
export const LAMP_SHADOW_BUDGET = 2;
/** Windows that get a sun beam (each one is a shadowed spot light: the wall around the window blocks the rest). */
export const SUN_WINDOW_BUDGET = 4;
/** How fast the lighting follows a mode change (1/s): ~0.5 s to settle. */
const TWEEN_RATE = 7;
/** While dragging, the shadow maps follow every this many moves (and fully on release). */
const DRAG_SHADOW_EVERY = 6;
/** Peak opacity of the visible light shaft through a window (additive, so it only brightens). */
const SHAFT_OPACITY = 0.07;

/**
 * Current (animated) lighting values, read by other scene parts each frame (window glass, lamp glow, contact shadow)
 * and by the E2E debug hook.
 */
export const lightingAnim = {
  mode: "day" as LightingMode,
  /** 0 = Day ... 1 = Night (animated), for anything that just needs "how dark is it". */
  darkness: 0,
  lamp: MODE_PARAMS.day.lamp,
  glow: MODE_PARAMS.day.glow,
  sunIntensity: MODE_PARAMS.day.sun.intensity,
  sunColor: new Color(MODE_PARAMS.day.sun.color),
  glassColor: new Color(MODE_PARAMS.day.glass.color),
  glassOpacity: MODE_PARAMS.day.glass.opacity,
  glassEmissive: MODE_PARAMS.day.glass.emissive,
  contactShadow: MODE_PARAMS.day.contactShadow,
  background: new Color(MODE_PARAMS.day.background),
  /** True while values are still moving toward the mode's targets. */
  animating: false,
  /** Counters for tests: how many lamp point lights / sun beams exist and how many cast shadows. */
  lampLights: 0,
  lampShadows: 0,
  sunBeams: 0,
};

/** Set when something that casts shadows moved or changed; the shadow maps re-render on the next frames. */
export const shadowState = { dirtyFrames: 3 };
export function markShadowsDirty(frames = 2): void {
  shadowState.dirtyFrames = Math.max(shadowState.dirtyFrames, frames);
}

const tmp = new Color();
const tmpPos = new Vector3();

function lerpColor(c: Color, hex: string, k: number) {
  tmp.set(hex);
  c.lerp(tmp, k);
}

function approach(cur: number, target: number, k: number): number {
  const next = cur + (target - cur) * k;
  return Math.abs(target - next) < 1e-3 ? target : next;
}

export function LightingRig() {
  const mode = usePlanner((s) => lightingMode(s.room.lighting));
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const ambient = useRef<AmbientLight>(null);
  const hemi = useRef<HemisphereLight>(null);
  const key = useRef<DirectionalLight>(null);
  const fill = useRef<DirectionalLight>(null);
  const first = useRef(true);

  useEffect(() => {
    scene.background = lightingAnim.background;
    return () => {
      scene.background = null;
    };
  }, [scene]);

  useEffect(() => {
    lightingAnim.mode = mode;
    lightingAnim.animating = true;
  }, [mode]);

  // Rebuild shadow maps whenever the plan changes (items moved, lamps toggled, windows closed...). While an item is
  // dragged (a change every pointer move) only every few moves, and once more when it is let go: up to ~16 shadow
  // passes per frame (sun spots + lamp cube maps) on every drag frame would make dragging stutter.
  const dragTicks = useRef(0);
  const afterDrag = useRef(false);
  useEffect(() => usePlanner.subscribe((s, prev) => {
    if (s.items === prev.items && s.room === prev.room) return;
    if (dragState.active && s.room === prev.room) {
      afterDrag.current = true;
      if (++dragTicks.current % DRAG_SHADOW_EVERY === 0) markShadowsDirty(1);
      return;
    }
    markShadowsDirty();
  }), []);

  useFrame((_, dt) => {
    const p = MODE_PARAMS[mode];
    // Jump straight to the mode on the first frame (a reload at Night shouldn't fade in from Day).
    const k = first.current ? 1 : 1 - Math.exp(-Math.min(dt, 0.1) * TWEEN_RATE);
    first.current = false;
    const a = lightingAnim;
    const before = a.darkness + a.lamp + a.sunIntensity + a.glassOpacity;
    a.darkness = approach(a.darkness, mode === "night" ? 1 : mode === "evening" ? 0.5 : 0, k);
    a.lamp = approach(a.lamp, p.lamp, k);
    a.glow = approach(a.glow, p.glow, k);
    a.sunIntensity = approach(a.sunIntensity, p.sun.intensity, k);
    lerpColor(a.sunColor, p.sun.color, k);
    lerpColor(a.glassColor, p.glass.color, k);
    a.glassOpacity = approach(a.glassOpacity, p.glass.opacity, k);
    a.glassEmissive = approach(a.glassEmissive, p.glass.emissive, k);
    a.contactShadow = approach(a.contactShadow, p.contactShadow, k);
    lerpColor(a.background, p.background, k);
    if (ambient.current) {
      ambient.current.intensity = approach(ambient.current.intensity, p.ambient.intensity, k);
      lerpColor(ambient.current.color, p.ambient.color, k);
    }
    if (hemi.current) {
      hemi.current.intensity = approach(hemi.current.intensity, p.hemi.intensity, k);
      lerpColor(hemi.current.color, p.hemi.sky, k);
      lerpColor(hemi.current.groundColor, p.hemi.ground, k);
    }
    if (key.current) {
      key.current.intensity = approach(key.current.intensity, p.key.intensity, k);
      lerpColor(key.current.color, p.key.color, k);
      key.current.position.lerp(tmpPos.set(...p.key.position), k);
    }
    if (fill.current) fill.current.intensity = approach(fill.current.intensity, p.fill.intensity, k);
    const after = a.darkness + a.lamp + a.sunIntensity + a.glassOpacity;
    a.animating = Math.abs(after - before) > 1e-4;

    if (afterDrag.current && !dragState.active) {
      afterDrag.current = false;
      markShadowsDirty();
    }
    if (shadowState.dirtyFrames > 0) {
      gl.shadowMap.needsUpdate = true;
      shadowState.dirtyFrames--;
    }
  });

  const d = MODE_PARAMS.day;
  return (
    <>
      <ambientLight ref={ambient} intensity={d.ambient.intensity} color={d.ambient.color} />
      <hemisphereLight ref={hemi} args={[d.hemi.sky, d.hemi.ground, d.hemi.intensity]} />
      <directionalLight ref={key} position={d.key.position} intensity={d.key.intensity} color={d.key.color} />
      <directionalLight ref={fill} position={[-4, 5, -3]} intensity={d.fill.intensity} />
      <LampLights />
      <WindowSuns />
    </>
  );
}

// ---------- lamps ----------

interface LampInfo {
  id: string;
  item: PlacedItem;
  pos: { x: number; y: number; z: number };
  shadow: boolean;
}

function lampsOf(items: PlacedItem[], budget: number): LampInfo[] {
  const lit = items.filter((it) => it.light && !it.hidden);
  const anchors = lit.map((it) => ({ it, pos: lightAnchorWorld(it) }));
  const casters = shadowCasters(
    anchors.map(({ it, pos }) => ({ id: it.id, on: !!it.light?.on, intensity: it.light?.intensity ?? 0, x: pos.x, z: pos.z })),
    budget,
  );
  return anchors.map(({ it, pos }) => ({ id: it.id, item: it, pos, shadow: casters.has(it.id) }));
}

function LampLights() {
  const items = usePlanner((s) => s.items);
  // In daylight lamps add little and their shadows aren't worth the cost; at evening / night the brightest cast them.
  const dayMode = usePlanner((s) => lightingMode(s.room.lighting) === "day");
  const lamps = useMemo(() => lampsOf(items, dayMode ? 0 : LAMP_SHADOW_BUDGET), [items, dayMode]);
  useEffect(() => {
    lightingAnim.lampLights = lamps.length;
    lightingAnim.lampShadows = lamps.filter((l) => l.shadow).length;
    markShadowsDirty();
  }, [lamps]);
  return (
    <group name="lamp-lights">
      {lamps.map((l) => (
        <LampLight key={l.id} info={l} />
      ))}
    </group>
  );
}

function LampLight({ info }: { info: LampInfo }) {
  const ref = useRef<PointLight>(null);
  const light = info.item.light!;
  useFrame(() => {
    const pl = ref.current;
    if (!pl) return;
    pl.intensity = light.on ? lampCandela(light.intensity) * lightingAnim.lamp : 0;
  });
  return (
    <pointLight
      ref={ref}
      name={`lamp-light-${info.id}`}
      userData={{ itemId: info.id }}
      position={[info.pos.x, info.pos.y, info.pos.z]}
      color={light.color}
      intensity={0}
      distance={0}
      decay={LAMP_DECAY}
      castShadow={info.shadow}
      shadow-mapSize={[512, 512]}
      shadow-bias={-0.004}
      shadow-normalBias={0.02}
      shadow-radius={3}
      shadow-camera-near={0.05}
      shadow-camera-far={14}
    />
  );
}

// ---------- windows ----------

function WindowSuns() {
  const room = usePlanner((s) => s.room);
  const mode = lightingMode(room.lighting);
  const windows = useMemo(() => room.openings.filter((o) => o.kind === "window").slice(0, SUN_WINDOW_BUDGET), [room.openings]);
  // The beam angle follows the mode (evening sun is low); its position is fixed per mode, the strength tweens.
  const elevation = MODE_PARAMS[mode === "night" ? "day" : mode].sun.elevation;
  useEffect(() => {
    lightingAnim.sunBeams = windows.length;
    markShadowsDirty();
  }, [windows, elevation]);
  return (
    <group name="window-suns">
      {windows.map((o) => (
        <WindowSun key={o.id} info={sunBeamFor(o, room, elevation)} room={room} />
      ))}
    </group>
  );
}

function WindowSun({ info, room }: { info: SunInfo; room: Room }) {
  const ref = useRef<SpotLight>(null);
  const shaftMat = useRef<MeshBasicMaterial>(null);
  const target = useMemo(() => new Object3D(), []);
  const open = windowCovering(info.opening) === "open";
  const amount = useRef(open ? 1 : 0);
  useEffect(() => {
    target.position.set(...info.target);
    target.updateMatrixWorld();
  }, [target, info.target]);
  useFrame((_, dt) => {
    const sl = ref.current;
    if (!sl) return;
    amount.current = approach(amount.current, open ? 1 : 0, 1 - Math.exp(-Math.min(dt, 0.1) * TWEEN_RATE));
    const next = lightingAnim.sunIntensity * amount.current;
    // A beam that gives no light (night, closed blinds) just has intensity 0. It stays in the scene (switching it off
    // would change the number of lights and recompile every material's shader on each mode / blinds change).
    sl.intensity = next > 0.05 ? next : 0;
    sl.color.copy(lightingAnim.sunColor);
    const m = shaftMat.current;
    if (m) {
      // The shaft fades in with the sun (none at night) and a little stronger in the low evening sun.
      m.opacity = SHAFT_OPACITY * Math.min(1, lightingAnim.sunIntensity / 120) * amount.current;
      m.color.copy(lightingAnim.sunColor);
      m.visible = m.opacity > 0.002;
    }
  });
  const { x: dx, y: dy, z: dz } = info.dir;
  const shaft = useMemo(() => shaftGeometry(sunShaft(info.opening, room, { x: dx, y: dy, z: dz })), [info.opening, room, dx, dy, dz]);
  useEffect(() => () => shaft.dispose(), [shaft]);
  return (
    <>
      <primitive object={target} />
      <spotLight
        ref={ref}
        name={`sun-${info.opening.id}`}
        position={info.position}
        target={target}
        angle={info.angle}
        penumbra={0.35}
        decay={2}
        distance={0}
        intensity={0}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0006}
        shadow-normalBias={0.03}
        shadow-radius={4}
        shadow-camera-near={1}
        shadow-camera-far={SUN_DISTANCE + 12}
      />
      <mesh geometry={shaft} raycast={noRaycast} renderOrder={3} name={`sun-shaft-${info.opening.id}`}>
        <meshBasicMaterial
          ref={shaftMat}
          transparent
          vertexColors
          depthWrite={false}
          side={DoubleSide}
          blending={AdditiveBlending}
          opacity={0}
          toneMapped={false}
        />
      </mesh>
    </>
  );
}

/**
 * A light shaft as four quads (the sides of the window's prism of light), bright at the window and fading toward the
 * floor (RGBA vertex colors: the alpha ramps down).
 */
function shaftGeometry({ start, end }: { start: [number, number, number][]; end: [number, number, number][] }): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const NEAR = 0.9;
  const FAR = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const quad: [[number, number, number], number][] = [
      [start[i], NEAR],
      [start[j], NEAR],
      [end[j], FAR],
      [start[i], NEAR],
      [end[j], FAR],
      [end[i], FAR],
    ];
    for (const [p, a] of quad) {
      pos.push(...p);
      col.push(1, 1, 1, a);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new Float32BufferAttribute(col, 4));
  return g;
}
