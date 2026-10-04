// Global keyboard shortcuts for the planner (lives inside the Canvas so it can read the camera).
import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { Vector3 } from "three";
import { usePlanner } from "../state/store";
import { nearestWall } from "../lib/geometry";
import { normalizeAngle, nudgeAxes, snapStep } from "./dragMath";

const ROTATE_STEP = Math.PI / 12; // 15°

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

export function KeyboardShortcuts() {
  const get = useThree((s) => s.get);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      const s = usePlanner.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const sel = s.items.find((it) => it.id === s.selectedId);

      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && key === "y") {
        e.preventDefault();
        s.redo();
        return;
      }
      if (mod && key === "d") {
        e.preventDefault();
        if (sel) s.duplicateItem(sel.id);
        return;
      }
      if (mod || e.altKey) return;

      if (e.key === "Escape") {
        s.select(null);
        s.setPreview(null);
        return;
      }
      if (!sel) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        s.removeItem(sel.id);
        return;
      }
      if (key === "r") {
        e.preventDefault();
        // Wall-mounted items always face out from their wall; turning them would tilt them off it.
        if (sel.locked || sel.mount === "wall") return;
        s.updateItem(sel.id, { rotationY: normalizeAngle(sel.rotationY + (e.shiftKey ? -ROTATE_STEP : ROTATE_STEP)) });
        return;
      }
      if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        if (sel.locked) return;
        const step = snapStep(s.units) * (e.shiftKey ? 10 : 1);
        // Arrow directions follow the camera, snapped to the room axes.
        const { camera, controls } = get();
        const target = (controls as unknown as { target?: Vector3 } | null)?.target ?? new Vector3();
        const axes = nudgeAxes({ x: target.x - camera.position.x, z: target.z - camera.position.z });
        const p = { ...sel.position };
        if (sel.mount === "wall") {
          const wall = nearestWall(sel.position, s.room);
          const alongX = wall === "north" || wall === "south";
          const rightAlong = (alongX ? axes.right.x : axes.right.z) || 1;
          if (e.key === "ArrowUp") p.y += step;
          else if (e.key === "ArrowDown") p.y -= step;
          else {
            const dir = (e.key === "ArrowRight" ? 1 : -1) * Math.sign(rightAlong);
            if (alongX) p.x += dir * step;
            else p.z += dir * step;
          }
        } else {
          const v =
            e.key === "ArrowUp" ? axes.forward : e.key === "ArrowDown" ? { x: -axes.forward.x, z: -axes.forward.z } : e.key === "ArrowRight" ? axes.right : { x: -axes.right.x, z: -axes.right.z };
          p.x += v.x * step;
          p.z += v.z * step;
        }
        s.updateItem(sel.id, { position: p });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [get]);

  return null;
}
