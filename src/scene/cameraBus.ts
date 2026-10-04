export type CameraPreset = "iso" | "top" | "eye";

type Listener = (p: CameraPreset) => void;
const listeners = new Set<Listener>();

/** Ask the scene to move the camera to a preset view. */
export function setCameraPreset(p: CameraPreset): void {
  listeners.forEach((l) => l(p));
}

/** Used inside the scene to react to preset requests. Returns an unsubscribe fn. */
export function onCameraPreset(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// Width (px) of UI panels floating over the right edge of the 3D view (the inspector). Camera presets frame
// the room in the part of the view that stays visible, and labels keep out from under the panel.
let insetRight = 0;
const insetListeners = new Set<() => void>();

export function setViewportInsetRight(px: number): void {
  const next = Math.max(0, px);
  if (Math.abs(next - insetRight) < 0.5) return;
  insetRight = next;
  insetListeners.forEach((l) => l());
}

/** Used inside the scene to re-frame a preset view when the panel opens or closes. Returns an unsubscribe fn. */
export function onViewportInsetChange(l: () => void): () => void {
  insetListeners.add(l);
  return () => insetListeners.delete(l);
}

export function getViewportInsetRight(): number {
  return insetRight;
}

// Height (px) of the chips floating along the top of the 3D view; labels slide below them.
let insetTop = 0;

export function setViewportInsetTop(px: number): void {
  insetTop = Math.max(0, px);
}

export function getViewportInsetTop(): number {
  return insetTop;
}

// Camera pose across an auto-update reload (src/ui/autoUpdate.ts): the rig publishes its pose, and on the next
// page load it starts from the saved one instead of the default iso view.
export interface CameraPose {
  preset: CameraPreset | "custom";
  position: [number, number, number];
  target: [number, number, number];
}

let poseSource: (() => CameraPose | null) | null = null;
let initialPose: CameraPose | null = null;

/** Used inside the scene: report the current pose on request. Returns an unsubscribe fn. */
export function setCameraPoseSource(fn: () => CameraPose | null): () => void {
  poseSource = fn;
  return () => {
    if (poseSource === fn) poseSource = null;
  };
}

export function getCameraPose(): CameraPose | null {
  return poseSource?.() ?? null;
}

/** Start the next mounted camera rig at this pose (once). */
export function setInitialCameraPose(p: CameraPose | null): void {
  initialPose = p;
}

/** Used inside the scene on mount. */
export function takeInitialCameraPose(): CameraPose | null {
  const p = initialPose;
  initialPose = null;
  return p;
}
