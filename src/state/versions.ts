// Room design versions: named snapshots the user saves ("Option A") and automatic ones taken before big changes
// (building a room from photos, a chat turn with several changes, reset, import, restoring a version) plus at most
// one every 10 minutes while the design keeps changing. A separate persisted store (key room-planner-versions-v1),
// written by hand so it can stay inside a storage budget: when space runs out the oldest auto snapshots' thumbnails
// go first, then the oldest auto snapshots, then named versions' thumbnails. Named versions are never dropped.
import { create } from "zustand";
import type { DesignVersion, PlacedItem, Room } from "../shared/types";
import { defaultRoom, newId } from "../lib/presets";
import { usePlanner } from "./store";
import { dropDanglingSupports, normalizeItem, normalizeRoom, parsePlannerFile } from "./validate";

export const VERSIONS_KEY = "room-planner-versions-v1";
/** Newest auto snapshots kept (named versions are kept until deleted). */
export const MAX_AUTO = 30;
/** At most one periodic snapshot per this long while the design keeps changing. */
export const AUTO_INTERVAL_MS = 10 * 60 * 1000;
/**
 * Characters of localStorage the versions may use. The plan, chat and UI stores share the origin's ~5M-character
 * quota, and a full quota would silently stop the plan itself from saving, so versions stay well below it.
 */
export const STORAGE_BUDGET = 1_500_000;
export const MAX_NAME = 80;

/** Why an auto snapshot was taken (DesignVersion.reason) and the name it gets. */
export const AUTO_REASONS = {
  "photo-build": "Before photo build",
  chat: "Before chat changes",
  reset: "Before reset",
  import: "Before import",
  restore: "Before restoring",
  periodic: "Autosave",
} as const;
export type AutoReason = keyof typeof AUTO_REASONS;

/** The version fields the chat sees (ChatScene.versions). */
export type VersionSummary = Pick<DesignVersion, "id" | "name" | "createdAt" | "auto">;

/** What the chat executor needs (src/ui/chat/executeActions.ts ExecContext.versions). */
export interface VersionsApi {
  /** Save the current design as a named version. */
  save: (name?: string) => DesignVersion;
  /**
   * Restore a version by id (auto-saves the current design first). null when it doesn't exist. (Additive) `thumbnail`
   * of that "Before restoring" snapshot: "later" when the 3D view doesn't show the current design yet (mid chat turn).
   */
  restore: (id: string, opts?: { thumbnail?: "now" | "later" }) => DesignVersion | null;
  /** Take an auto snapshot of the current design (skipped when identical to the newest version). */
  autoSnapshot: (reason: AutoReason, opts?: { thumbnail?: "now" | "later" }) => DesignVersion | null;
  /** Newest first. */
  list: () => VersionSummary[];
}

export interface VersionsState {
  /** Newest first. */
  versions: DesignVersion[];
  /** Set when storage is full and something couldn't be kept / saved (shown in the panel). */
  storageNote: string | null;
  /**
   * (Additive) The version the plan was last saved as / restored from, with the plan's design key right after: while
   * the plan still has that key it counts as saved (no "unsaved changes" right after a restore). Not persisted.
   */
  baseline: { id: string; key: string } | null;
  /** Save the current design as a named version (default name "Version N"). */
  saveVersion: (name?: string) => DesignVersion;
  /**
   * Snapshot the current design automatically. Skipped (null) when it is identical to the newest version or is the
   * untouched default room. `label` is appended to the name ("Before restoring Option A").
   */
  autoSnapshot: (reason: AutoReason, opts?: { label?: string; thumbnail?: "now" | "later" }) => DesignVersion | null;
  /** Auto-saves the current design ("Before restoring <name>"), then loads the version (one undo step). */
  restoreVersion: (id: string, opts?: { thumbnail?: "now" | "later" }) => DesignVersion | null;
  renameVersion: (id: string, name: string) => void;
  deleteVersion: (id: string) => void;
  /** A named copy of a version ("<name> (copy)"), newest. */
  duplicateVersion: (id: string) => DesignVersion | null;
  /** Add versions from a file (ids already present are skipped). Returns how many were added. */
  mergeVersions: (list: DesignVersion[]) => number;
}

