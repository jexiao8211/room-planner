import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { PlacedItem } from "../src/shared/types";
import { buildRoomFromPhoto, openApp, readStored, settleCamera, shot } from "./helpers";

test("search products, preview one, add it, export, reload", async ({ page }) => {
  await openApp(page);
  await buildRoomFromPhoto(page);

  // --- search ---
  await page.getByTestId("tab-find").click();
  await page.getByTestId("search-input").fill("hanging lamp japanese");
  await page.getByTestId("search-mount").selectOption("ceiling");
  await page.getByTestId("search-btn").click();
  await expect(page.getByTestId("search-progress")).toBeVisible();

  const cards = page.getByTestId("result-card");
  await expect(cards.first()).toBeVisible({ timeout: 20_000 });
  const count = await cards.count();
  expect(count).toBeGreaterThanOrEqual(4);
  expect(count).toBeLessThanOrEqual(6);

  // Every card shows its traits: dims, color swatches, style chips, retailer link.
  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    await expect(card.locator(".result-name")).not.toBeEmpty();
    await expect(card.locator(".dims-line")).toContainText(/\d/);
    await expect(card.locator(".swatches .swatch-chip").first()).toBeVisible();
    await expect(card.locator(".chips .chip").first()).toBeVisible();
    await expect(card.getByTestId("product-link")).toHaveAttribute("href", /^https?:\/\//);
    // Labeled trait rows: mount, origin.
    await expect(card.locator("dt", { hasText: "Mount" })).toBeVisible();
    await expect(card).toContainText(/ceiling/i);
  }
  await expect(cards.first()).toContainText(/japan/i);

  // --- preview ---
  const first = cards.first();
  const productName = (await first.locator(".result-name").textContent())!.trim();
  await first.getByTestId("preview-btn").click();
  await expect(page.getByTestId("preview-chip")).toContainText(productName);
  await expect(page.getByTestId("preview-label")).toBeVisible();
  await expect(first.getByTestId("preview-btn")).toHaveText("Hide preview");
  await page.getByRole("heading", { name: "Results" }).scrollIntoViewIfNeeded();
  await settleCamera(page);
  await shot(page, "search-results.png");

  // --- add to room ---
  await first.getByTestId("add-product-btn").click();
  await expect(page.getByTestId("preview-chip")).toBeHidden();
  const inspector = page.getByTestId("inspector");
  await expect(inspector).toBeVisible();
  await expect(page.getByTestId("inspector-name")).toHaveValue(productName);
  await expect(page.getByTestId("inspector-product")).toBeVisible();
  await expect(page.getByTestId("inspector-product")).toContainText("Retailer");
  await expect(page.getByTestId("inspector-mount")).toHaveValue("ceiling");

  await page.getByTestId("tab-add").click();
  await expect(page.getByTestId("item-group-product").locator(".item-row")).toHaveCount(1);
  await expect(page.getByTestId("item-group-product")).toContainText(productName);
  await settleCamera(page);
  await shot(page, "product-placed.png");

  // --- export ---
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-btn").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("room-plan.json");
  const exported = JSON.parse(await readFile((await download.path())!, "utf8")) as { room: unknown; items: PlacedItem[] };
  const product = exported.items.find((it) => it.origin === "product");
  expect(product, "export contains the added product").toBeTruthy();
  expect(product!.name).toBe(productName);
  expect(product!.product?.url).toMatch(/^https?:\/\//);
  expect(exported.items.filter((it) => it.origin === "existing")).toHaveLength(4);

  // --- top view ---
  await page.getByTestId("inspector-close").click();
  await page.getByTestId("camera-top").click();
  await settleCamera(page);
  await shot(page, "top-view.png");

  // --- eye level from the door ---
  await page.getByTestId("camera-eye").click();
  await settleCamera(page);
  await shot(page, "eye-view.png");

  // --- overview (iso, everything placed) ---
  await page.getByTestId("camera-iso").click();
  await settleCamera(page);
  await shot(page, "overview.png");

  // --- reload persists ---
  await page.reload();
  await expect(page.getByTestId("scene-canvas").locator("canvas")).toBeVisible();
  await page.getByTestId("tab-add").click();
  await expect(page.getByTestId("item-group-product")).toContainText(productName);
  await expect(page.getByTestId("item-group-existing").locator(".item-row")).toHaveCount(4);
  const plan = await readStored(page);
  expect(plan.items.find((it) => it.origin === "product")?.product?.name).toBe(productName);
});
