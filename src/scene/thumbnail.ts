// Small JPEG snapshots of the 3D view (design version thumbnails). <ThumbnailSource /> (inside the Canvas) registers
// the live renderer; captureThumbnail renders one fresh frame and scales it down. Rendering right before reading the
// canvas means the drawing buffer holds that frame, so preserveDrawingBuffer isn't needed.
import { useEffect } from "react";
import { useThree, type RootState } from "@react-three/fiber";

let getRoot: (() => RootState) | null = null;

export function ThumbnailSource() {
  const get = useThree((s) => s.get);
  useEffect(() => {
    getRoot = get;
    return () => {
      if (getRoot === get) getRoot = null;
    };
  }, [get]);
  return null;
}

/** A JPEG data URL of the current 3D view, at most `maxPx` on its long edge; undefined when there is no view. */
export function captureThumbnail(maxPx = 200, quality = 0.72): string | undefined {
  const root = getRoot?.();
  if (!root || typeof document === "undefined") return undefined;
  try {
    const { gl, scene, camera } = root;
    gl.render(scene, camera);
    const src = gl.domElement;
    if (!src.width || !src.height) return undefined;
    const k = Math.min(1, maxPx / Math.max(src.width, src.height));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(src.width * k));
    out.height = Math.max(1, Math.round(src.height * k));
    const g = out.getContext("2d");
    if (!g) return undefined;
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(src, 0, 0, out.width, out.height);
    const url = out.toDataURL("image/jpeg", quality);
    return url.startsWith("data:image/jpeg") ? url : undefined;
  } catch {
    return undefined;
  }
}