// ---------- thumbnails ----------

let thumbnailProvider: (() => string | undefined) | null = null;

/** The UI registers the 3D view's capture function here (the state layer doesn't import the scene). */
export function setThumbnailProvider(fn: (() => string | undefined) | null): void {
  thumbnailProvider = fn;
}

function captureNow(): string | undefined {
  try {
    const url = thumbnailProvider?.();
    return typeof url === "string" && url.startsWith("data:image/") ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Capture once the 3D view shows the saved design (a couple of frames after a change), and only if the plan is still
 * exactly that design.
 */
function captureLater(id: string, room: Room, items: PlacedItem[]): void {
  if (!thumbnailProvider || typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const p = usePlanner.getState();
      if (p.room !== room || p.items !== items) return;
      const thumbnail = captureNow();
      if (!thumbnail) return;
      const s = useVersions.getState();
      if (!s.versions.some((v) => v.id === id)) return;
      commitVersions(s.versions.map((v) => (v.id === id ? { ...v, thumbnail } : v)));
    }),
  );
}

// ---------- design identity ----------

const keys = new WeakMap<object, string>();

/**
 * The room as far as the design goes: the lighting mode (time of day) and the window blinds are how it is viewed, not
 * a change of design, so switching to Night or closing the blinds isn't "unsaved changes" or a reason for a snapshot.
 */
export function designRoom(room: Room): Omit<Room, "lighting"> {
  const { lighting: _mode, ...rest } = room;
  return { ...rest, openings: room.openings.map(({ covering: _c, ...o }) => o) };
}

/** The items as far as the design goes: a lamp's on/off, brightness and color are how the room is viewed (as above). */
export function designItems(items: PlacedItem[]): Omit<PlacedItem, "light">[] {
  return items.map((it) => {
    if (!("light" in it)) return it;
    const { light: _light, ...rest } = it;
    return rest;
  });
}

/** A stable string for a design (room without lighting / blinds, items without lamp settings), cached per object. */
export function designKey(d: { room: Room; items: PlacedItem[] }): string {
  const cached = keys.get(d);
  if (cached) return cached;
  const k = planKey(d);
  keys.set(d, k);
  return k;
}

/** The design key of a plan, not cached (the planner state is a fresh object each change). */
export function planKey(plan: { room: Room; items: PlacedItem[] }): string {
  return JSON.stringify([designRoom(plan.room), designItems(plan.items)]);
}

/**
 * True when the current plan differs from the newest version (or there is none), unless it is still exactly what it
 * was right after being saved / restored (`baseline`, see VersionsState.baseline).
 */
export function hasUnsavedChanges(
  plan: { room: Room; items: PlacedItem[] },
  versions: DesignVersion[],
  baseline: VersionsState["baseline"] = null,
): boolean {
  const newest = versions[0];
  const key = planKey(plan);
  if (baseline && baseline.key === key && versions.some((v) => v.id === baseline.id)) return false;
  return !newest || key !== designKey(newest);
}

function isUntouchedDefault(room: Room, items: PlacedItem[]): boolean {
  return items.length === 0 && JSON.stringify(room) === JSON.stringify(defaultRoom());
}

// ---------- normalization (storage and files are never trusted) ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function cleanName(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_NAME) : "";
}

/** A usable version, or null. */
export function normalizeVersion(v: unknown): DesignVersion | null {
  if (!isObj(v) || typeof v.id !== "string" || !v.id || !Array.isArray(v.items)) return null;
  const room = normalizeRoom(v.room);
  if (!room) return null;
  const items = dropDanglingSupports(v.items.map(normalizeItem).filter((it): it is PlacedItem => it !== null));
  const out: DesignVersion = {
    id: v.id.slice(0, 120),
    name: cleanName(v.name) || "Version",
    // Never in the future (a file from a machine with a wrong clock would pin every later version to that time).
    createdAt: typeof v.createdAt === "number" && Number.isFinite(v.createdAt) ? Math.min(Math.max(0, v.createdAt), Date.now() + 60_000) : 0,
    auto: v.auto === true,
    room,
    items,
  };
  if (typeof v.reason === "string" && v.reason) out.reason = v.reason.slice(0, 40);
  if (typeof v.thumbnail === "string" && /^data:image\/(?:jpeg|png|webp);base64,/.test(v.thumbnail) && v.thumbnail.length < 200_000) {
    out.thumbnail = v.thumbnail;
  }
  return out;
}

