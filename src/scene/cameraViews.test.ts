import { describe, expect, it } from "vitest";
import { defaultRoom } from "../lib/presets";
import { presetView, roomSizeChangedSignificantly } from "./cameraViews";

const room = defaultRoom();

describe("presetView", () => {
  it("iso looks at the room from above the south-east corner", () => {
    const v = presetView("iso", room, 1.6, 45);
    expect(v.position.x).toBeGreaterThan(room.width / 2);
    expect(v.position.z).toBeGreaterThan(room.depth / 2);
    expect(v.position.y).toBeGreaterThan(room.height);
    expect(v.target).toEqual({ x: 0, y: room.height / 3, z: 0 });
  });

  it("top is straight above the center and clears the walls", () => {
    const v = presetView("top", room, 1.6, 45);
    expect(Math.abs(v.position.x)).toBeLessThan(0.01);
    expect(Math.abs(v.position.z)).toBeLessThan(0.01);
    expect(v.position.y).toBeGreaterThan(room.height * 2);
  });

  it("eye stands just inside the door at eye height", () => {
    const v = presetView("eye", room, 1.6, 45);
    const door = room.openings.find((o) => o.kind === "door")!;
    expect(v.position.y).toBeCloseTo(1.6);
    expect(v.position.x).toBeCloseTo(-room.width / 2 + door.offset);
    expect(v.position.z).toBeLessThan(room.depth / 2);
    expect(v.position.z).toBeGreaterThan(0);
  });

  it("eye falls back to the south wall when there is no door", () => {
    const v = presetView("eye", { ...room, openings: [] }, 1.6, 45);
    expect(v.position.x).toBe(0);
    expect(v.target.z).toBeLessThan(v.position.z);
  });
});

describe("roomSizeChangedSignificantly", () => {
  it("ignores small edits and catches big ones", () => {
    expect(roomSizeChangedSignificantly({ width: 3.7, depth: 3.35, height: 2.44 }, room)).toBe(false);
    expect(roomSizeChangedSignificantly({ width: 6, depth: 3.35, height: 2.44 }, room)).toBe(true);
  });
});
