import { test, expect } from "@playwright/test";
import { buildRoomFromPhoto, openApp, readStored, shot } from "./helpers";

test("build a room from a photo with a known measurement", async ({ page }) => {
  await openApp(page);

  let requestBody: { photos: { mediaType: string; dataBase64: string }[]; knownMeasurement?: { label: string; meters: number } } | null = null;
  page.on("request", (req) => {
    if (req.url().endsWith("/api/rooms/from-photos")) requestBody = req.postDataJSON();
  });

  await buildRoomFromPhoto(page);

  // The client sent a downscaled JPEG and the parsed measurement (8 ft = 2.4384 m).
  expect(requestBody).not.toBeNull();
  expect(requestBody!.photos).toHaveLength(1);
  expect(requestBody!.photos[0].mediaType).toBe("image/jpeg");
  expect(requestBody!.photos[0].dataBase64.length).toBeGreaterThan(1000);
  expect(requestBody!.knownMeasurement).toEqual({ label: "ceiling height", meters: expect.closeTo(2.4384, 4) });

  await expect(page.getByTestId("build-notes")).toContainText("demo data");

  // Existing furniture from the (mock) analysis shows up in the item list.
  await page.getByTestId("tab-add").click();
  const existing = page.getByTestId("item-group-existing").locator(".item-row");
  await expect(existing).toHaveCount(4);
  await expect(page.getByTestId("item-group-existing")).toContainText("Queen bed");
  await expect(page.getByTestId("item-group-existing")).toContainText("Desk chair");

  const plan = await readStored(page);
  expect(plan.items.filter((it) => it.origin === "existing")).toHaveLength(4);
  // Ceiling matches the known measurement (within the server's 3% tolerance).
  expect(Math.abs(plan.room.height - 2.4384) / 2.4384).toBeLessThan(0.031);

  await page.getByTestId("tab-room").click();
  await shot(page, "room-from-photo.png");
});
