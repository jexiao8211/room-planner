import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignVersion, PlacedItem } from "../shared/types";
import { defaultRoom, fullPart } from "../lib/presets";

// An in-memory localStorage (node has none) that can be told to refuse writes (quota exceeded).
class MemoryStorage {
  map = new Map<string, string>();
  limit = Infinity;
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    if (value.length > this.limit) throw new DOMException("quota", "QuotaExceededError");
    this.map.set(key, String(value));
  }
}
const memory = new MemoryStorage();

type Versions = typeof import("./versions");
type Store = typeof import("./store");
let V: Versions;
let usePlanner: Store["usePlanner"];
const P = () => usePlanner.getState();
const VS = () => V.useVersions.getState();

beforeAll(async () => {
  vi.stubGlobal("localStorage", memory);
  ({ usePlanner } = await import("./store"));
  V = await import("./versions");
});

const box = (name: string): Omit<PlacedItem, "id" | "position" | "rotationY"> => ({
  name,
  dims: { w: 0.5, h: 0.5, d: 0.5 },
  mount: "floor",
  color: "#888888",
  parts: [fullPart("box")],
  origin: "shape",
});

const add = (name: string) => P().addItem(box(name));
const names = () => P().items.map((it) => it.name);

beforeEach(() => {
  memory.clear();
  memory.limit = Infinity;
  usePlanner.setState({ room: defaultRoom(), items: [], selectedId: null, past: [], future: [], preview: null });
  V.useVersions.setState({ versions: [], storageNote: null, baseline: null });
  V.setThumbnailProvider(null);
});

describe("save / restore", () => {
  it("saves a named version (default name Version N) and persists it", () => {
    add("Desk");
    const a = VS().saveVersion("Option A");
    expect(a.name).toBe("Option A");
    expect(a.auto).toBe(false);
    expect(a.items.map((it) => it.name)).toEqual(["Desk"]);
    const b = VS().saveVersion();
    expect(b.name).toBe("Version 2");
    expect(VS().versions.map((v) => v.name)).toEqual(["Version 2", "Option A"]);
    const stored = JSON.parse(memory.getItem(V.VERSIONS_KEY)!);
    expect(stored.versions.map((v: DesignVersion) => v.name)).toEqual(["Version 2", "Option A"]);
  });

  it("restore auto-saves the current design first, then loads the version as one undo step", () => {
    add("Desk");
    const a = VS().saveVersion("Option A");
    add("Bed");
    const pastBefore = P().past.length;
    expect(VS().restoreVersion(a.id)?.id).toBe(a.id);
    expect(names()).toEqual(["Desk"]);
    const newest = VS().versions[0];
    expect(newest).toMatchObject({ auto: true, reason: "restore", name: "Before restoring Option A" });
    expect(newest.items.map((it) => it.name)).toEqual(["Desk", "Bed"]);
    expect(P().past.length).toBe(pastBefore + 1);
    P().undo();
    expect(names()).toEqual(["Desk", "Bed"]);
  });

  it("restoring an unknown id does nothing", () => {
    add("Desk");
    expect(VS().restoreVersion("nope")).toBeNull();
    expect(names()).toEqual(["Desk"]);
    expect(VS().versions).toEqual([]);
  });

  it("rename, duplicate and delete", () => {
    add("Desk");
    const a = VS().saveVersion("Option A");
    VS().renameVersion(a.id, "  Cozy   layout ");
    expect(VS().versions[0].name).toBe("Cozy layout");
    VS().renameVersion(a.id, "   ");
    expect(VS().versions[0].name).toBe("Cozy layout");
    const copy = VS().duplicateVersion(a.id)!;
    expect(copy.name).toBe("Cozy layout (copy)");
    expect(copy.id).not.toBe(a.id);
    expect(VS().versions[0].id).toBe(copy.id);
    VS().deleteVersion(a.id);
    expect(VS().versions.map((v) => v.id)).toEqual([copy.id]);
  });

  it("a duplicated auto snapshot becomes a named version", () => {
    add("Desk");
    const auto = VS().autoSnapshot("reset")!;
    const copy = VS().duplicateVersion(auto.id)!;
    expect(copy.auto).toBe(false);
    expect(copy.reason).toBeUndefined();
  });
});

