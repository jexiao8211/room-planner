import { describe, expect, it } from "vitest";
import type { Opening, PlacedItem } from "../shared/types";
import { SHAPE_PRESETS } from "./presets";
import {
  DEFAULT_LIGHT,
  MODE_PARAMS,
  autoLight,
  colorWarmth,
  isLampLike,
  lampCandela,
  lightAnchorLocal,
  lightAnchorWorld,
  lightingMode,
  normalizeLight,
  shadePartIndex,
  shadowCasters,
  warmthColor,
  windowCovering,
} from "./lighting";
import { sunBeamFor, sunShaft } from "../scene/sunMath";

const pendant = SHAPE_PRESETS.find((p) => p.key === "pendant")!;
const part = (y: number, sy: number, sx = 1): PlacedItem["parts"][number] => ({ kind: "cylinder", center: { x: 0, y, z: 0 }, size: { x: sx, y: sy, z: sx } });
const TABLE_LAMP = [part(0.04, 0.08, 0.5), part(0.35, 0.6, 0.08), { ...part(0.8, 0.4), kind: "cone" as const }];

describe("isLampLike / autoLight", () => {
  it.each(["Hanging lamp", "Floor lamp", "IKEA Akari paper lantern", "Brass wall sconce", "Crystal chandelier", "Pendant", "Ceiling light", "LED strip lights", "Desk light", "Lamp"])(
    "%s gives light",
    (name) => {
      expect(isLampLike(name)).toBe(true);
      expect(autoLight({ name })).toEqual(DEFAULT_LIGHT);
    },
  );

  it.each(["Desk", "Light oak desk", "Light gray sofa", "Lightweight chair", "Bed", "Light-blue rug", "Monitor"])("%s doesn't", (name) => {
    expect(isLampLike(name)).toBe(false);
    expect(autoLight({ name })).toBeUndefined();
  });

  it("the pendant preset always gets a light; an explicit light wins", () => {
    expect(autoLight({ name: "Thing", presetKey: "pendant" })).toEqual(DEFAULT_LIGHT);
    const own = { on: false, color: "#c8dcff", intensity: 0.2 };
    expect(autoLight({ name: "Lamp", light: own })).toBe(own);
  });
});

describe("normalizeLight / modes / coverings", () => {
  it("cleans untrusted light settings", () => {
    expect(normalizeLight({ on: false, color: "#FFAA00", intensity: 3 })).toEqual({ on: false, color: "#ffaa00", intensity: 1 });
    expect(normalizeLight({ color: "red", intensity: "x" })).toEqual({ on: true, color: DEFAULT_LIGHT.color, intensity: DEFAULT_LIGHT.intensity });
    expect(normalizeLight(null)).toBeUndefined();
    expect(normalizeLight([1])).toBeUndefined();
  });

  it("defaults to day and open", () => {
    expect(lightingMode(undefined)).toBe("day");
    expect(lightingMode("night")).toBe("night");
    expect(lightingMode("noon")).toBe("day");
    const w: Pick<Opening, "kind" | "covering"> = { kind: "window" };
    expect(windowCovering(w)).toBe("open");
    expect(windowCovering({ kind: "window", covering: "closed" })).toBe("closed");
    expect(windowCovering({ kind: "door", covering: "closed" })).toBe("open");
  });

  it("each mode is clearly darker than the one before and lamps matter more as it gets dark", () => {
    const total = (m: keyof typeof MODE_PARAMS) => MODE_PARAMS[m].ambient.intensity + MODE_PARAMS[m].hemi.intensity + MODE_PARAMS[m].key.intensity;
    expect(total("day")).toBeGreaterThan(total("evening") * 2);
    expect(total("evening")).toBeGreaterThan(total("night") * 1.3);
    expect(MODE_PARAMS.night.ambient.intensity).toBeGreaterThan(0.15); // the room never goes pitch black
    expect(MODE_PARAMS.night.sun.intensity).toBe(0);
    expect(MODE_PARAMS.evening.sun.elevation).toBeLessThan(MODE_PARAMS.day.sun.elevation);
    expect(MODE_PARAMS.day.lamp).toBeLessThan(MODE_PARAMS.evening.lamp);
    expect(lampCandela(1)).toBeGreaterThan(lampCandela(0.5));
    expect(lampCandela(0)).toBeGreaterThan(0);
  });
});

describe("warm <-> cool", () => {
  it("round-trips a warmth through its color, and the default warm white sits at 0.7", () => {
    for (const w of [0, 0.2, 0.4, 0.55, 0.7, 0.85, 1]) expect(colorWarmth(warmthColor(w))).toBeCloseTo(w, 1);
    expect(warmthColor(0.7)).toBe(DEFAULT_LIGHT.color);
    expect(colorWarmth("#ffd8a8")).toBeCloseTo(0.7, 2);
    expect(warmthColor(-1)).toBe(warmthColor(0));
    expect(warmthColor(2)).toBe(warmthColor(1));
  });

  it("warmer colors have less blue", () => {
    const blue = (hex: string) => parseInt(hex.slice(5, 7), 16);
    expect(blue(warmthColor(0.9))).toBeLessThan(blue(warmthColor(0.6)));
    expect(blue(warmthColor(0.6))).toBeLessThan(blue(warmthColor(0.1)));
  });
});