export function normalizeVersionList(v: unknown): DesignVersion[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: DesignVersion[] = [];
  for (const raw of v) {
    const ver = normalizeVersion(raw);
    if (!ver || seen.has(ver.id)) continue;
    seen.add(ver.id);
    out.push(ver);
  }
  return sortNewest(out);
}

const sortNewest = (list: DesignVersion[]) => [...list].sort((a, b) => b.createdAt - a.createdAt);

/** Keep the newest MAX_AUTO auto snapshots; named versions all stay. */
export function capAuto(list: DesignVersion[], max = MAX_AUTO): DesignVersion[] {
  let autos = 0;
  return list.filter((v) => !v.auto || ++autos <= max);
}

// ---------- quota-safe persistence ----------

const sizes = new WeakMap<DesignVersion, number>();
const sizeOf = (v: DesignVersion) => {
  let n = sizes.get(v);
  if (n === undefined) {
    n = JSON.stringify(v).length + 1;
    sizes.set(v, n);
  }
  return n;
};

/**
 * Trim a version list (newest first) to fit `budget` characters: drop the oldest auto snapshots' thumbnails, then the
 * oldest auto snapshots, then the oldest named versions' thumbnails. Named versions themselves are never dropped, so
 * the result can still be over budget. Returns the same array when nothing had to go.
 */
export function fitBudget(list: DesignVersion[], budget: number): DesignVersion[] {
  let total = list.reduce((n, v) => n + sizeOf(v), 40);
  if (total <= budget) return list;
  const out = [...list];
  const oldestFirst = (pred: (v: DesignVersion) => boolean) =>
    out
      .map((v, i) => [v, i] as const)
      .filter(([v]) => pred(v))
      .sort((a, b) => a[0].createdAt - b[0].createdAt);
  const steps: Array<() => boolean> = [
    () => {
      for (const [v, i] of oldestFirst((x) => x.auto && !!x.thumbnail)) {
        if (total <= budget) return true;
        const { thumbnail: _drop, ...rest } = v;
        total -= sizeOf(v) - sizeOf(rest);
        out[i] = rest;
      }
      return total <= budget;
    },
    () => {
      for (const [v] of oldestFirst((x) => x.auto)) {
        if (total <= budget) return true;
        total -= sizeOf(v);
        out.splice(out.indexOf(v), 1);
      }
      return total <= budget;
    },
    () => {
      for (const [v] of oldestFirst((x) => !x.auto && !!x.thumbnail)) {
        if (total <= budget) return true;
        const i = out.indexOf(v);
        const { thumbnail: _drop, ...rest } = v;
        total -= sizeOf(v) - sizeOf(rest);
        out[i] = rest;
      }
      return total <= budget;
    },
  ];
  for (const step of steps) if (step()) break;
  return out;
}

function writeStorage(json: string): boolean {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return true; // no storage (tests / blocked): keep working in memory
    ls.setItem(VERSIONS_KEY, json);
    return true;
  } catch {
    return false;
  }
}

/** Ids of deleted versions (this tab's and other tabs'), stored with the list. */
const deletedIds = new Set<string>();
/** Ids brought back on purpose (imported again) after being deleted: their stored tombstones no longer count. */
const revivedIds = new Set<string>();
const MAX_TOMBSTONES = 200;

