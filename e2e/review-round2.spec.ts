// Behaviors fixed after the second review round (each test names the finding it covers).
import { test, expect, type Page } from "@playwright/test";
import type { PlacedItem } from "../src/shared/types";
import { ROOM_JPG, itemScreenPosition, openApp, readStored, settleCamera, shot, stableItemScreenPosition } from "./helpers";

async function addPreset(page: Page, key: string): Promise<PlacedItem> {
  await page.getByTestId("tab-add").click();
  await page.getByTestId(`preset-${key}`).click();
  await expect(page.getByTestId("inspector")).toBeVisible();
  const plan = await readStored(page);
  return plan.items[plan.items.length - 1];
}

async function cameraPreset(page: Page) {
  return page.evaluate(() => (window as unknown as { __plannerDebug: { getCameraPreset: () => string } }).__plannerDebug.getCameraPreset());
}

async function previewPosition(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __plannerDebug: { getPreviewPosition: () => number[] | null } }).__plannerDebug.getPreviewPosition(),
  );
}

async function search(page: Page, query: string) {
  await page.getByTestId("tab-find").click();
  await page.getByTestId("search-input").fill(query);
  await page.getByTestId("search-btn").click();
  await expect(page.getByTestId("search-progress")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId("result-card").first()).toBeVisible({ timeout: 20_000 });
}

test("Eye view: dragging a hanging lamp follows the cursor sideways and moves in small steps up/down", async ({ page }) => {
  await openApp(page);
  const lamp = await addPreset(page, "pendant");
  await page.getByTestId("camera-eye").click();
  await settleCamera(page);
  const view = (await page.getByTestId("scene-canvas").boundingBox())!;

  const p = await stableItemScreenPosition(page, lamp.id);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  // 150 px to the left: the shade stays under the cursor (it used to move ~330 px and leave the view). The point
  // that follows the cursor exactly is the one pressed on the front of the shade; the shade's center, measured
  // here, trails it by a little parallax (~20 px), plus 1-inch snapping.
  for (let i = 1; i <= 10; i++) await page.mouse.move(p.x - 15 * i, p.y);
  const left = (await itemScreenPosition(page, lamp.id))!;
  expect(Math.abs(left.x - (p.x - 150))).toBeLessThan(35);
  expect(left.x).toBeGreaterThan(view.x);
  const atLeft = (await readStored(page)).items.find((it) => it.id === lamp.id)!.position;

  // 20 px down: a small step closer to the viewer, not a jump into the far corner.
  for (let i = 1; i <= 4; i++) await page.mouse.move(p.x - 150, p.y + 5 * i);
  const down = (await readStored(page)).items.find((it) => it.id === lamp.id)!.position;
  expect(Math.hypot(down.x - atLeft.x, down.z - atLeft.z)).toBeLessThan(0.5);
  expect(Math.hypot(down.x - atLeft.x, down.z - atLeft.z)).toBeGreaterThan(0.02);

  // 32 px up from the start height: still in view (it used to fly over the camera, screen y -661).
  for (let i = 1; i <= 8; i++) await page.mouse.move(p.x - 150, p.y + 20 - 6.5 * i);
  const up = (await itemScreenPosition(page, lamp.id))!;
  expect(up.y).toBeGreaterThan(view.y);
  expect(up.y).toBeLessThan(view.y + view.height);
  const upPos = (await readStored(page)).items.find((it) => it.id === lamp.id)!.position;
  expect(Math.hypot(upPos.x - atLeft.x, upPos.z - atLeft.z)).toBeLessThan(0.5);
  await page.mouse.up();

  const after = (await readStored(page)).items.find((it) => it.id === lamp.id)!;
  expect(after.position.y + after.dims.h).toBeCloseTo((await readStored(page)).room.height, 3); // still on the ceiling
});

test.describe("at 1024 x 700", () => {
  test.use({ viewport: { width: 1024, height: 700 } });

  test("clicking an item in the 3D view re-frames the room left of the inspector once the pointer is up", async ({ page }) => {
    await openApp(page);
    const desk = await addPreset(page, "desk");
    await page.getByTestId("inspector-close").click();
    await expect(page.getByTestId("inspector")).toBeHidden();
    await settleCamera(page);

    const p = await stableItemScreenPosition(page, desk.id);
    await page.mouse.click(p.x, p.y);
    const inspector = page.getByTestId("inspector");
    await expect(inspector).toBeVisible();
    const panelLeft = (await inspector.boundingBox())!.x;
    // Right after the click nothing moves (press again to drag it)...
    await page.waitForTimeout(250);
    const now = (await itemScreenPosition(page, desk.id))!;
    expect(Math.hypot(now.x - p.x, now.y - p.y)).toBeLessThan(1);
    // ...then the preset re-frames into the part of the view the inspector leaves visible.
    await expect.poll(async () => (await itemScreenPosition(page, desk.id))!.x, { timeout: 5_000 }).toBeLessThan(p.x - 60);
    await settleCamera(page);
    expect(await cameraPreset(page)).toBe("iso");
    const framed = (await stableItemScreenPosition(page, desk.id))!;
    expect(framed.x).toBeLessThan(panelLeft - 80);
    await shot(page, "inspector-reframed-1024.png");

    // Adding wall art while the inspector stays open: it lands where it can be seen, not behind the panel.
    const art = await addPreset(page, "frame");
    await settleCamera(page);
    const artPos = (await stableItemScreenPosition(page, art.id))!;
    expect(artPos.x).toBeLessThan((await inspector.boundingBox())!.x - 20);
  });
});

