// Behaviors added or fixed after the first review round (each test names the finding it covers).
import { test, expect, type Page } from "@playwright/test";
import { buildRoomFromPhoto, itemScreenPosition, openApp, readStored, settleCamera, shot, stableItemScreenPosition, ROOM_JPG } from "./helpers";

async function addPreset(page: Page, key: string) {
  await page.getByTestId("tab-add").click();
  await page.getByTestId(`preset-${key}`).click();
  await expect(page.getByTestId("inspector")).toBeVisible();
  const plan = await readStored(page);
  return plan.items[plan.items.length - 1];
}

test("metric: a bare number is read in the unit the field shows", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("units-toggle").click();
  const desk = await addPreset(page, "desk");

  const width = page.getByTestId("inspector-width");
  await expect(width).toHaveValue("1.20 m");
  await width.click();
  await width.fill("1.25");
  await expect(page.getByTestId("inspector-width-parsed")).toHaveText("= 1.25 m");
  await width.press("Tab");
  await expect(width).toHaveValue("1.25 m");
  expect((await readStored(page)).items.find((it) => it.id === desk.id)!.dims.w).toBeCloseTo(1.25, 4);

  const x = page.getByTestId("inspector-x");
  await x.click();
  await x.fill("-1.2");
  await x.press("Enter");
  expect((await readStored(page)).items.find((it) => it.id === desk.id)!.position.x).toBeCloseTo(-1.2, 4);

  // Room tab: "3" in a field showing 3.66 m is 3 m (it used to be rejected as 3 cm).
  await page.getByTestId("tab-room").click();
  const roomWidth = page.getByTestId("room-width");
  await roomWidth.click();
  await roomWidth.fill("3");
  await roomWidth.press("Enter");
  await expect(roomWidth).toHaveValue("3.00 m");
  expect((await readStored(page)).room.width).toBeCloseTo(3, 4);

  // A value that parses but is under the minimum says so (not "can't parse").
  await roomWidth.click();
  await roomWidth.fill("0.5");
  await expect(roomWidth.locator("xpath=..")).toContainText("too small");
  await roomWidth.press("Enter");
  await expect(roomWidth.locator("xpath=..")).toContainText("too small (min 1.00 m) — kept 3.00 m");
  expect((await readStored(page)).room.width).toBeCloseTo(3, 4);
});

test("selecting an item doesn't move the scene, so press-and-drag right after a click grabs it", async ({ page }) => {
  await openApp(page);
  const box = await addPreset(page, "box");
  await page.getByTestId("inspector-close").click();
  await expect(page.getByTestId("inspector")).toBeHidden();

  const p = await stableItemScreenPosition(page, box.id);
  // The camera must not move from before the click until after the drag (read it up front: the click's deferred
  // re-frame for the inspector comes REFRAME_DELAY_MS after the release, so the press below has to come sooner).
  const camBefore = await page.evaluate(() => (window as unknown as { __plannerDebug: { getCamera: () => { position: number[] } } }).__plannerDebug.getCamera().position);
  await page.mouse.click(p.x, p.y);
  await expect(page.getByTestId("inspector")).toBeVisible();
  // Long enough for an immediate re-frame to show (it would start on the next frame), well inside REFRAME_DELAY_MS
  // even on a slow, loaded machine.
  await page.waitForTimeout(150);
  const after = (await itemScreenPosition(page, box.id))!;
  expect(Math.hypot(after.x - p.x, after.y - p.y)).toBeLessThan(1);

  // Same spot, straight away: the press lands on the item and drags it (no camera orbit).
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(p.x - 10 * i, p.y);
  await page.mouse.up();
  const moved = (await readStored(page)).items.find((it) => it.id === box.id)!;
  expect(Math.hypot(moved.position.x - box.position.x, moved.position.z - box.position.z)).toBeGreaterThan(0.2);
  const camAfter = await page.evaluate(() => (window as unknown as { __plannerDebug: { getCamera: () => { position: number[] } } }).__plannerDebug.getCamera().position);
  expect(camAfter).toEqual(camBefore);
});

