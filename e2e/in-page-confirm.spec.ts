// Regression: confirmations used window.confirm(), which embedded/automated browsers dismiss silently
// (confirm() returns false), so "Build room from photos" did nothing once items had been added.
import { expect, test } from "@playwright/test";
import { ROOM_JPG, openApp, readStored } from "./helpers";

test("build from photos with added items asks in-page, then replaces the room", async ({ page }) => {
  let nativeDialogs = 0;
  page.on("dialog", (d) => {
    nativeDialogs++;
    void d.dismiss();
  });
  await openApp(page);

  await page.getByTestId("tab-add").click();
  await page.getByTestId("preset-box").click();
  expect((await readStored(page)).items).toHaveLength(1);

  await page.getByTestId("tab-room").click();
  await page.getByTestId("photo-input").setInputFiles(ROOM_JPG);
  await page.getByTestId("build-room-btn").click();

  // Asked in-page; "Keep current" backs out without building.
  await expect(page.getByTestId("build-confirm")).toContainText("1 added item");
  await page.getByTestId("build-confirm-cancel").click();
  await expect(page.getByTestId("build-confirm")).toHaveCount(0);
  await expect(page.getByTestId("build-progress")).toHaveCount(0);

  // Confirming builds the room.
  await page.getByTestId("build-room-btn").click();
  await page.getByTestId("build-confirm-btn").click();
  await expect(page.getByTestId("build-notes")).toBeVisible({ timeout: 20_000 });
  const stored = await readStored(page);
  expect(stored.items.length).toBeGreaterThan(0);
  expect(stored.items.every((it) => it.origin === "existing")).toBe(true);
  expect(nativeDialogs).toBe(0);
});

test("reset needs a second click and uses no native dialog", async ({ page }) => {
  let nativeDialogs = 0;
  page.on("dialog", (d) => {
    nativeDialogs++;
    void d.dismiss();
  });
  await openApp(page);
  await page.getByTestId("tab-add").click();
  await page.getByTestId("preset-box").click();

  await page.getByTestId("reset-btn").click();
  await expect(page.getByTestId("reset-btn")).toContainText("Click again");
  expect((await readStored(page)).items).toHaveLength(1);

  await page.getByTestId("reset-btn").click();
  await expect(page.getByTestId("reset-btn")).toContainText("Reset");
  expect((await readStored(page)).items).toHaveLength(0);
  expect(nativeDialogs).toBe(0);
});

test("a bad import shows an in-page error", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("import-input").setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from("{nope") });
  await expect(page.getByTestId("import-error")).toContainText(`Couldn't import "bad.json"`);
});