/** The stored versions and the ids deleted in any tab (so another tab's next save doesn't bring them back). */
function readStored(): { versions: DesignVersion[]; deleted: string[] } {
  try {
    const raw = globalThis.localStorage?.getItem(VERSIONS_KEY);
    if (!raw) return { versions: [], deleted: [] };
    const data: unknown = JSON.parse(raw);
    const deleted = isObj(data) && Array.isArray(data.deleted) ? data.deleted.filter((x): x is string => typeof x === "string").slice(-MAX_TOMBSTONES) : [];
    return { versions: capAuto(normalizeVersionList(isObj(data) ? data.versions : data)), deleted };
  } catch {
    return { versions: [], deleted: [] };
  }
}

function readStorage(): DesignVersion[] {
  const { versions, deleted } = readStored();
  for (const id of deleted) deletedIds.add(id);
  return versions;
}

/**
 * This tab's list plus what other tabs stored since (the owner's tab and a preview tab both save): the union by id,
 * minus deleted ids. This tab's copy wins for an id both have. The same array when nothing changes.
 */
export function mergeWithStored(list: DesignVersion[]): DesignVersion[] {
  const stored = readStored();
  for (const id of stored.deleted) if (!revivedIds.has(id)) deletedIds.add(id);
  const have = new Set(list.map((v) => v.id));
  const extra = stored.versions.filter((v) => !have.has(v.id) && !deletedIds.has(v.id));
  const mine = list.filter((v) => !deletedIds.has(v.id));
  return extra.length || mine.length !== list.length ? sortNewest([...mine, ...extra]) : list;
}

/**
 * Persist a list, trimming it to the budget, and again (smaller) if the browser still refuses (quota taken by
 * something else). Returns the list as kept and a note when something had to go or nothing could be saved.
 */
export function persistVersions(list: DesignVersion[], write: (json: string) => boolean = writeStorage): { versions: DesignVersion[]; note: string | null } {
  let budget = STORAGE_BUDGET;
  let kept = fitBudget(list, budget);
  const deleted = [...deletedIds].slice(-MAX_TOMBSTONES);
  for (let attempt = 0; attempt < 6; attempt++) {
    const json = JSON.stringify(deleted.length ? { version: 1, versions: kept, deleted } : { version: 1, versions: kept });
    if (write(json)) {
      const lost = list.length - kept.length;
      const note =
        kept !== list
          ? `Browser storage is nearly full: ${lost ? `the ${lost} oldest auto snapshot${lost === 1 ? " was" : "s were"} removed` : "some older thumbnails were removed"}.`
          : null;
      return { versions: kept, note };
    }
    budget = Math.floor(json.length * 0.6);
    kept = fitBudget(kept, budget);
  }
  // Nothing fits: keep everything in memory for this session rather than lose it.
  return { versions: list, note: "Browser storage is full: versions can't be saved and will be lost on reload. Export them to keep them." };
}

/** Set + persist (the kept list is what the store shows). */
function commitVersions(list: DesignVersion[]): DesignVersion[] {
  const { versions, note } = persistVersions(capAuto(mergeWithStored(list)));
  useVersions.setState({ versions, storageNote: note });
  return versions;
}

// ---------- store ----------