test("a hanging lamp above eye level can be dragged in the Eye view", async ({ page }) => {
  await openApp(page);
  const lamp = await addPreset(page, "pendant");
  await page.getByTestId("camera-eye").click();
  await settleCamera(page);

  const p = await stableItemScreenPosition(page, lamp.id);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(p.x - 6 * i, p.y);
  await page.mouse.up();
  const after = (await readStored(page)).items.find((it) => it.id === lamp.id)!;
  expect(Math.hypot(after.position.x - lamp.position.x, after.position.z - lamp.position.z)).toBeGreaterThan(0.05);
  expect(after.position.y + after.dims.h).toBeCloseTo((await readStored(page)).room.height, 3); // still on the ceiling
  // Its label is on screen (clamped inside the view) rather than above the top edge.
  const label = await page.getByTestId("selected-item-label").boundingBox();
  const view = await page.getByTestId("scene-canvas").boundingBox();
  expect(label!.y).toBeGreaterThanOrEqual(view!.y);
});

test("wall art: placed beside the window, stays on its wall (R and the rotation slider don't tilt it)", async ({ page }) => {
  await openApp(page);
  const art = await addPreset(page, "frame");
  const plan = await readStored(page);
  const win = plan.room.openings.find((o) => o.kind === "window" && o.wall === "north")!;
  const winX0 = -plan.room.width / 2 + win.offset - win.width / 2;
  const winX1 = winX0 + win.width;
  const half = art.dims.w / 2;
  expect(art.position.x + half <= winX0 || art.position.x - half >= winX1).toBe(true);
  expect(art.position.z).toBeCloseTo(-plan.room.depth / 2 + art.dims.d / 2, 3);

  await page.getByTestId("scene-canvas").hover();
  await page.keyboard.press("r");
  const after = (await readStored(page)).items.find((it) => it.id === art.id)!;
  expect(after.rotationY).toBe(0);
  expect(after.position).toEqual(art.position);
  await expect(page.getByTestId("inspector-rotation")).toBeDisabled();
});

test("a known length that can't be read blocks Build until fixed or cleared", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("tab-room").click();
  await page.getByTestId("photo-input").setInputFiles(ROOM_JPG);
  await page.getByTestId("known-label").fill("ceiling height");
  await page.getByTestId("known-length").fill("9 feet tall");
  await expect(page.getByTestId("known-parsed")).toHaveText("can't parse");
  await expect(page.getByTestId("build-room-btn")).toBeDisabled();
  await expect(page.getByTestId("known-invalid-msg")).toBeVisible();
  await page.getByTestId("known-length").fill("9 ft");
  await expect(page.getByTestId("build-room-btn")).toBeEnabled();
});

