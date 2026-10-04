import { expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { PlacedItem, Room } from "../src/shared/types";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const SCREENSHOT_DIR = path.join(ROOT, "docs", "screenshots");
export const ROOM_JPG = path.join(here, "fixtures", "room.jpg");
export const STORAGE_KEY = "room-planner-v1";

export interface StoredPlan {
  room: Room;
  items: PlacedItem[];
  units: string;
}

interface PlannerDebug {
  isCameraAnimating: () => boolean;
  itemScreenPosition: (id: string) => { x: number; y: number } | null;
  getCameraPreset: () => string;
}

/** Open the app (each test gets a fresh browser context, so localStorage starts empty) and wait for the 3D view. */
export async function openApp(page: Page) {
  await page.goto("/");
  await waitForScene(page);
}

export async function waitForScene(page: Page) {
  await expect(page.getByTestId("scene-canvas").locator("canvas")).toBeVisible();
  await page.waitForFunction(() => Boolean((window as unknown as { __plannerDebug?: unknown }).__plannerDebug));
  await settleCamera(page);
}

/** Wait for any camera preset animation (and orbit damping) to finish. */
export async function settleCamera(page: Page) {
  await page.waitForFunction(() => {
    const d = (window as unknown as { __plannerDebug?: PlannerDebug }).__plannerDebug;
    return d != null && !d.isCameraAnimating();
  });
  await page.waitForTimeout(400);
}

/** The persisted plan (zustand persist writes `{ state, version }`). */
export async function readStored(page: Page): Promise<StoredPlan> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  expect(raw, "plan should be persisted to localStorage").not.toBeNull();
  return (JSON.parse(raw!) as { state: StoredPlan }).state;
}

export async function itemScreenPosition(page: Page, id: string) {
  return page.evaluate((itemId) => {
    const d = (window as unknown as { __plannerDebug: PlannerDebug }).__plannerDebug;
    return d.itemScreenPosition(itemId);
  }, id);
}

/**
 * Screen position of an item once the layout has settled (opening/closing the inspector resizes the
 * canvas, which moves everything on screen for a frame or two).
 */
export async function stableItemScreenPosition(page: Page, id: string) {
  // A camera re-frame (the inspector opening / closing) can stall for a frame or two under software WebGL: two equal
  // samples only count while no camera animation is running.
  const animating = () => page.evaluate(() => (window as unknown as { __plannerDebug: PlannerDebug }).__plannerDebug.isCameraAnimating());
  let prev = await itemScreenPosition(page, id);
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(150);
    const cur = await itemScreenPosition(page, id);
    if (prev && cur && Math.hypot(cur.x - prev.x, cur.y - prev.y) < 0.5 && !(await animating())) return cur;
    prev = cur;
  }
  throw new Error(`item ${id} screen position did not settle`);
}

/** Count distinct colors in a screenshot of the 3D canvas — a blank/failed WebGL canvas has ~1. */
export async function canvasColorCount(page: Page): Promise<number> {
  const png = await page.getByTestId("scene-canvas").screenshot();
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const g = c.getContext("2d")!;
    g.drawImage(bmp, 0, 0);
    const data = g.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4 * 7) seen.add((data[i] >> 3) | ((data[i + 1] >> 3) << 5) | ((data[i + 2] >> 3) << 10));
    return seen.size;
  }, png.toString("base64"));
}

export async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, name) });
}

/** Room tab → upload the fixture photo with a known measurement → Build room → wait for the result. */
export async function buildRoomFromPhoto(page: Page) {
  await page.getByTestId("tab-room").click();
  await page.getByTestId("photo-input").setInputFiles(ROOM_JPG);
  await expect(page.getByTestId("photo-thumb")).toHaveCount(1);
  await page.getByTestId("known-label").fill("ceiling height");
  await page.getByTestId("known-length").fill("8 ft");
  await expect(page.getByTestId("known-parsed")).toContainText(`8' 0"`);
  await page.getByTestId("build-room-btn").click();
  await expect(page.getByTestId("build-progress")).toBeVisible();
  await expect(page.getByTestId("build-notes")).toBeVisible({ timeout: 20_000 });
  await settleCamera(page);
}