describe("where the bulb is", () => {
  it("glows from the pendant's shade (the sphere), not its cord", () => {
    expect(shadePartIndex(pendant.parts, "ceiling")).toBe(1);
    const anchor = lightAnchorLocal({ parts: pendant.parts, dims: pendant.dims, mount: "ceiling" });
    // Inside the shade: between its bottom and top.
    const shade = pendant.parts[1];
    expect(anchor.y).toBeGreaterThan((shade.center.y - shade.size.y / 2) * pendant.dims.h);
    expect(anchor.y).toBeLessThan((shade.center.y + shade.size.y / 2) * pendant.dims.h);
  });

  it("glows from a standing lamp's top part (the shade on the stem)", () => {
    expect(shadePartIndex(TABLE_LAMP, "floor")).toBe(2);
    expect(shadePartIndex([part(0.5, 1)], "floor")).toBe(0);
    const a = lightAnchorLocal({ parts: TABLE_LAMP, dims: { w: 0.3, h: 0.5, d: 0.3 }, mount: "floor" });
    expect(a.y).toBeGreaterThan(0.3);
    expect(a.y).toBeLessThan(0.5);
  });

  it("turns the anchor with the item", () => {
    const parts = [{ kind: "sphere" as const, center: { x: 0.5, y: 0.5, z: 0 }, size: { x: 0.5, y: 0.5, z: 0.5 } }];
    const base = { parts, dims: { w: 1, h: 1, d: 1 }, mount: "wall" as const, position: { x: 1, y: 0, z: 2 } };
    const p0 = lightAnchorWorld({ ...base, rotationY: 0 });
    expect(p0.x).toBeCloseTo(1.5);
    expect(p0.z).toBeCloseTo(2);
    // +90° about y: local +x points to world -z.
    const p90 = lightAnchorWorld({ ...base, rotationY: Math.PI / 2 });
    expect(p90.x).toBeCloseTo(1);
    expect(p90.z).toBeCloseTo(1.5);
  });
});

describe("shadow budget", () => {
  it("gives shadows to at most N lights: lights that are on first, then the brightest, then the most central", () => {
    const lights = [
      { id: "a", on: false, intensity: 1, x: 0, z: 0 },
      { id: "b", on: true, intensity: 0.4, x: 2, z: 0 },
      { id: "c", on: true, intensity: 0.9, x: 3, z: 3 },
      { id: "d", on: true, intensity: 0.4, x: 0.5, z: 0 },
    ];
    expect([...shadowCasters(lights, 2)].sort()).toEqual(["c", "d"]);
    expect(shadowCasters(lights, 0).size).toBe(0);
    expect(shadowCasters(lights, 10).size).toBe(4);
    // ~8 lamps: still only the budget.
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `l${i}`, on: true, intensity: 0.7, x: i, z: 0 }));
    expect(shadowCasters(many, 2)).toEqual(new Set(["l0", "l1"]));
  });
});

describe("window sun beams", () => {
  const room = { width: 4, depth: 3, height: 2.5 };
  const north: Opening = { id: "w", kind: "window", wall: "north", offset: 2, width: 1.2, height: 1.2, sill: 0.9 };

  it("puts the sun outside the window and aims it into the room and down", () => {
    const b = sunBeamFor(north, room, 40);
    expect(b.position[2]).toBeLessThan(-room.depth / 2); // outside the north wall
    expect(b.position[1]).toBeGreaterThan(north.sill + north.height); // above the window
    expect(b.dir.z).toBeGreaterThan(0); // into the room (south)
    expect(b.dir.y).toBeLessThan(0); // downward
    expect(Math.hypot(b.dir.x, b.dir.y, b.dir.z)).toBeCloseTo(1);
    expect(b.angle).toBeGreaterThan(0);
    expect(b.angle).toBeLessThan(Math.PI / 3);
  });

  it("a lower (evening) sun reaches further into the room", () => {
    const reach = (elev: number) => Math.max(...sunShaft(north, room, sunBeamFor(north, room, elev).dir).end.map((p) => p[2]));
    expect(reach(16)).toBeGreaterThan(reach(42));
  });

  it("the shaft starts at the window and ends inside the room", () => {
    const east: Opening = { id: "e", kind: "window", wall: "east", offset: 1, width: 0.9, height: 1.2, sill: 0.9 };
    for (const o of [north, east]) {
      for (const elev of [16, 42]) {
        const { start, end } = sunShaft(o, room, sunBeamFor(o, room, elev).dir);
        expect(start).toHaveLength(4);
        for (const p of end) {
          expect(Math.abs(p[0])).toBeLessThanOrEqual(room.width / 2 + 1e-6);
          expect(Math.abs(p[2])).toBeLessThanOrEqual(room.depth / 2 + 1e-6);
          expect(p[1]).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});
