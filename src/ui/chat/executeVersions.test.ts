// Chat executor + design versions: saveVersion / restoreVersion and the auto snapshot before a turn with >= 3 changes.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAction } from "../../shared/types";
import { defaultRoom } from "../../lib/presets";
import type * as ExecModule from "./executeActions";
import type * as VersionsModule from "../../state/versions";
import type * as SceneModule from "./buildScene";

class MemoryStorage {
  private map = new Map<string, string>();
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
    this.map.set(key, String(value));
  }
}

let usePlanner: (typeof import("../../state/store"))["usePlanner"];
let X: typeof ExecModule;
let V: typeof VersionsModule;
let B: typeof SceneModule;
const S = () => usePlanner.getState();
const names = () => S().items.map((it) => it.name);
const run = (actions: ChatAction[], withVersions = true) =>
  X.executeActions(actions, { planner: usePlanner, ...(withVersions ? { versions: V.versionsApi } : {}) });
const add = (name: string, preset = "box"): ChatAction => ({ type: "addShape", preset, name });

beforeAll(async () => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  usePlanner = (await import("../../state/store")).usePlanner;
  X = await import("./executeActions");
  V = await import("../../state/versions");
  B = await import("./buildScene");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  usePlanner.setState({ room: defaultRoom(), items: [], selectedId: null, units: "metric", preview: null, previewTargetId: null, past: [], future: [] });
  // Versions merge with what is stored (other tabs), so start each test from empty storage too.
  localStorage.clear();
  V.useVersions.setState({ versions: [], storageNote: null, baseline: null });
});

describe("saveVersion / restoreVersion", () => {
  it("saves the design as it is at that point of the turn", () => {
    const out = run([add("Desk", "desk"), { type: "saveVersion", name: "Option A" }]);
    expect(out.results.map((r) => [r.ok, r.label])).toEqual([
      [true, expect.stringContaining("Added Desk")],
      [true, "Saved version “Option A”"],
    ]);
    const [a] = V.useVersions.getState().versions;
    expect(a).toMatchObject({ name: "Option A", auto: false });
    expect(a.items.map((it) => it.name)).toEqual(["Desk"]);
  });

  it("saveVersion without a name gets the default name", () => {
    run([add("Desk", "desk")]);
    expect(run([{ type: "saveVersion" }]).results[0].label).toBe("Saved version “Version 1”");
  });

  it("restores by id (keeping the current design first); the turn is one undo step", () => {
    run([add("Desk", "desk")]);
    const a = V.useVersions.getState().saveVersion("Option A");
    run([add("Bed", "bed")]);
    const out = run([{ type: "restoreVersion", versionId: a.id }]);
    expect(out.results[0]).toMatchObject({ ok: true, label: "Restored “Option A”" });
    expect(names()).toEqual(["Desk"]);
    expect(out.step).not.toBeNull();
    const newest = V.useVersions.getState().versions[0];
    expect(newest.name).toBe("Before restoring Option A");
    expect(newest.items.map((it) => it.name)).toEqual(["Desk", "Bed"]);
    expect(X.undoTurn(out.step!, usePlanner)).toBe(true);
    expect(names()).toEqual(["Desk", "Bed"]);
  });

  it("restores by exact name as a fallback, and fails cleanly otherwise", () => {
    run([add("Desk", "desk")]);
    V.useVersions.getState().saveVersion("Option A");
    run([add("Bed", "bed")]);
    expect(run([{ type: "restoreVersion", versionId: "option a" }]).results[0].ok).toBe(true);
    expect(names()).toEqual(["Desk"]);
    const bad = run([{ type: "restoreVersion", versionId: "ver_missing" }]).results[0];
    expect(bad).toMatchObject({ ok: false, label: "Restore version", error: "couldn't find that version" });
  });

  it("fails (no crash) when the executor has no versions API", () => {
    const out = run([{ type: "saveVersion", name: "X" }], false);
    expect(out.results[0]).toMatchObject({ ok: false, label: "Save version" });
  });
});

describe("auto snapshot before a big chat turn", () => {
  it("keeps the design from before a turn with 3+ changes", () => {
    run([add("Desk", "desk")]);
    run([add("Chair"), add("Lamp"), add("Rug")]);
    const versions = V.useVersions.getState().versions;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ auto: true, reason: "chat", name: "Before chat changes" });
    expect(versions[0].items.map((it) => it.name)).toEqual(["Desk"]);
  });

  it("doesn't for smaller turns or turns that only look around", () => {
    run([add("Desk", "desk"), add("Chair")]);
    run([{ type: "camera", preset: "top" }, { type: "select", itemId: S().items[0].id }, { type: "saveVersion", name: "A" }]);
    expect(V.useVersions.getState().versions.map((v) => v.name)).toEqual(["A"]);
  });
});

describe("ChatScene.versions", () => {
  it("lists every named version, the newest autos and older autos one per hour, with clipped names and local times", () => {
    const list = Array.from({ length: 25 }, (_, i) => ({ id: `v${i}`, name: i === 0 ? "x".repeat(300) : `V${i}`, createdAt: 1000 - i, auto: i % 2 === 1 }));
    const scene = B.buildChatScene(S(), [], undefined, list);
    // 13 named + the 10 newest autos + 1 more auto for the (single) older hour.
    expect(scene.versions).toHaveLength(24);
    expect(scene.versions![0].name).toHaveLength(80);
    expect(scene.versions![1]).toMatchObject({ id: "v1", name: "V1", createdAt: 999, auto: true });
    expect(scene.versions![1].savedAt).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M$/);
    expect(scene.now).toMatch(/\d{1,2}:\d{2}\s?[AP]M$/);
    expect(B.buildChatScene(S()).versions).toBeUndefined();
  });

  it("a busy day of autosaves never pushes the named options (or this morning) out of the scene", () => {
    const H = 3_600_000;
    const start = Date.UTC(2026, 9, 3, 13, 0); // a morning in the US
    const named = [{ id: "optA", name: "Option A", createdAt: start, auto: false }];
    // An autosave every 10 minutes and a "Before chat changes" every 5 for 8 hours after it.
    const autos = Array.from({ length: 8 * 18 }, (_, i) => ({ id: `a${i}`, name: i % 3 ? "Before chat changes" : "Autosave", createdAt: start + (i + 1) * 200_000, auto: true }));
    const all = [...named, ...autos].sort((a, b) => b.createdAt - a.createdAt);
    const scene = B.buildChatScene(S(), [], undefined, all, start + 8 * H);
    const sent = scene.versions!;
    expect(sent.length).toBeLessThanOrEqual(B.SCENE_VERSIONS);
    expect(sent.some((v) => v.id === "optA")).toBe(true);
    // Older autos thinned to about one per hour, so the morning is still covered.
    const hours = new Set(sent.filter((v) => v.auto).map((v) => Math.floor(v.createdAt / H)));
    expect(hours.size).toBeGreaterThanOrEqual(8);
  });
});
