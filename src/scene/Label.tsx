// Small non-interactive HTML label anchored to a 3D point.
import { useCallback, useContext, useRef, type ReactNode, type RefObject } from "react";
import { Html } from "@react-three/drei";
import { Vector3, type Camera, type Object3D } from "three";
import { LabelPortalContext } from "./shared3d";
import { getViewportInsetRight, getViewportInsetTop } from "./cameraBus";
import { clampLabelPosition } from "./labelMath";

const tmp = new Vector3();

export function Label({ position, zIndex = 20, children }: { position?: [number, number, number]; zIndex?: number; children: ReactNode }) {
  const portal = useContext(LabelPortalContext);
  const box = useRef<HTMLDivElement>(null);
  const calculatePosition = useCallback((el: Object3D, camera: Camera, size: { width: number; height: number }) => {
    tmp.setFromMatrixPosition(el.matrixWorld).project(camera);
    const x = (tmp.x + 1) * (size.width / 2);
    const y = (1 - tmp.y) * (size.height / 2);
    const b = box.current;
    if (!b) return [x, y];
    return clampLabelPosition(x, y, { width: b.offsetWidth, height: b.offsetHeight }, { ...size, insetRight: getViewportInsetRight(), insetTop: getViewportInsetTop() });
  }, []);
  return (
    <Html
      position={position}
      center
      portal={(portal ?? undefined) as RefObject<HTMLElement> | undefined}
      zIndexRange={[zIndex, 0]}
      pointerEvents="none"
      style={{ pointerEvents: "none" }}
      calculatePosition={calculatePosition}
    >
      <div ref={box}>{children}</div>
    </Html>
  );
}