/** Default name for a new named version: "Version N", N past both the named-version count and any "Version k". */
export function nextVersionName(named: Pick<DesignVersion, "name">[]): string {
  let n = named.length;
  for (const v of named) {
    const m = /^Version (\d+)$/.exec(v.name);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `Version ${n + 1}`;
}

/** When the last snapshot was taken (any kind): the periodic one waits AUTO_INTERVAL_MS after it. */
let lastSnapshotAt = Date.now();

function makeVersion(name: string, auto: boolean, reason?: string): DesignVersion {
  const { room, items } = usePlanner.getState();
  const v: DesignVersion = { id: newId("ver"), name, createdAt: Date.now(), auto, room, items };
  if (reason) v.reason = reason;
  return v;
}

export const useVersions = create<VersionsState>()((_set, get) => ({
  versions: readStorage(),
  storageNote: null,
  baseline: null,

  saveVersion: (name) => {
    const s = get();
    const v = makeVersion(cleanName(name) || nextVersionName(s.versions.filter((x) => !x.auto)), false);
    // Make sure createdAt orders after an auto snapshot taken in the same millisecond.
    if (s.versions[0] && v.createdAt <= s.versions[0].createdAt) v.createdAt = s.versions[0].createdAt + 1;
    lastSnapshotAt = Date.now();
    commitVersions([v, ...s.versions]);
    useVersions.setState({ baseline: { id: v.id, key: planKey(v) } });
    captureLater(v.id, v.room, v.items);
    return v;
  },

  autoSnapshot: (reason, opts) => {
    const { room, items } = usePlanner.getState();
    if (isUntouchedDefault(room, items)) return null;
    const s = get();
    const newest = s.versions[0];
    const plan = { room, items };
    if (newest && designKey(plan) === designKey(newest)) return null;
    const name = cleanName(opts?.label ? `${AUTO_REASONS[reason]} ${opts.label}` : AUTO_REASONS[reason]);
    const v = makeVersion(name, true, reason);
    keys.set(v, designKey(plan));
    if (newest && v.createdAt <= newest.createdAt) v.createdAt = newest.createdAt + 1;
    // "Before …" snapshots: the 3D view still shows the design being saved.
    if (opts?.thumbnail !== "later") {
      const t = captureNow();
      if (t) v.thumbnail = t;
    }
    lastSnapshotAt = Date.now();
    commitVersions([v, ...s.versions]);
    if (opts?.thumbnail === "later") captureLater(v.id, v.room, v.items);
    return v;
  },

  restoreVersion: (id, opts) => {
    const v = get().versions.find((x) => x.id === id);
    if (!v) return null;
    get().autoSnapshot("restore", { label: v.name, thumbnail: opts?.thumbnail });
    const planner = usePlanner.getState();
    // The design comes back; how the room is viewed stays as it is now (README: lighting mode, blinds and lamp
    // settings aren't design): the current mode, the blinds of windows that are still there, the settings of lamps
    // that are still there. Windows / lamps only the version has keep the version's.
    const now = planner.room;
    const covering = new Map(now.openings.map((o) => [o.id, o.covering]));
    const lights = new Map(planner.items.filter((it) => it.light).map((it) => [it.id, it.light!]));
    const room: Room = {
      ...v.room,
      lighting: now.lighting ?? "day",
      openings: v.room.openings.map((o) => {
        if (!covering.has(o.id)) return o;
        const c = covering.get(o.id);
        const { covering: _old, ...rest } = o;
        return c ? { ...rest, covering: c } : rest;
      }),
    };
    const items = v.items.map((it) => (lights.has(it.id) ? { ...it, light: { ...lights.get(it.id)! } } : it));
    planner.replaceRoom(room, items);
    planner.setPreview(null);
    // The plan now is that version (replaceRoom may re-seat things): not "unsaved changes" until it is edited.
    useVersions.setState({ baseline: { id: v.id, key: planKey(usePlanner.getState()) } });
    return v;
  },

  renameVersion: (id, name) => {
    const clean = cleanName(name);
    if (!clean) return;
    commitVersions(get().versions.map((v) => (v.id === id ? { ...v, name: clean } : v)));
  },

  deleteVersion: (id) => {
    const list = get().versions;
    if (!list.some((v) => v.id === id)) return;
    deletedIds.add(id);
    revivedIds.delete(id);
    commitVersions(list.filter((v) => v.id !== id));
  },

  duplicateVersion: (id) => {
    const src = get().versions.find((v) => v.id === id);
    if (!src) return null;
    const copy: DesignVersion = { ...src, id: newId("ver"), name: cleanName(`${src.name} (copy)`), auto: false, createdAt: Date.now() };
    delete copy.reason;
    const newest = get().versions[0];
    if (newest && copy.createdAt <= newest.createdAt) copy.createdAt = newest.createdAt + 1;
    commitVersions([copy, ...get().versions]);
    return copy;
  },

  mergeVersions: (incoming) => {
    const have = new Set(get().versions.map((v) => v.id));
    const added = incoming.filter((v) => !have.has(v.id));
    if (!added.length) return 0;
    // Importing a version on purpose brings it back even if it was deleted before (its tombstone goes).
    for (const v of added) {
      deletedIds.delete(v.id);
      revivedIds.add(v.id);
    }
    commitVersions(sortNewest([...get().versions, ...added]));
    return added.length;
  },
}));

// ---------- periodic snapshots ----------

let dirty = false;

/**
 * One check of the periodic snapshot: when the design changed since the last check and the last snapshot is at least
 * AUTO_INTERVAL_MS old, take one. Returns it (or null).
 */
export function periodicTick(now = Date.now()): DesignVersion | null {
  if (!dirty || now - lastSnapshotAt < AUTO_INTERVAL_MS) return null;
  dirty = false;
  const v = useVersions.getState().autoSnapshot("periodic", { thumbnail: "later" });
  lastSnapshotAt = now;
  return v;
}

/** Test hook: pretend the last snapshot was taken at `at`, and set whether the design changed since. */
export function _setPeriodicState(at: number, changed: boolean): void {
  lastSnapshotAt = at;
  dirty = changed;
}

/** Watch the plan and take a periodic snapshot while it keeps changing. Returns a stop function. */
export function startAutoVersions(checkEveryMs = 30_000): () => void {
  const unsub = usePlanner.subscribe((s, prev) => {
    // Switching the lighting mode, the blinds or a lamp isn't a design change (see designRoom, designItems).
    if (dirty) return;
    if (s.items !== prev.items && JSON.stringify(designItems(s.items)) !== JSON.stringify(designItems(prev.items))) dirty = true;
    else if (s.room !== prev.room && JSON.stringify(designRoom(s.room)) !== JSON.stringify(designRoom(prev.room))) dirty = true;
  });
  const timer = setInterval(() => periodicTick(), checkEveryMs);
  // Another tab saved / deleted a version: show it here too.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== VERSIONS_KEY) return;
    const merged = mergeWithStored(useVersions.getState().versions);
    if (merged !== useVersions.getState().versions) useVersions.setState({ versions: capAuto(merged) });
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    unsub();
    clearInterval(timer);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

// ---------- files ----------

export const VERSIONS_FILE_KIND = "room-planner-versions";

/**
 * Export the current plan together with every version. The file is also a valid plan file (room + items at the
 * top level), so older app versions can still import the current design from it.
 */
export function exportAllJSON(): string {
  const { room, items } = usePlanner.getState();
  return JSON.stringify({ version: 1, kind: VERSIONS_FILE_KIND, room, items, versions: useVersions.getState().versions }, null, 2);
}

/**
 * Import a plan file or an "all versions" file: auto-saves the current design ("Before import"), adds the file's
 * versions, and loads its plan. Throws (nothing changed) when the file is neither.
 */
export function importPlanOrVersions(json: string): { plan: boolean; versions: number } {
  const data: unknown = JSON.parse(json);
  const fileVersions = isObj(data) ? normalizeVersionList(data.versions) : [];
  const hasPlan = isObj(data) && isObj(data.room) && Array.isArray(data.items);
  // Validate the plan before changing anything (parsePlannerFile throws a readable error).
  if (hasPlan || !fileVersions.length) parsePlannerFile(json);
  useVersions.getState().autoSnapshot("import");
  const added = fileVersions.length ? useVersions.getState().mergeVersions(fileVersions) : 0;
  if (hasPlan) usePlanner.getState().importJSON(json);
  return { plan: hasPlan, versions: added };
}

/** The adapter the chat executor uses. */
export const versionsApi: VersionsApi = {
  save: (name) => useVersions.getState().saveVersion(name),
  restore: (id, opts) => useVersions.getState().restoreVersion(id, opts),
  autoSnapshot: (reason, opts) => useVersions.getState().autoSnapshot(reason, opts),
  list: () => useVersions.getState().versions.map(({ id, name, createdAt, auto }) => ({ id, name, createdAt, auto })),
};