test("placeholder → find real products for it → compare in place → use here", async ({ page }) => {
  await openApp(page);
  await buildRoomFromPhoto(page);

  // Block out a hanging lamp in the back-left corner.
  const lamp = await addPreset(page, "pendant");
  await page.getByTestId("corner-nw-btn").click();
  const spot = (await readStored(page)).items.find((it) => it.id === lamp.id)!.position;
  expect(spot.x).toBeLessThan(0);
  expect(spot.z).toBeLessThan(0);

  // "Find real products for this" prefills the search and targets the placeholder.
  let searchBody: { query: string; mount?: string; maxPrice?: number; target?: { name: string; placement?: string } } | null = null;
  page.on("request", (req) => {
    if (req.url().endsWith("/api/products/search")) searchBody = req.postDataJSON();
  });
  await page.getByTestId("find-for-btn").click();
  await expect(page.getByTestId("target-banner")).toContainText("Hanging lamp");
  await expect(page.getByTestId("search-input")).toHaveValue("Hanging lamp");
  await expect(page.getByTestId("search-mount")).toHaveValue("ceiling");

  // A budget written in words fills the max price field.
  await page.getByTestId("search-input").fill("japanese paper lantern under $200");
  await page.getByTestId("search-btn").click();
  const cards = page.getByTestId("result-card");
  await expect(cards.first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("search-max-price")).toHaveValue("200");
  await expect(page.getByTestId("inferred-filters")).toContainText("max price $200");
  expect(searchBody!.maxPrice).toBe(200);
  expect(searchBody!.target?.name).toBe("Hanging lamp");
  expect(searchBody!.target?.placement).toContain("north-west");
  const count = await cards.count();
  for (let i = 0; i < count; i++) {
    expect(Number((await cards.nth(i).locator(".price").textContent())!.replace(/[^0-9.]/g, ""))).toBeLessThanOrEqual(200);
  }
  await expect(cards.first().getByTestId("result-origin")).toBeVisible();
  await expect(cards.first().getByTestId("fit-notes")).toContainText("above the floor");
  await expect(cards.first().getByTestId("product-silhouette")).toBeVisible();

  // Preview: the ghost takes the placeholder's spot. Cycle to the next result in the same spot.
  await cards.first().getByTestId("preview-btn").click();
  await expect(page.getByTestId("preview-chip")).toContainText("in place of Hanging lamp");
  await expect(page.getByTestId("preview-position")).toHaveText(`1/${count}`);
  await page.getByTestId("preview-next-btn").click();
  await expect(page.getByTestId("preview-position")).toHaveText(`2/${count}`);
  const secondName = (await cards.nth(1).locator(".result-name").textContent())!.trim();
  await expect(page.getByTestId("preview-chip")).toContainText(secondName);

  // The preview chip and the room chip don't overlap.
  const room = (await page.getByTestId("room-size-chip").boundingBox())!;
  const chip = (await page.getByTestId("preview-chip").boundingBox())!;
  const overlap = room.x < chip.x + chip.width && chip.x < room.x + room.width && room.y < chip.y + chip.height && chip.y < room.y + room.height;
  expect(overlap).toBe(false);
  await settleCamera(page);
  await shot(page, "compare-in-place.png");

  // Use here: the placeholder is replaced by the product in the same spot, in one undo step.
  await page.getByTestId("preview-commit-btn").click();
  await expect(page.getByTestId("preview-chip")).toBeHidden();
  let plan = await readStored(page);
  expect(plan.items.some((it) => it.id === lamp.id)).toBe(false);
  const product = plan.items.find((it) => it.origin === "product")!;
  expect(product.name).toBe(secondName);
  expect(product.position.x).toBeCloseTo(spot.x, 2);
  expect(product.position.z).toBeCloseTo(spot.z, 2);
  await expect(page.getByTestId("inspector-name")).toHaveValue(secondName);

  await page.getByTestId("undo-btn").click();
  plan = await readStored(page);
  expect(plan.items.some((it) => it.id === lamp.id)).toBe(true);
  expect(plan.items.some((it) => it.origin === "product")).toBe(false);

  // Search results survive a reload.
  await page.reload();
  await expect(page.getByTestId("scene-canvas").locator("canvas")).toBeVisible();
  await page.getByTestId("tab-find").click();
  await expect(page.getByTestId("result-card")).toHaveCount(count);
});

test("new floor products don't land inside the bed in the photo-built room", async ({ page }) => {
  await openApp(page);
  await buildRoomFromPhoto(page);
  await page.getByTestId("tab-find").click();
  await page.getByTestId("search-input").fill("mid-century nightstand");
  await page.getByTestId("search-btn").click();
  const first = page.getByTestId("result-card").first();
  await expect(first).toBeVisible({ timeout: 20_000 });
  await first.getByTestId("add-product-btn").click();
  const plan = await readStored(page);
  const bed = plan.items.find((it) => it.name === "Queen bed")!;
  const added = plan.items.find((it) => it.origin === "product")!;
  const ox = Math.abs(added.position.x - bed.position.x) < (added.dims.w + bed.dims.w) / 2;
  const oz = Math.abs(added.position.z - bed.position.z) < (added.dims.d + bed.dims.d) / 2;
  expect(ox && oz).toBe(false);
});
