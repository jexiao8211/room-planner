import { test, expect } from "@playwright/test";
import { itemScreenPosition, openApp, readStored, settleCamera, stableItemScreenPosition } from "./helpers";

test("drag a selected item across the floor", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("tab-add").click();
  await page.getByTestId("preset-box").click();
  await expect(page.getByTestId("inspector")).toBeVisible();

  const before = (await readStored(page)).items[0];

  // Click the item in 3D: it becomes selected (label shown).
  await page.getByTestId("inspector-close").click();
  await expect(page.getByTestId("inspector")).toBeHidden();
  const start = await stableItemScreenPosition(page, before.id);
  await page.mouse.click(start.x, start.y);
  await expect(page.getByTestId("inspector")).toBeVisible();
  await expect(page.getByTestId("selected-item-label")).toContainText("Box");

  // Drag it 140px left and 60px down in screen space. The click re-frames the view for the inspector a moment after
  // the release (CameraRig REFRAME_DELAY_MS): wait that out so a slow machine doesn't press mid-animation.
  await page.waitForTimeout(800);
  await settleCamera(page);
  const p = await stableItemScreenPosition(page, before.id);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(p.x - 14 * i, p.y + 6 * i);
  await page.mouse.up();

  const after = (await readStored(page)).items.find((it) => it.id === before.id)!;
  const moved = Math.hypot(after.position.x - before.position.x, after.position.z - before.position.z);
  expect(moved).toBeGreaterThan(0.2);
  expect(after.position.y).toBe(0); // floor items stay on the floor

  // The inspector X/Z fields follow.
  const xField = page.getByTestId("inspector-x");
  await expect(xField).not.toHaveValue(`0' 0"`);

  // The camera did not orbit during the drag: the item is now under the release point.
  const end = (await itemScreenPosition(page, before.id))!;
  expect(Math.hypot(end.x - (p.x - 140), end.y - (p.y + 60))).toBeLessThan(40);

  // One undo step restores the original position.
  await page.getByTestId("undo-btn").click();
  const undone = (await readStored(page)).items.find((it) => it.id === before.id)!;
  expect(undone.position.x).toBeCloseTo(before.position.x, 4);
  expect(undone.position.z).toBeCloseTo(before.position.z, 4);
});
