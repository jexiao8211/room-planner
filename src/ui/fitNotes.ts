// Fit hints for a product in this room (Find tab cards). In their own module so FindTab.tsx only exports
// components (React Fast Refresh can't hot-swap a file that also exports plain functions).
import type { ProductCandidate, Room, Units } from "../shared/types";
import { productFields } from "../state/store";
import { formatLength } from "../lib/units";
import { MIN_HANGING_BOTTOM } from "../lib/geometry";

/** Fit hints for this room: where a pendant's bottom ends up, and warnings for things that won't fit. */
export function fitNotes(c: ProductCandidate, room: Room, units: Units): { text: string; warn: boolean }[] {
  const notes: { text: string; warn: boolean }[] = [];
  if (c.mount === "ceiling") {
    const fitted = productFields(c, room).dims;
    if (fitted.h < c.dims.h - 1e-6) {
      notes.push({ text: `Listed drop too long for this room; cord shortened so it hangs ${formatLength(room.height - fitted.h, units)} above the floor`, warn: false });
    } else {
      const bottom = room.height - c.dims.h;
      notes.push({ text: `Bottom at ${formatLength(Math.max(0, bottom), units)} above the floor`, warn: bottom < MIN_HANGING_BOTTOM });
    }
  } else if (c.dims.h > room.height) {
    notes.push({ text: `Taller than the ${formatLength(room.height, units)} ceiling`, warn: true });
  }
  const [small, large] = [Math.min(c.dims.w, c.dims.d), Math.max(c.dims.w, c.dims.d)];
  if (large > Math.max(room.width, room.depth) || small > Math.min(room.width, room.depth)) {
    notes.push({ text: "Larger than the room's floor", warn: true });
  }
  return notes;
}
