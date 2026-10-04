import { describe, expect, it } from "vitest";
import {
  DEV_BUILD_ID,
  IDLE_BEFORE_RELOAD_MS,
  decideUpdate,
  isConnectionLossStatus,
  isNewBuild,
  parseVersion,
  reloadBlockers,
  type ActivitySnapshot,
} from "./updateDecision";

const idle: ActivitySnapshot = {
  chatPending: false,
  searchRunning: false,
  buildRunning: false,
  photosWaiting: false,
  previewing: false,
  dragging: false,
  chatDraft: "",
  focus: "none",
  confirmOpen: false,
};

describe("parseVersion", () => {
  it("reads the buildId of a version.json body", () => {
    expect(parseVersion({ buildId: "20261003-120000-abc123", builtAt: "2026-10-03T12:00:00.000Z" })).toBe("20261003-120000-abc123");
  });
  it("rejects anything else (404 page, HTML fallback, empty id, wrong type)", () => {
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion("<!doctype html>")).toBeNull();
    expect(parseVersion({})).toBeNull();
    expect(parseVersion({ buildId: "" })).toBeNull();
    expect(parseVersion({ buildId: 42 })).toBeNull();
    expect(parseVersion({ buildId: "x".repeat(500) })).toBeNull();
  });
});

describe("isNewBuild", () => {
  it("is true only for a different published id", () => {
    expect(isNewBuild("a", "b")).toBe(true);
    expect(isNewBuild("a", "a")).toBe(false);
    expect(isNewBuild("a", null)).toBe(false);
  });
  it("never updates a dev page, whatever the server says", () => {
    expect(isNewBuild(DEV_BUILD_ID, "b")).toBe(false);
    expect(isNewBuild("", "b")).toBe(false);
  });
});

describe("reloadBlockers", () => {
  it("is empty when idle, including an EMPTY focused chat composer (it autofocuses)", () => {
    expect(reloadBlockers(idle)).toEqual([]);
    expect(reloadBlockers({ ...idle, focus: "chat" })).toEqual([]);
    expect(reloadBlockers({ ...idle, chatDraft: "   " })).toEqual([]);
  });
  it.each([
    [{ chatPending: true }, "request"],
    [{ searchRunning: true }, "request"],
    [{ buildRunning: true }, "request"],
    [{ photosWaiting: true }, "photos"],
    [{ dragging: true }, "drag"],
    [{ chatDraft: "put a lamp", focus: "chat" as const }, "typing"],
    [{ pointerDown: true }, "drag"],
    [{ focus: "other" as const }, "editing"],
    [{ confirmOpen: true }, "confirm"],
    [{ previewing: true }, "preview"],
  ])("%o blocks with %s", (patch, blocker) => {
    expect(reloadBlockers({ ...idle, ...patch })).toEqual([blocker]);
  });
  it("a saved draft only blocks while it is being written (composer focused, a key pressed in the last 30 s)", () => {
    expect(reloadBlockers({ ...idle, chatDraft: "put a lamp", focus: "chat", msSinceKey: 5_000 })).toEqual(["typing"]);
    expect(reloadBlockers({ ...idle, chatDraft: "put a lamp", focus: "chat", msSinceKey: 60_000 })).toEqual([]);
    expect(reloadBlockers({ ...idle, chatDraft: "put a lamp", focus: "none", msSinceKey: 1_000 })).toEqual([]);
  });
  it("puts a running request first", () => {
    expect(reloadBlockers({ ...idle, chatDraft: "hi", chatPending: true, focus: "chat" })[0]).toBe("request");
  });
});

describe("decideUpdate", () => {
  const base = { updateReady: true, snapshot: idle, hidden: false, msSinceInput: 60_000 };
  it("does nothing without an update", () => {
    expect(decideUpdate({ ...base, updateReady: false })).toEqual({ action: "none" });
  });
  it("reloads when idle", () => {
    expect(decideUpdate(base)).toEqual({ action: "reload" });
  });
  it("waits with the bar while something would be lost", () => {
    expect(decideUpdate({ ...base, snapshot: { ...idle, chatPending: true } })).toEqual({ action: "wait", blockers: ["request"], showBar: true });
    expect(decideUpdate({ ...base, snapshot: { ...idle, chatDraft: "add a rug", focus: "chat", msSinceKey: 1000 }, hidden: true })).toEqual({
      action: "wait",
      blockers: ["typing"],
      showBar: true,
    });
  });
  it("waits briefly without a bar right after a click or key press, unless the tab is hidden", () => {
    expect(decideUpdate({ ...base, msSinceInput: 500 })).toEqual({ action: "wait", blockers: [], showBar: false });
    expect(decideUpdate({ ...base, msSinceInput: IDLE_BEFORE_RELOAD_MS + 1 })).toEqual({ action: "reload" });
    expect(decideUpdate({ ...base, msSinceInput: 500, hidden: true })).toEqual({ action: "reload" });
  });
});

describe("isConnectionLossStatus", () => {
  it("treats a proxy 5xx (no API JSON error body) as a lost connection", () => {
    expect(isConnectionLossStatus(502, false)).toBe(true);
    expect(isConnectionLossStatus(500, false)).toBe(true);
    expect(isConnectionLossStatus(504, false)).toBe(true);
  });
  it("leaves the API's own errors alone (its 502s mean Claude failed)", () => {
    expect(isConnectionLossStatus(502, true)).toBe(false);
    expect(isConnectionLossStatus(500, true)).toBe(false);
    expect(isConnectionLossStatus(400, false)).toBe(false);
    expect(isConnectionLossStatus(404, false)).toBe(false);
  });
});