test("'a hanging lamp in the corner' previews and adds the lamp in a corner", async ({ page }) => {
  await openApp(page);
  await search(page, "I want to add a hanging lamp in the corner, Japanese, under $200");
  await expect(page.getByTestId("inferred-filters")).toContainText("placed in a free corner");
  const room = (await readStored(page)).room;

  await page.getByTestId("result-card").first().getByTestId("preview-btn").click();
  await expect(page.getByTestId("preview-chip")).toBeVisible();
  await expect.poll(() => previewPosition(page)).not.toBeNull();
  const [gx, , gz] = (await previewPosition(page))!;
  // Back-left corner: within 0.9 m of both the west and the north wall.
  expect(gx).toBeLessThan(-room.width / 2 + 0.9);
  expect(gz).toBeLessThan(-room.depth / 2 + 0.9);
  await settleCamera(page);
  await shot(page, "corner-preview.png");

  await page.getByTestId("preview-commit-btn").click();
  const lamp = (await readStored(page)).items.find((it) => it.origin === "product")!;
  expect(lamp.mount).toBe("ceiling");
  expect(lamp.position.x).toBeCloseTo(gx, 3);
  expect(lamp.position.z).toBeCloseTo(gz, 3);
});

test("find alternatives for a placed product keeps the search's wording and style and leaves the product out", async ({ page }) => {
  await openApp(page);
  const query = "hanging lamp for the corner, Japanese, under $200";
  await search(page, query);
  const first = page.getByTestId("result-card").first();
  const productName = (await first.locator(".result-name").textContent())!.trim();
  await first.getByTestId("add-product-btn").click();
  await expect(page.getByTestId("inspector-name")).toHaveValue(productName);
  const product = (await readStored(page)).items.find((it) => it.origin === "product")!;

  let body: { query: string; excludeUrls?: string[]; target?: { name: string; isProduct?: boolean } } | null = null;
  page.on("request", (req) => {
    if (req.url().endsWith("/api/products/search")) body = req.postDataJSON();
  });
  await page.getByTestId("find-for-btn").click();
  await expect(page.getByTestId("search-input")).toHaveValue(query);
  await expect(page.getByTestId("search-style")).not.toHaveValue("");
  await page.getByTestId("search-btn").click();
  await expect(page.getByTestId("search-progress")).toBeVisible();
  await expect(page.getByTestId("search-progress")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId("result-card").first()).toBeVisible();
  expect(body!.query).toBe(query);
  expect(body!.excludeUrls).toEqual([product.product!.url]);
  expect(body!.target?.isProduct).toBe(true);
  const names = await page.getByTestId("result-card").locator(".result-name").allTextContents();
  expect(names.length).toBeGreaterThanOrEqual(3);
  expect(names.map((n) => n.trim())).not.toContain(productName);
});

test("a known length with an empty 'What' counts as the ceiling height", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("tab-room").click();
  await page.getByTestId("photo-input").setInputFiles(ROOM_JPG);
  await page.getByTestId("known-length").fill("9 ft");
  await expect(page.getByTestId("known-label-assumed")).toHaveText("(assumed ceiling height)");
  let body: { knownMeasurement?: { label: string; meters: number } } | null = null;
  page.on("request", (req) => {
    if (req.url().endsWith("/api/rooms/from-photos")) body = req.postDataJSON();
  });
  await page.getByTestId("build-room-btn").click();
  await expect(page.getByTestId("build-notes")).toBeVisible({ timeout: 20_000 });
  expect(body!.knownMeasurement?.label).toBe("ceiling height");
  expect((await readStored(page)).room.height).toBeCloseTo(9 * 0.3048, 2);
});

test("imported wall items stay on the east/west wall they stand against even with rotation 0", async ({ page }) => {
  await openApp(page);
  const wallItem = (id: string, name: string, x: number, z: number) => ({
    id,
    name,
    position: { x, y: 1.2, z },
    rotationY: 0,
    dims: { w: 0.8, h: 0.6, d: 0.04 },
    color: "#445566",
    mount: "wall",
    parts: [{ kind: "box", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 } }],
    origin: "existing",
  });
  const plan = {
    version: 1,
    room: { name: "Den", width: 3.6, depth: 3.4, height: 2.44, wallColor: "#e9e4dc", floorColor: "#b89874", openings: [] },
    items: [wallItem("paint", "Painting on east wall", 1.78, 0.3), wallItem("tv", "TV on west wall", -1.78, -0.5)],
  };
  await page.getByTestId("import-input").setInputFiles({ name: "room-plan.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(plan)) });
  await expect.poll(async () => (await readStored(page)).room.name).toBe("Den");
  const items = (await readStored(page)).items;
  const paint = items.find((it) => it.id === "paint")!;
  const tv = items.find((it) => it.id === "tv")!;
  expect(paint.position.x).toBeCloseTo(1.8 - 0.02, 3);
  expect(paint.position.z).toBeCloseTo(0.3, 3);
  expect(paint.rotationY).toBeCloseTo(-Math.PI / 2, 4);
  expect(tv.position.x).toBeCloseTo(-1.8 + 0.02, 3);
  expect(tv.position.z).toBeCloseTo(-0.5, 3);
  expect(tv.rotationY).toBeCloseTo(Math.PI / 2, 4);
});