describe("auto snapshots", () => {
  it("skips a snapshot identical to the newest version, and the untouched default room", () => {
    expect(VS().autoSnapshot("reset")).toBeNull();
    add("Desk");
    VS().saveVersion("A");
    expect(VS().autoSnapshot("chat")).toBeNull();
    add("Bed");
    expect(VS().autoSnapshot("chat")?.name).toBe("Before chat changes");
    expect(VS().autoSnapshot("chat")).toBeNull();
    expect(VS().versions).toHaveLength(2);
  });

  it("keeps the newest 30 auto snapshots and every named version", () => {
    add("Desk");
    VS().saveVersion("Keep me");
    for (let i = 0; i < 35; i++) {
      add(`Box ${i}`);
      VS().autoSnapshot("periodic");
    }
    const autos = VS().versions.filter((v) => v.auto);
    expect(autos).toHaveLength(V.MAX_AUTO);
    expect(autos[0].items).toHaveLength(36);
    expect(VS().versions.some((v) => v.name === "Keep me")).toBe(true);
  });

  it("takes a thumbnail now for 'before' snapshots", () => {
    V.setThumbnailProvider(() => "data:image/jpeg;base64,AAAA");
    add("Desk");
    expect(VS().autoSnapshot("photo-build")?.thumbnail).toBe("data:image/jpeg;base64,AAAA");
    // A provider that throws or returns junk is ignored.
    V.setThumbnailProvider(() => {
      throw new Error("no webgl");
    });
    add("Bed");
    expect(VS().autoSnapshot("reset")?.thumbnail).toBeUndefined();
  });

  it("periodic: at most one per interval, only while the design changes", () => {
    add("Desk");
    const t0 = 1_000_000;
    V._setPeriodicState(t0, false);
    expect(V.periodicTick(t0 + V.AUTO_INTERVAL_MS + 1)).toBeNull(); // nothing changed
    V._setPeriodicState(t0, true);
    expect(V.periodicTick(t0 + 60_000)).toBeNull(); // too soon
    const v = V.periodicTick(t0 + V.AUTO_INTERVAL_MS);
    expect(v).toMatchObject({ auto: true, reason: "periodic", name: "Autosave" });
    add("Bed");
    V._setPeriodicState(t0 + V.AUTO_INTERVAL_MS, true);
    expect(V.periodicTick(t0 + V.AUTO_INTERVAL_MS + 5 * 60_000)).toBeNull();
    expect(V.periodicTick(t0 + 2 * V.AUTO_INTERVAL_MS)?.items).toHaveLength(2);
  });

  it("startAutoVersions marks the design dirty on changes and stops cleanly", () => {
    vi.useFakeTimers();
    try {
      add("Desk");
      V._setPeriodicState(Date.now() - V.AUTO_INTERVAL_MS - 1, false);
      const stop = V.startAutoVersions(1000);
      vi.advanceTimersByTime(1500);
      expect(VS().versions).toHaveLength(0);
      add("Bed");
      vi.advanceTimersByTime(1000);
      expect(VS().versions).toHaveLength(1);
      stop();
      add("Chair");
      V._setPeriodicState(0, true);
      vi.advanceTimersByTime(5000);
      expect(VS().versions).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("persistence", () => {
  const ver = (id: string, auto: boolean, createdAt: number, thumb = false, pad = 0): DesignVersion => ({
    id,
    name: id,
    createdAt,
    auto,
    room: defaultRoom(),
    items: pad ? [{ ...box("x".repeat(pad)), id: `it_${id}`, position: { x: 0, y: 0, z: 0 }, rotationY: 0 }] : [],
    ...(thumb ? { thumbnail: `data:image/jpeg;base64,${"A".repeat(5000)}` } : {}),
  });

  it("fitBudget drops old auto thumbnails, then old autos, then named thumbnails; never named versions", () => {
    const list = [ver("n2", false, 6, true), ver("a3", true, 5, true), ver("a2", true, 4, true), ver("n1", false, 3, true), ver("a1", true, 2, true)];
    const total = list.reduce((n, v) => n + JSON.stringify(v).length + 1, 40);
    expect(V.fitBudget(list, total)).toBe(list);
    // Room for everything but one thumbnail: the oldest auto loses its thumbnail.
    let out = V.fitBudget(list, total - 4000);
    expect(out.map((v) => [v.id, !!v.thumbnail])).toEqual([
      ["n2", true],
      ["a3", true],
      ["a2", true],
      ["n1", true],
      ["a1", false],
    ]);
    // Much less room: all autos go, then the older named version's thumbnail.
    out = V.fitBudget(list, 6000);
    expect(out.map((v) => v.id)).toEqual(["n2", "n1"]);
    expect(out.find((v) => v.id === "n1")!.thumbnail).toBeUndefined();
    // Impossible budget: named versions stay anyway.
    out = V.fitBudget(list, 10);
    expect(out.map((v) => v.id)).toEqual(["n2", "n1"]);
  });

  it("retries smaller when the browser refuses (quota), and never throws", () => {
    const list = [ver("n1", false, 9, true), ...Array.from({ length: 10 }, (_, i) => ver(`a${i}`, true, 8 - i * 0.1, true, 2000))];
    const full = JSON.stringify({ version: 1, versions: list }).length;
    let writes = 0;
    const res = V.persistVersions(list, (json) => {
      writes++;
      return json.length < full / 3;
    });
    expect(writes).toBeGreaterThan(1);
    expect(res.versions.length).toBeLessThan(list.length);
    expect(res.versions[0].id).toBe("n1");
    expect(res.note).toMatch(/storage is nearly full/);
    // Storage that refuses everything: keep it all in memory, with a warning.
    const none = V.persistVersions(list, () => false);
    expect(none.versions).toBe(list);
    expect(none.note).toMatch(/can't be saved/);
  });

  it("the store keeps working when localStorage throws", () => {
    memory.limit = 10;
    add("Desk");
    expect(() => VS().saveVersion("A")).not.toThrow();
    expect(VS().versions).toHaveLength(1);
    expect(VS().storageNote).toMatch(/can't be saved/);
  });

  it("normalizes untrusted data: bad versions are dropped, junk thumbnails removed, duplicates skipped", () => {
    const good = ver("v1", false, 5);
    const list = V.normalizeVersionList([
      good,
      { ...good },
      { id: "v2", name: "x", createdAt: 1, auto: true, room: { width: 0 }, items: [] },
      { id: "v3", name: 42, createdAt: "x", auto: "yes", room: defaultRoom(), items: [{ bad: true }], thumbnail: "javascript:alert(1)" },
      null,
    ]);
    expect(list.map((v) => v.id)).toEqual(["v1", "v3"]);
    const v3 = list[1];
    expect(v3).toMatchObject({ name: "Version", createdAt: 0, auto: false, items: [] });
    expect(v3.thumbnail).toBeUndefined();
  });
});

describe("files", () => {
  it("export all → import restores versions and the plan (and keeps the design being replaced)", () => {
    add("Desk");
    VS().saveVersion("Option A");
    add("Bed");
    const file = V.exportAllJSON();
    const parsed = JSON.parse(file);
    expect(parsed.kind).toBe(V.VERSIONS_FILE_KIND);
    expect(parsed.items.map((it: PlacedItem) => it.name)).toEqual(["Desk", "Bed"]);

    // The versions are gone (another browser): from memory and from storage.
    V.useVersions.setState({ versions: [] });
    memory.removeItem(V.VERSIONS_KEY);
    P().resetAll();
    add("Chair");
    const res = V.importPlanOrVersions(file);
    expect(res).toEqual({ plan: true, versions: 1 });
    expect(names()).toEqual(["Desk", "Bed"]);
    expect(VS().versions.map((v) => v.name)).toEqual(["Before import", "Option A"]);
    expect(VS().versions.find((v) => v.name === "Before import")!.items.map((it) => it.name)).toEqual(["Chair"]);
    // Importing the same file again adds no duplicate versions.
    expect(V.importPlanOrVersions(file).versions).toBe(0);
  });

  it("a plain plan file still imports (with a 'Before import' snapshot)", () => {
    add("Chair");
    const plan = JSON.stringify({ version: 1, room: defaultRoom(), items: [{ ...box("Sofa"), id: "s1", position: { x: 0, y: 0, z: 0 }, rotationY: 0 }] });
    expect(V.importPlanOrVersions(plan)).toEqual({ plan: true, versions: 0 });
    expect(names()).toEqual(["Sofa"]);
    expect(VS().versions[0].name).toBe("Before import");
  });

  it("an invalid file throws before anything changes", () => {
    add("Chair");
    expect(() => V.importPlanOrVersions(JSON.stringify({ hello: 1 }))).toThrow(/Not a Room Planner file/);
    expect(() => V.importPlanOrVersions("{nope")).toThrow();
    expect(names()).toEqual(["Chair"]);
    expect(VS().versions).toEqual([]);
  });
});

describe("helpers", () => {
  it("nextVersionName counts past existing names", () => {
    expect(V.nextVersionName([])).toBe("Version 1");
    expect(V.nextVersionName([{ name: "Option A" }])).toBe("Version 2");
    expect(V.nextVersionName([{ name: "Version 7" }])).toBe("Version 8");
  });

  it("hasUnsavedChanges compares the plan with the newest version", () => {
    add("Desk");
    expect(V.hasUnsavedChanges(P(), VS().versions)).toBe(true);
    VS().saveVersion();
    expect(V.hasUnsavedChanges(P(), VS().versions)).toBe(false);
    add("Bed");
    expect(V.hasUnsavedChanges(P(), VS().versions)).toBe(true);
  });

  it("versionsApi lists summaries newest first", () => {
    add("Desk");
    const a = VS().saveVersion("A");
    expect(V.versionsApi.list()).toEqual([{ id: a.id, name: "A", createdAt: a.createdAt, auto: false }]);
  });
});

describe("review round 3", () => {
  it("lighting mode and blinds are not design changes: no unsaved changes, no duplicate auto snapshot", () => {
    add("Desk");
    VS().saveVersion("A");
    usePlanner.setState({ room: { ...P().room, lighting: "night" } });
    expect(V.hasUnsavedChanges(P(), VS().versions)).toBe(false);
    expect(VS().autoSnapshot("chat")).toBeNull();
    add("Bed");
    expect(V.hasUnsavedChanges(P(), VS().versions)).toBe(true);
  });

  it("lamp settings are not design changes either: on/off, brightness, color don't count as unsaved or arm autosave", () => {
    const lamp = P().addItem({ ...box("Floor lamp"), light: { on: true, color: "#ffd8a8", intensity: 0.5 } });
    VS().saveVersion("A");
    V._setPeriodicState(0, false);
    const stop = V.startAutoVersions(60 * 60 * 1000);
    try {
      P().updateItem(lamp, { light: { on: true, color: "#ffd8a8", intensity: 0.3 } });
      P().updateItem(lamp, { light: { on: false, color: "#cfe0ff", intensity: 0.3 } });
      expect(V.hasUnsavedChanges(P(), VS().versions)).toBe(false);
      expect(VS().autoSnapshot("chat")).toBeNull();
      // The 10-minute watcher wasn't armed by it.
      expect(V.periodicTick(Date.now() + 3600_000)).toBeNull();
      add("Bed");
      expect(V.hasUnsavedChanges(P(), VS().versions)).toBe(true);
      expect(V.periodicTick(Date.now() + 3600_000)).not.toBeNull();
    } finally {
      stop();
    }
  });

  it("restoring a version keeps how the room is viewed now: lighting mode, blinds and lamp settings", () => {
    const lamp = P().addItem({ ...box("Floor lamp"), light: { on: true, color: "#ffd8a8", intensity: 0.5 } });
    P().updateRoom({ openings: [{ id: "w1", kind: "window", wall: "north", offset: 1.5, width: 1, height: 1.2, sill: 0.9 }] });
    // Option A saved during "movie night".
    P().updateRoom({ lighting: "night", openings: P().room.openings.map((o) => ({ ...o, covering: "closed" as const })) });
    P().updateItem(lamp, { light: { on: true, color: "#ffd8a8", intensity: 0.3 } });
    const a = VS().saveVersion("Option A");
    // Back to day, blinds open, lamp off; then a real design change.
    P().updateRoom({ lighting: "day", openings: P().room.openings.map((o) => ({ ...o, covering: "open" as const })) });
    P().updateItem(lamp, { light: { on: false, color: "#ffd8a8", intensity: 0.8 } });
    add("Bed");
    VS().restoreVersion(a.id);
    expect(names()).toEqual(["Floor lamp"]);
    expect(P().room.lighting).toBe("day");
    expect(P().room.openings[0].covering).toBe("open");
    expect(P().items[0].light).toEqual({ on: false, color: "#ffd8a8", intensity: 0.8 });
    expect(V.hasUnsavedChanges(P(), VS().versions, VS().baseline)).toBe(false);
  });

  it("right after a restore the plan counts as saved (the 'Before restoring' snapshot is newest)", () => {
    add("Desk");
    const a = VS().saveVersion("A");
    add("Bed");
    VS().restoreVersion(a.id);
    expect(VS().versions[0].name).toBe("Before restoring A");
    expect(V.hasUnsavedChanges(P(), VS().versions, VS().baseline)).toBe(false);
    add("Chair");
    expect(V.hasUnsavedChanges(P(), VS().versions, VS().baseline)).toBe(true);
  });

  it("an imported version dated in the future is clamped to now", () => {
    const future = Date.now() + 365 * 24 * 3600 * 1000;
    const v = V.normalizeVersion({ id: "v1", name: "From the future", createdAt: future, auto: false, room: defaultRoom(), items: [] })!;
    expect(v.createdAt).toBeLessThanOrEqual(Date.now() + 60_000);
    V.useVersions.getState().mergeVersions([v]);
    add("Desk");
    const next = VS().saveVersion("Later");
    expect(next.createdAt).toBeLessThan(future);
  });

  it("two tabs: a version saved in one is kept when the other saves; a deleted one stays deleted", () => {
    add("Desk");
    const mine = VS().saveVersion("Mine");
    // Another tab writes its own list (it never saw "Mine").
    const other: DesignVersion = { ...mine, id: "ver_other_tab", name: "Other tab", createdAt: mine.createdAt + 5 };
    memory.setItem(V.VERSIONS_KEY, JSON.stringify({ version: 1, versions: [other] }));
    add("Bed");
    VS().saveVersion("Mine 2");
    expect(VS().versions.map((v) => v.name).sort()).toEqual(["Mine", "Mine 2", "Other tab"]);
    const stored = JSON.parse(memory.getItem(V.VERSIONS_KEY)!).versions.map((v: DesignVersion) => v.name).sort();
    expect(stored).toEqual(["Mine", "Mine 2", "Other tab"]);
    VS().deleteVersion("ver_other_tab");
    // The other tab still has it in memory and saves again: it doesn't come back.
    const raw = JSON.parse(memory.getItem(V.VERSIONS_KEY)!);
    expect(raw.deleted).toContain("ver_other_tab");
    expect(V.mergeWithStored([other, ...VS().versions]).map((v) => v.id)).not.toContain("ver_other_tab");
    // Importing it on purpose (a file) brings it back.
    expect(VS().mergeVersions([other])).toBe(1);
    expect(VS().versions.map((v) => v.id)).toContain("ver_other_tab");
  });
});
