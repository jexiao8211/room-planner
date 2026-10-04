// Shared by e2e/lighting.spec.ts: a furnished bedroom with three lamps and two windows, plus lighting debug helpers.
import { expect, type Page } from "@playwright/test";
import type { LightingMode, PlacedItem, Room, ShapePart } from "../src/shared/types";
import { SHAPE_PRESETS } from "../src/lib/presets";
import { STORAGE_KEY, waitForScene } from "./helpers";

export interface LightInfo {
  name: string;
  type: string;
  intensity: number;
  castShadow: boolean;
  color: string;
}
export interface LightingDebug {
  mode: LightingMode;
  animating: boolean;
  darkness: number;
  lampLights: number;
  lampShadows: number;
  sunBeams: number;
  lights: LightInfo[];
}

const preset = (key: string) => SHAPE_PRESETS.find((p) => p.key === key)!;
const part = (kind: ShapePart["kind"], c: [number, number, number], s: [number, number, number], color?: string): ShapePart => ({
  kind,
  center: { x: c[0], y: c[1], z: c[2] },
  size: { x: s[0], y: s[1], z: s[2] },
  ...(color ? { color } : {}),
});
const TABLE_LAMP: ShapePart[] = [
  part("cylinder", [0, 0.04, 0], [0.5, 0.08, 0.5], "#444444"),
  part("cylinder", [0, 0.35, 0], [0.08, 0.6, 0.08], "#444444"),
  part("cone", [0, 0.8, 0], [1, 0.4, 1]),
];
const FLOOR_LAMP: ShapePart[] = [
  part("cylinder", [0, 0.01, 0], [0.6, 0.02, 0.6], "#333333"),
  part("cylinder", [0, 0.45, 0], [0.06, 0.86, 0.06], "#333333"),
  part("cylinder", [0, 0.89, 0], [1, 0.2, 1]),
];
const MONITOR: ShapePart[] = [part("box", [0, 0.03, 0], [0.4, 0.06, 0.9]), part("box", [0, 0.25, 0], [0.06, 0.4, 0.1]), part("box", [0, 0.65, 0.1], [1, 0.7, 0.12])];
const NIGHTSTAND: ShapePart[] = [part("box", [0, 0.6, 0], [1, 0.8, 1]), part("box", [0, 0.1, 0], [0.9, 0.2, 0.9], "#6f5a40")];

function item(id: string, name: string, x: number, y: number, z: number, rotDeg: number, dims: PlacedItem["dims"], color: string, parts: ShapePart[], extra: Partial<PlacedItem> = {}): PlacedItem {
  return { id, name, position: { x, y, z }, rotationY: (rotDeg * Math.PI) / 180, dims, color, mount: "floor", parts, origin: "shape", ...extra };
}

/** A furnished 12' × 11' bedroom: bed, nightstand + table lamp, desk + monitor + chair, floor lamp, pendant, rug. */
export function bedroom(): { room: Room; items: PlacedItem[] } {
  const room: Room = {
    name: "Lighting test",
    width: 3.66,
    depth: 3.35,
    height: 2.44,
    wallColor: "#e9e4dc",
    floorColor: "#b89874",
    openings: [
      { id: "door_1", kind: "door", wall: "south", offset: 0.6, width: 0.81, height: 2.03, sill: 0 },
      { id: "win_1", kind: "window", wall: "north", offset: 1.6, width: 1.2, height: 1.2, sill: 0.9 },
      { id: "win_2", kind: "window", wall: "east", offset: 2.2, width: 0.9, height: 1.2, sill: 0.9 },
    ],
  };
  const bed = preset("bed");
  const desk = preset("desk");
  const pendant = preset("pendant");
  const items: PlacedItem[] = [
    item("rug", "Rug", 0.1, 0, 0.35, 0, { w: 1.6, h: 0.02, d: 2.2 }, "#b9a68a", [part("box", [0, 0.5, 0], [1, 1, 1])]),
    item("bed", "Bed", -0.78, 0, 0.45, 90, bed.dims, bed.color, bed.parts),
    item("nightstand", "Nightstand", -1.58, 0, -0.62, 90, { w: 0.5, h: 0.6, d: 0.4 }, "#8b6f4e", NIGHTSTAND),
    item("tablelamp", "Table lamp", -1.58, 0.6, -0.62, 90, { w: 0.3, h: 0.5, d: 0.3 }, "#f2e6c9", TABLE_LAMP, { supportId: "nightstand", light: { on: true, color: "#ffd8a8", intensity: 0.7 } }),
    item("desk", "Desk", 1.53, 0, -0.55, -90, desk.dims, desk.color, desk.parts),
    item("monitor", "Monitor", 1.65, 0.75, -0.55, -90, { w: 0.6, h: 0.4, d: 0.2 }, "#2b2b2b", MONITOR, { supportId: "desk" }),
    item("floorlamp", "Floor lamp", 1.45, 0, 1.35, 0, { w: 0.4, h: 1.6, d: 0.4 }, "#f2e6c9", FLOOR_LAMP, { light: { on: true, color: "#ffd8a8", intensity: 0.8 } }),
    item("pendant", "Hanging lamp", 0.25, 2.44 - pendant.dims.h, 0.2, 0, pendant.dims, pendant.color, pendant.parts, { mount: "ceiling", light: { on: true, color: "#ffd8a8", intensity: 0.7 } }),
  ];
  return { room, items };
}

export async function seed(page: Page) {
  await page.addInitScript(
    ([key, plan]) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ state: { ...plan, units: "imperial" }, version: 0 }));
    },
    [STORAGE_KEY, bedroom()] as const,
  );
  await page.goto("/");
  await waitForScene(page);
}

export const lighting = (page: Page) => page.evaluate(() => (window as unknown as { __plannerDebug: { getLighting: () => LightingDebug } }).__plannerDebug.getLighting());

export async function waitLighting(page: Page, mode: LightingMode) {
  await expect.poll(async () => (await lighting(page)).mode).toBe(mode);
  await page.waitForFunction(() => !(window as unknown as { __plannerDebug: { getLighting: () => LightingDebug } }).__plannerDebug.getLighting().animating);
  await page.waitForTimeout(300);
}

/** Mean luminance (0..255) of the 3D view. */
export async function brightness(page: Page): Promise<number> {
  const png = await page.getByTestId("scene-canvas").screenshot();
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const g = c.getContext("2d")!;
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 11) {
      sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      n++;
    }
    return sum / n;
  }, png.toString("base64"));
}

export async function worldToScreen(page: Page, x: number, y: number, z: number) {
  const p = await page.evaluate(
    ([px, py, pz]) => (window as unknown as { __plannerDebug: { worldToScreen: (a: number, b: number, c: number) => { x: number; y: number } | null } }).__plannerDebug.worldToScreen(px, py, pz),
    [x, y, z] as const,
  );
  expect(p).not.toBeNull();
  return p!;
}

