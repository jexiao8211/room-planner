// OrbitControls plus animated preset views (iso / top / eye) driven through cameraBus.
import { useCallback, useEffect, useLayoutEffect, useRef, type ComponentRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Vector3, type PerspectiveCamera } from "three";
import { usePlanner } from "../state/store";
import {
  getViewportInsetRight,
  onCameraPreset,
  onViewportInsetChange,
  setCameraPoseSource,
  takeInitialCameraPose,
  type CameraPreset,
} from "./cameraBus";
import { PRESET_FOV, clipPlanes, presetView, roomSizeChangedSignificantly } from "./cameraViews";
import { cameraState, dragState, pointerState } from "./debugState";

const ANIM_SECONDS = 0.55;
/**
 * A re-frame caused by a press in the 3D view (click an item, so the inspector opens) waits until the pointer has
 * been up this long, so "click it, then press on it again to drag" still finds the item where it was.
 */
export const REFRAME_DELAY_MS = 700;
/** Keep a selected item at least this far (px) left of the inspector's edge. */
const REVEAL_MARGIN = 48;

interface CameraAnim {
  fromPos: Vector3;
  toPos: Vector3;
  fromTarget: Vector3;
  toTarget: Vector3;
  fromFov: number;
  toFov: number;
  fromShift: number;
  toShift: number;
  t: number;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function CameraRig() {
  const room = usePlanner((s) => s.room);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const anim = useRef<CameraAnim | null>(null);
  const roomRef = useRef(room);
  roomRef.current = room;
  /**
   * Horizontal shift (px) of the projection center. A preset taken while a panel covers the right edge of the
   * view frames the room in the part that stays visible. It only changes when a preset is applied, never when
   * the panel opens or closes, so the scene never jumps under the pointer.
   */
  const shift = useRef(0);
  /** Panel width the current preset framing was computed for. */
  const framedInset = useRef(0);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const applied = useRef({ shift: NaN, width: 0, height: 0, fov: 0, near: 0, far: 0 });

  const goTo = useCallback(
    (preset: CameraPreset, animate: boolean) => {
      const ctl = controls.current;
      if (!ctl) return;
      const fov = PRESET_FOV[preset];
      const inset = Math.min(getViewportInsetRight(), size.width * 0.6);
      const visibleW = Math.max(1, size.width - inset);
      const view = presetView(preset, roomRef.current, visibleW / Math.max(size.height, 1), fov);
      const toPos = new Vector3(view.position.x, view.position.y, view.position.z);
      const toTarget = new Vector3(view.target.x, view.target.y, view.target.z);
      const toShift = inset / 2;
      framedInset.current = inset;
      cameraState.preset = preset;
      if (!animate) {
        anim.current = null;
        cameraState.animating = false;
        camera.position.copy(toPos);
        camera.fov = fov;
        shift.current = toShift;
        ctl.target.copy(toTarget);
        ctl.update();
        return;
      }
      anim.current = {
        fromPos: camera.position.clone(),
        toPos,
        fromTarget: ctl.target.clone(),
        toTarget,
        fromFov: camera.fov,
        toFov: fov,
        fromShift: shift.current,
        toShift,
        t: 0,
      };
      cameraState.animating = true;
    },
    [camera, size.width, size.height],
  );

  useEffect(() => onCameraPreset((p) => goTo(p, true)), [goTo]);

  const goToRef = useRef(goTo);
  goToRef.current = goTo;

  /** The preset framing was made for a different panel width than the one now covering the view. */
  const framingStale = () => {
    const inset = Math.min(getViewportInsetRight(), sizeRef.current.width * 0.6);
    return Math.abs(framedInset.current - inset) > 1;
  };

  // Deferred re-frame for changes that came from a press in the 3D view (see REFRAME_DELAY_MS). If another press
  // is under way when it fires, it waits for that press's release instead; after an item drag it waits for the
  // next selection from outside the 3D view (see below), so the scene never moves while the user works in it.
  const reframeTimer = useRef<number | null>(null);
  const scheduleReframe = useCallback(() => {
    if (reframeTimer.current !== null) window.clearTimeout(reframeTimer.current);
    reframeTimer.current = window.setTimeout(() => {
      reframeTimer.current = null;
      if (pointerState.down || dragState.active) return;
      if (cameraState.preset === "custom" || !framingStale()) return;
      goToRef.current(cameraState.preset, true);
    }, REFRAME_DELAY_MS);
  }, []);
  useEffect(
    () => () => {
      if (reframeTimer.current !== null) window.clearTimeout(reframeTimer.current);
    },
    [],
  );

  // Release of a press that started in the 3D view. A click (no item drag) re-frames shortly afterwards.
  useEffect(() => {
    const onUp = () => {
      if (!pointerState.down) return;
      pointerState.down = false;
      pointerState.lastCanvasPointerUp = performance.now();
      if (!dragState.moved) scheduleReframe();
    };
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [scheduleReframe]);

  // The inspector opened or closed. Re-frame the current preset into the part of the view that stays visible
  // (not after the user orbited away from the preset). Never while the pointer is down in the 3D view: a change
  // caused by a press there (click an item, click empty floor) re-frames a moment after the release instead.
  useEffect(
    () =>
      onViewportInsetChange(() => {
        if (pointerState.down || performance.now() - pointerState.lastCanvasPointerUp < REFRAME_DELAY_MS) {
          scheduleReframe();
          return;
        }
        if (cameraState.preset === "custom") return;
        goTo(cameraState.preset, true);
      }),
    [goTo, scheduleReframe],
  );

  // Selection changed from outside the 3D view (sidebar list, Add tab, a product added, keyboard): make sure the
  // item isn't hidden under the inspector. A stale preset framing is redone; otherwise the view pans just enough.
  useEffect(() => {
    const reveal = () => {
      const ctl = controls.current;
      if (!ctl || pointerState.down || anim.current) return;
      if (cameraState.preset !== "custom" && framingStale()) {
        goToRef.current(cameraState.preset, true);
        return;
      }
      const { items, selectedId } = usePlanner.getState();
      const item = items.find((it) => it.id === selectedId);
      const { width, height } = sizeRef.current;
      const inset = Math.min(getViewportInsetRight(), width * 0.6);
      if (!item || inset <= 0 || width <= 0 || height <= 0) return;
      const center = new Vector3(item.position.x, item.position.y + item.dims.h / 2, item.position.z);
      const ndc = center.clone().project(camera);
      if (ndc.z > 1 || ndc.z < -1) return;
      const px = ((ndc.x + 1) / 2) * width;
      const visibleRight = width - inset;
      if (px <= visibleRight - REVEAL_MARGIN) return;
      // Pan sideways so the item lands in the middle of the visible part of the view.
      const viewDir = camera.getWorldDirection(new Vector3());
      const depth = Math.max(0.1, center.clone().sub(camera.position).dot(viewDir));
      const worldPerPx = (2 * depth * Math.tan((camera.fov * Math.PI) / 360)) / height;
      const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      const move = right.multiplyScalar((px - visibleRight / 2) * worldPerPx);
      anim.current = {
        fromPos: camera.position.clone(),
        toPos: camera.position.clone().add(move),
        fromTarget: ctl.target.clone(),
        toTarget: ctl.target.clone().add(move),
        fromFov: camera.fov,
        toFov: camera.fov,
        fromShift: shift.current,
        toShift: shift.current,
        t: 0,
      };
      cameraState.preset = "custom";
      cameraState.animating = true;
    };
    return usePlanner.subscribe((s, prev) => {
      if (s.selectedId === prev.selectedId || !s.selectedId || pointerState.down) return;
      requestAnimationFrame(reveal);
    });
  }, [camera]);

  // Lets the UI save the view before an auto-update reload.
  useEffect(
    () =>
      setCameraPoseSource(() => {
        const ctl = controls.current;
        if (!ctl) return null;
        const p = camera.position;
        const t = ctl.target;
        return { preset: cameraState.preset, position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
      }),
    [camera],
  );

  // Frame the room on mount, and re-frame when its size changes a lot (e.g. after photo analysis).
  const framed = useRef<{ width: number; depth: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const cur = { width: room.width, depth: room.depth, height: room.height };
    if (!framed.current) {
      framed.current = cur;
      // After an auto-update reload, start where the previous page was looking.
      const saved = takeInitialCameraPose();
      goTo(saved && saved.preset !== "custom" ? saved.preset : "iso", false);
      const ctl = controls.current;
      if (saved?.preset === "custom" && ctl) {
        camera.position.set(...saved.position);
        ctl.target.set(...saved.target);
        ctl.update();
        cameraState.preset = "custom";
      }
    } else if (roomSizeChangedSignificantly(cur, framed.current)) {
      framed.current = cur;
      goTo(cameraState.preset === "custom" ? "iso" : cameraState.preset, true);
    }
  }, [room.width, room.depth, room.height, goTo]);

  // The view itself was resized (window resize): re-fit the current preset unless the user has orbited away.
  const lastSize = useRef<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const prev = lastSize.current;
    lastSize.current = { width: size.width, height: size.height };
    if (!prev || (prev.width === size.width && prev.height === size.height)) return;
    if (cameraState.preset !== "custom" && !anim.current) goTo(cameraState.preset, false);
  }, [size.width, size.height, goTo]);

