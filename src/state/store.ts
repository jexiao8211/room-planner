import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import type { Dims, LightSettings, Mount, PlacedItem, ProductCandidate, Room, ShapePart, Units, WallSide } from "../shared/types";
import {
  attachToWall,
  constrainToRoom,
  defaultPlacement,
  fitHangingItem,
  defaultHangDrop,
  setHangingDrop,
  lampShade,
  MIN_HANG_BOTTOM,
  TARGET_HANGING_BOTTOM,
  surfacesFor,
  surfaceSpot,
  storedSurfaceY,
  supportToWorld,
  nearestWall,
  snapToCorner,
  snapToNearestCorner,
  snapToNearestWall,
  placementForNewItem,
  settleStacks,
  canSupport,
  wallForItem,
  type Corner,
} from "../lib/geometry";
import { defaultRoom, newId } from "../lib/presets";
import { DEFAULT_LIGHT, autoLight, isLampLike } from "../lib/lighting";
import { normalizePersisted, parsePlannerFile } from "./validate";
import type { PlacementHint } from "../lib/queryFilters";

interface Snapshot {
  room: Room;
  items: PlacedItem[];
}

export interface NewItemInput {
  name: string;
  dims: Dims;
  mount: Mount;
  color: string;
  parts: ShapePart[];
  origin: PlacedItem["origin"];
  product?: ProductCandidate;
  /** (Additive) Light source; lamp-like items (by name) get a default one when this is left out. */
  light?: LightSettings;
}

export interface PlannerState {
  room: Room;
  items: PlacedItem[];
  selectedId: string | null;
  units: Units;
  /** Candidate currently shown as a translucent ghost in the scene (not yet added). */
  preview: ProductCandidate | null;
  /**
   * Item the product search is "for" (e.g. a placeholder shape): the ghost previews at its spot and a
   * candidate can replace it in place. Not persisted.
   */
  previewTargetId: string | null;
  /**
   * (Additive) Where products from the current search go when previewed / added without a target, from the
   * search wording ("a hanging lamp in the corner"). Not persisted.
   */
  placementHint: PlacementHint | null;
  past: Snapshot[];
  future: Snapshot[];

  // --- room ---
  /** Patch room fields. Items are re-constrained to the new room bounds. */
  updateRoom: (patch: Partial<Room>) => void;
  /** Replace the room and all items (e.g. after photo analysis). Keeps undo history. */
  replaceRoom: (room: Room, items: PlacedItem[]) => void;

  // --- items ---
  /** Create an item at a sensible default spot; selects it; returns its id. */
  addItem: (input: NewItemInput) => string;
  /** Add a product candidate as an item (in a free corner when placementHint is "corner"). */
  addProduct: (candidate: ProductCandidate) => string;
  /**
   * Patch an item; position is re-constrained to the room and its mount.
   * Pass { transient: true } during drags so each frame doesn't create an undo step —
   * call checkpoint() once when the drag starts.
   */
  updateItem: (id: string, patch: Partial<Omit<PlacedItem, "id">>, opts?: { transient?: boolean }) => void;
  removeItem: (id: string) => void;
  duplicateItem: (id: string) => string | null;
  snapItemToWall: (id: string) => void;
  snapItemToCorner: (id: string) => void;
  /** Move an item into a chosen corner, inset from the walls for lamps (see cornerInset). */
  snapItemToCornerAt: (id: string, corner: Corner) => void;
  /**
   * Rest an item on top of another item (supportId): centered on it, turned to match it, becoming a floor item.
   * null takes it off: it goes back to the floor just in front of the stack it was on (its support, or what that
   * stands on, down to the item standing on the floor). Whatever rests on the item comes
   * along. One undo step. No-op (no undo step) for an unknown item / support, the item itself, a hidden or
   * non-floor support, anything resting on the item (no cycles), or a support too small for it (fitsOnTop, as
   * drag and the Inspector's "Put on…" list require).
   * (Additive) Part-aware: `surfaceY` picks a surface of the support (a cat tower's middle platform, 0 = the floor
   * under a desk; see supportSurfaces); without it the highest surface the item fits on. The item goes to the free
   * spot nearest the surface's middle. A ceiling item is never put on anything (no-op): it stays hanging.
   */
  placeOnTop: (id: string, supportId: string | null, surfaceY?: number) => void;
  /**
   * (Additive) Hang an item from the ceiling, `drop` meters from the ceiling down to its bottom (its cord is
   * stretched / added; see setHangingDrop). Without a drop: a ceiling item keeps its drop, a lamp-like item gets a
   * pendant's drop, anything else hangs flush. Off whatever it rested on; what rested on it drops. One undo step.
   * Returns the drop used (clamped to the room), or null for an unknown / locked item.
   */
  hangFromCeiling: (id: string, drop?: number) => number | null;
  /**
   * Swap an item (e.g. a placeholder shape) for a product, keeping its spot and rotation. One undo step.
   * Returns the new item's id (selected), or null if the target doesn't exist.
   */
  replaceItemWithProduct: (targetId: string, candidate: ProductCandidate) => string | null;
  select: (id: string | null) => void;
  setPreview: (candidate: ProductCandidate | null) => void;
  setPreviewTarget: (id: string | null) => void;
  setPlacementHint: (hint: PlacementHint | null) => void;

