// Where the translucent preview ("ghost") of a product candidate goes. Pure, so it is unit-tested.
import type { PlacedItem, ProductCandidate, Room } from "../shared/types";
import { productFields } from "../state/store";
import { attachToWall, constrainToRoom, nearestWall, placementForNewItem } from "../lib/geometry";
import type { PlacementHint } from "../lib/queryFilters";

/**
 * With a target item (the placeholder the search is for) the ghost takes the target's spot and rotation,
 * constrained for the candidate's own size and mount; otherwise it goes exactly where "Add to room" would put
 * it (a free corner when the search asked for one, else a free spot near the middle: placementForNewItem). `fields` are the item fields the candidate would get (hanging lamps
 * already fitted to the ceiling height).
 */
export function ghostPlacement(
  preview: ProductCandidate,
  room: Room,
  items: PlacedItem[],
  target?: PlacedItem,
  hint: PlacementHint | null = null,
) {
  const fields = productFields(preview, room);
  if (target) {
    const base = { position: { ...target.position }, rotationY: target.rotationY, dims: fields.dims, mount: fields.mount };
    if (fields.mount === "wall") {
      const wall = target.mount === "wall" ? undefined : nearestWall(target.position, room);
      return { ...attachToWall(base, room, wall), fields };
    }
    return { position: constrainToRoom(base, room), rotationY: target.rotationY, fields };
  }
  return { ...placementForNewItem(fields.dims, fields.mount, fields.name, room, items, hint), fields };
}
