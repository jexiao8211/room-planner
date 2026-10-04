// Public surface of the 3D scene. The UI imports ONLY from this file.
// (Stub written during scaffolding; the scene builder replaces the implementations, not the signatures.)
export { Scene } from "./Scene";
export { setCameraPreset, setViewportInsetRight, setViewportInsetTop } from "./cameraBus";
export type { CameraPreset, CameraPose } from "./cameraBus";
export { getCameraPose, setInitialCameraPose } from "./cameraBus";
export { isSceneInteracting } from "./sceneActivity";
export { captureThumbnail } from "./thumbnail";