  // --- app ---
  setUnits: (units: Units) => void;
  /** Push the current state onto the undo stack (use at drag start). */
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  exportJSON: () => string;
  /** Throws on invalid JSON. */
  importJSON: (json: string) => void;
  resetAll: () => void;
}

const HISTORY_LIMIT = 100;

function snap(s: Pick<PlannerState, "room" | "items">): Snapshot {
  return { room: s.room, items: s.items };
}

/** Keep the selection only if the item still exists (e.g. after undoing its creation). */
function keepSelection(selectedId: string | null, items: PlacedItem[]): string | null {
  return selectedId && items.some((it) => it.id === selectedId) ? selectedId : null;
}

/** Re-apply room bounds and the mount rule; wall-mounted items are also kept flush against a wall. */
function placeInRoom(it: PlacedItem, room: Room, wall?: WallSide): PlacedItem {
  if (it.mount === "wall") return { ...it, ...attachToWall(it, room, wall) };
  return { ...it, position: constrainToRoom(it, room) };
}

/** Item fields for a product: hanging lamps get a realistic cord drop for this room. */
export function productFields(c: ProductCandidate, room: Pick<Room, "height">): NewItemInput {
  const parts: ShapePart[] = c.parts.length ? c.parts : [{ kind: "box", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } }];
  const fitted = c.mount === "ceiling" ? fitHangingItem(c.dims, parts, room.height) : { dims: c.dims, parts };
  return {
    name: c.name,
    dims: fitted.dims,
    mount: c.mount,
    color: c.colors[0]?.hex ?? "#999999",
    parts: fitted.parts,
    origin: "product",
    product: c,
    ...(isLampLike(c.name) || (c.mount === "ceiling" && isLampLike(c.summary ?? "")) ? { light: { ...DEFAULT_LIGHT } } : {}),
  };
}

/** A new item with a default light when it is lamp-like (lamp, pendant, sconce... in its name) and has none. */
function withAutoLight(item: PlacedItem): PlacedItem {
  if (item.light) return item;
  const light = autoLight({ name: item.name });
  if (light) return { ...item, light };
  if (!("light" in item)) return item;
  const { light: _none, ...rest } = item;
  return rest;
}

/**
 * localStorage access that never throws (absent in node/tests, blocked in some private modes,
 * or full). Persistence silently degrades to in-memory state.
 */
const safeLocalStorage: StateStorage = {
  getItem: (name) => {
    try {
      return globalThis.localStorage?.getItem(name) ?? null;
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      globalThis.localStorage?.setItem(name, value);
    } catch {
      // quota exceeded / storage blocked: keep working without persistence
    }
  },
  removeItem: (name) => {
    try {
      globalThis.localStorage?.removeItem(name);
    } catch {
      // ignore
    }
  },
};