  useFrame((_, dt) => {
    const ctl = controls.current;
    if (!ctl) return;
    const a = anim.current;
    if (a) {
      a.t = Math.min(1, a.t + dt / ANIM_SECONDS);
      const k = easeInOut(a.t);
      camera.position.lerpVectors(a.fromPos, a.toPos, k);
      ctl.target.lerpVectors(a.fromTarget, a.toTarget, k);
      camera.fov = a.fromFov + (a.toFov - a.fromFov) * k;
      shift.current = a.fromShift + (a.toShift - a.fromShift) * k;
      ctl.update();
      if (a.t >= 1) {
        anim.current = null;
        cameraState.animating = false;
      }
    }

    // Projection: view shift, and clip planes that follow the viewing distance (the top view's long lens sits
    // far away; a fixed near plane would waste depth precision there and a fixed far plane could clip the room).
    const { near, far } = clipPlanes(camera.position.distanceTo(ctl.target), Math.max(room.width, room.depth, room.height));
    const last = applied.current;
    const changed =
      Number.isNaN(last.shift) ||
      Math.abs(shift.current - last.shift) > 0.01 ||
      last.width !== size.width ||
      last.height !== size.height ||
      last.fov !== camera.fov ||
      Math.abs(near - last.near) > last.near * 0.05 ||
      Math.abs(far - last.far) > last.far * 0.05;
    if (changed) {
      camera.near = near;
      camera.far = far;
      if (Math.abs(shift.current) > 0.01) camera.setViewOffset(size.width, size.height, shift.current, 0, size.width, size.height);
      else camera.clearViewOffset();
      camera.updateProjectionMatrix();
      applied.current = { shift: shift.current, width: size.width, height: size.height, fov: camera.fov, near, far };
    }
  });