export const usePlanner = create<PlannerState>()(
  persist(
    (set, get) => {
      /** Apply a mutation and record an undo step. */
      const commit = (fn: (s: PlannerState) => Partial<PlannerState>) =>
        set((s) => ({ ...fn(s), past: [...s.past, snap(s)].slice(-HISTORY_LIMIT), future: [] }));

      return {
        room: defaultRoom(),
        items: [],
        selectedId: null,
        units: "imperial",
        preview: null,
        previewTargetId: null,
        placementHint: null,
        past: [],
        future: [],

        updateRoom: (patch) =>
          commit((s) => {
            const room = { ...s.room, ...patch };
            // Wall items stay on the wall they were on in the old room (their distances to the walls change).
            const items = s.items.map((it) => placeInRoom(it, room, it.mount === "wall" ? wallForItem(it, s.room) : undefined));
            return { room, items: settleStacks(s.items, items, room) };
          }),

        replaceRoom: (room, items) =>
          commit((s) => ({
            // A room without a lighting mode (from photos, an older file) keeps the current one.
            room: room.lighting || !s.room.lighting ? room : { ...room, lighting: s.room.lighting },
            items: settleStacks([], items.map((it) => placeInRoom(withAutoLight(it), room)), room),
            selectedId: null,
            previewTargetId: null,
          })),

        addItem: (input) => {
          const id = newId("item");
          commit((s) => {
            const { position, rotationY } = defaultPlacement(input.dims, input.mount, s.room, s.items);
            const item: PlacedItem = withAutoLight({ id, position, rotationY, ...input });
            return { items: [...s.items, item], selectedId: id };
          });
          return id;
        },

        addProduct: (c) => {
          const input = productFields(c, get().room);
          const id = newId("item");
          commit((s) => {
            const { position, rotationY } = placementForNewItem(input.dims, input.mount, input.name, s.room, s.items, s.placementHint);
            return { items: [...s.items, { id, position, rotationY, ...input }], selectedId: id };
          });
          return id;
        },

        replaceItemWithProduct: (targetId, c) => {
          const target = get().items.find((it) => it.id === targetId);
          if (!target) return null;
          const id = newId("item");
          commit((s) => {
            const fields = productFields(c, s.room);
            // Keep the target's spot (and what it rests on). A wall product replacing a floor/ceiling item hangs on
            // the nearest wall.
            const base: PlacedItem = { ...fields, id, position: { ...target.position }, rotationY: target.rotationY };
            // A lamp swapped for a product lamp keeps its light settings (on/off, brightness, color).
            if (target.light && base.light) base.light = { ...target.light };
            if (target.supportId && fields.mount === "floor") {
              base.supportId = target.supportId;
              // On the same surface of it (under the desk, the cat tower's middle level).
              if (target.supportSurfaceY !== undefined) base.supportSurfaceY = target.supportSurfaceY;
            }
            const item = placeInRoom(base, s.room, fields.mount === "wall" && target.mount !== "wall" ? nearestWall(target.position, s.room) : undefined);
            // Whatever rested on the target now rests on the product (re-seated on its height).
            const items = s.items.map((it) => (it.id === targetId ? item : it.supportId === targetId ? { ...it, supportId: id } : it));
            return {
              items: settleStacks(s.items, items, s.room),
              selectedId: id,
              preview: null,
              previewTargetId: s.previewTargetId === targetId ? id : s.previewTargetId,
            };
          });
          return id;
        },

        updateItem: (id, patch, opts) => {
          const apply = (s: PlannerState) => {
            const items = s.items.map((it) => {
              if (it.id !== id) return it;
              const next: PlacedItem = { ...it, ...patch };
              if ("supportId" in patch && !patch.supportId) delete next.supportId;
              if (("supportSurfaceY" in patch && patch.supportSurfaceY === undefined) || !next.supportId) delete next.supportSurfaceY;
              // Switching to a wall mount: hang it on the wall nearest to where it stands.
              const becameWall = next.mount === "wall" && it.mount !== "wall";
              return placeInRoom(next, s.room, becameWall ? nearestWall(next.position, s.room) : undefined);
            });
            // An explicitly placed / assigned item stays where it was put; whatever rests on it follows it.
            const moved = "position" in patch || "rotationY" in patch ? [id] : [];
            const assigned = patch.supportId ? [id] : [];
            return { items: settleStacks(s.items, items, s.room, { moved, assigned }) };
          };
          if (opts?.transient) set(apply);
          else commit(apply);
        },

        removeItem: (id) =>
          commit((s) => ({
            // What rested on it drops to whatever is below (usually the floor).
            items: settleStacks(s.items, s.items.filter((it) => it.id !== id), s.room),
            selectedId: s.selectedId === id ? null : s.selectedId,
            previewTargetId: s.previewTargetId === id ? null : s.previewTargetId,
          })),

        duplicateItem: (id) => {
          const src = get().items.find((it) => it.id === id);
          if (!src) return null;
          const copyId = newId("item");
          commit((s) => {
            const p = { ...src.position, x: src.position.x + 0.3, z: src.position.z + 0.3 };
            if (src.mount === "wall") {
              // Wall items stay on their wall: offset along it only.
              const wall = wallForItem(src, s.room);
              const alongX = wall === "north" || wall === "south";
              p.x = src.position.x + (alongX ? 0.3 : 0);
              p.z = src.position.z + (alongX ? 0 : 0.3);
            }
            const copy = placeInRoom({ ...src, id: copyId, name: `${src.name} (copy)`, position: p }, s.room);
            // A stacked copy stays on the same support while it is still over it, else drops below.
            return { items: settleStacks(s.items, [...s.items, copy], s.room, { moved: [copyId] }), selectedId: copyId };
          });
          return copyId;
        },

        snapItemToWall: (id) =>
          commit((s) => ({
            items: settleStacks(s.items, s.items.map((it) => (it.id === id ? { ...it, ...snapToNearestWall(it, s.room) } : it)), s.room, { moved: [id] }),
          })),

        snapItemToCorner: (id) =>
          commit((s) => ({
            items: settleStacks(s.items, s.items.map((it) => (it.id === id ? { ...it, ...snapToNearestCorner(it, s.room) } : it)), s.room, { moved: [id] }),
          })),

        snapItemToCornerAt: (id, corner) =>
          commit((s) => ({
            items: settleStacks(s.items, s.items.map((it) => (it.id === id ? { ...it, ...snapToCorner(it, s.room, corner) } : it)), s.room, { moved: [id] }),
          })),

        placeOnTop: (id, supportId, surfaceY) => {
          const s0 = get();
          const item = s0.items.find((it) => it.id === id);
          if (!item) return;
          if (supportId) {
            // A hanging lamp stays a hanging lamp: stacking never turns a ceiling item into a floor item.
            if (item.mount === "ceiling") return;
            const support = s0.items.find((it) => it.id === supportId);
            if (!support || !canSupport(id, support, s0.items)) return;
            const surfaces = surfacesFor(item, support, support.rotationY);
            const surface =
              surfaceY === undefined
                ? surfaces.find((sf) => sf.kind !== "under")
                : surfaces.find((sf) => Math.abs(sf.y - surfaceY) < 0.01) ?? (Math.abs(surfaceY - support.dims.h) < 0.01 ? surfaces[0] : undefined);
            if (!surface) return;
            const spot = surfaceSpot(item, support, surface, support.rotationY);
            if (!spot) return;
            const at = supportToWorld(support, spot);
            commit((s) => {
              const next = s.items.map((it) => {
                if (it.id !== id) return it;
                const placed: PlacedItem = {
                  ...it,
                  mount: "floor",
                  supportId: support.id,
                  rotationY: support.rotationY,
                  position: { x: at.x, y: support.position.y + surface.y, z: at.z },
                };
                const stored = storedSurfaceY(support, surface);
                if (stored === undefined) delete placed.supportSurfaceY;
                else placed.supportSurfaceY = stored;
                return { ...placed, position: constrainToRoom(placed, s.room) };
              });
              return { items: settleStacks(s.items, next, s.room, { moved: [id], assigned: [id] }) };
            });
            return;
          }
          if (!item.supportId) return;
          // The bottom of the stack (a lamp on a box on a desk lands in front of the desk, not under it).
          let support = s0.items.find((it) => it.id === item.supportId);
          for (const seen = new Set([id]); support?.supportId && !seen.has(support.id); ) {
            seen.add(support.id);
            const below = s0.items.find((it) => it.id === support!.supportId);
            if (!below) break;
            support = below;
          }
          commit((s) => {
            const next = s.items.map((it) => {
              if (it.id !== id) return it;
              const off: PlacedItem = { ...it, position: { ...it.position, y: 0 } };
              delete off.supportId;
              delete off.supportSurfaceY;
              if (support) {
                // Just in front of its support (the support's +z side), so it doesn't end up underneath it.
                const dist = support.dims.d / 2 + it.dims.d / 2 + 0.05;
                off.position = {
                  x: support.position.x + Math.sin(support.rotationY) * dist,
                  y: 0,
                  z: support.position.z + Math.cos(support.rotationY) * dist,
                };
              }
              return { ...off, position: constrainToRoom(off, s.room) };
            });
            return { items: settleStacks(s.items, next, s.room, { moved: [id] }) };
          });
        },

        hangFromCeiling: (id, drop) => {
          const s0 = get();
          const item = s0.items.find((it) => it.id === id);
          if (!item || item.locked) return null;
          const room = s0.room;
          // A standing lamp taller than a pendant's drop (a floor lamp) hangs as a pendant: its shade on a cord.
          const lamp = isLampLike(item.name) && item.mount !== "ceiling" && item.dims.h > room.height - TARGET_HANGING_BOTTOM;
          const body = (lamp ? lampShade(item.dims, item.parts) : null) ?? { dims: item.dims, parts: item.parts };
          const wanted = typeof drop === "number" && Number.isFinite(drop) ? drop : defaultHangDrop({ ...item, dims: body.dims }, room.height, isLampLike(item.name));
          const shaped = setHangingDrop(body.dims, body.parts, wanted, room.height - MIN_HANG_BOTTOM);
          commit((s) => {
            const next = s.items.map((it) => {
              if (it.id !== id) return it;
              const hung: PlacedItem = { ...it, mount: "ceiling", dims: shaped.dims, parts: shaped.parts };
              delete hung.supportId;
              delete hung.supportSurfaceY;
              delete hung.droppedFromId;
              delete hung.droppedSurfaceY;
              return placeInRoom(hung, s.room);
            });
            return { items: settleStacks(s.items, next, s.room, { moved: [id] }) };
          });
          return shaped.drop;
        },

        select: (id) => set({ selectedId: id }),
        setPreview: (candidate) => set({ preview: candidate }),
        setPreviewTarget: (id) => set({ previewTargetId: id }),
        setPlacementHint: (hint) => set({ placementHint: hint }),
        setUnits: (units) => set({ units }),

        checkpoint: () => set((s) => ({ past: [...s.past, snap(s)].slice(-HISTORY_LIMIT), future: [] })),

        undo: () =>
          set((s) => {
            const prev = s.past[s.past.length - 1];
            if (!prev) return {};
            return {
              ...prev,
              selectedId: keepSelection(s.selectedId, prev.items),
              previewTargetId: keepSelection(s.previewTargetId, prev.items),
              past: s.past.slice(0, -1),
              future: [snap(s), ...s.future],
            };
          }),

        redo: () =>
          set((s) => {
            const next = s.future[0];
            if (!next) return {};
            return {
              ...next,
              selectedId: keepSelection(s.selectedId, next.items),
              previewTargetId: keepSelection(s.previewTargetId, next.items),
              past: [...s.past, snap(s)].slice(-HISTORY_LIMIT),
              future: s.future.slice(1),
            };
          }),

        exportJSON: () => JSON.stringify({ version: 1, room: get().room, items: get().items }, null, 2),

        importJSON: (json) => {
          const { room, items } = parsePlannerFile(json);
          get().replaceRoom(room, items);
        },

        resetAll: () => commit(() => ({ room: defaultRoom(), items: [], selectedId: null, preview: null, previewTargetId: null })),
      };
    },
    {
      name: "room-planner-v1",
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (s) => ({ room: s.room, items: s.items, units: s.units }),
      // Never trust storage: a bad item there would otherwise crash the scene on every reload.
      merge: (persisted, current) => ({ ...current, ...normalizePersisted(persisted) }),
    },
  ),
);

/** Selector helper: the currently selected item (or undefined). */
export const selectSelectedItem = (s: PlannerState) => s.items.find((it) => it.id === s.selectedId);