  const orbitSeq = useRef(0);
  const orbitStart = useRef<{ pos: Vector3; target: Vector3; preset: CameraPreset | "custom" } | null>(null);

  const maxDim = Math.max(room.width, room.depth, room.height);
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.12}
      minDistance={0.3}
      maxDistance={maxDim * 60 + 40}
      maxPolarAngle={Math.PI / 2 - 0.03}
      onStart={() => {
        // Any user orbit/zoom/pan cancels a running preset animation and leaves the preset...
        const wasAnimating = anim.current !== null;
        anim.current = null;
        cameraState.animating = false;
        const ctl = controls.current;
        orbitSeq.current++;
        orbitStart.current =
          ctl && !wasAnimating ? { pos: camera.position.clone(), target: ctl.target.clone(), preset: cameraState.preset } : null;
        cameraState.preset = "custom";
      }}
      onEnd={() => {
        // ...unless it was only a click (e.g. on empty floor to deselect): nothing moved, so the preset still holds.
        const start = orbitStart.current;
        if (!start || start.preset === "custom") return;
        const seq = orbitSeq.current;
        window.setTimeout(() => {
          const ctl = controls.current;
          if (!ctl || seq !== orbitSeq.current || cameraState.preset !== "custom") return;
          if (camera.position.distanceTo(start.pos) < 1e-4 && ctl.target.distanceTo(start.target) < 1e-4) cameraState.preset = start.preset;
        }, 150);
      }}
    />
  );
}
