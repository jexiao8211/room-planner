import { test, expect } from "@playwright/test";
import { canvasColorCount, openApp, readStored } from "./helpers";

test("app loads with the demo banner and a rendering WebGL canvas", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await openApp(page);

  const banner = page.getByTestId("mode-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("data-mode", "mock");
  await expect(banner).toContainText("Demo data");

  const hasWebGL = await page.getByTestId("scene-canvas").locator("canvas").evaluate((c: HTMLCanvasElement) => {
    const gl = c.getContext("webgl2") ?? c.getContext("webgl");
    return gl != null && !gl.isContextLost();
  });
  expect(hasWebGL).toBe(true);

  // The default room is drawn: the canvas is far from a single flat color.
  expect(await canvasColorCount(page)).toBeGreaterThan(20);
  await expect(page.getByTestId("room-size-chip")).toContainText(`12' 0"`);
  expect(errors).toEqual([]);
});

test("add presets, edit width in the inspector, undo/redo, reload persists", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("tab-add").click();

  await page.getByTestId("preset-box").click();
  await expect(page.getByTestId("inspector")).toBeVisible();
  await expect(page.getByTestId("inspector")).toContainText("Box");

  await page.getByTestId("preset-pendant").click();
  await expect(page.getByTestId("inspector")).toContainText("Hanging lamp");

  const added = page.getByTestId("item-group-shape").locator(".item-row");
  await expect(added).toHaveCount(2);
  await expect(added.nth(0)).toContainText("Box");
  await expect(added.nth(1)).toContainText("Hanging lamp");

  let plan = await readStored(page);
  const box = plan.items.find((it) => it.name === "Box")!;
  const lamp = plan.items.find((it) => it.name === "Hanging lamp")!;
  expect(box.mount).toBe("floor");
  expect(lamp.mount).toBe("ceiling");
  // Hanging lamp hangs from the ceiling: its top touches the ceiling.
  expect(lamp.position.y + lamp.dims.h).toBeCloseTo(plan.room.height, 2);

  // Select the box from the list and change its width.
  await page.getByTestId(`item-row-${box.id}`).locator(".item-main").click();
  await expect(page.getByTestId("inspector-name")).toHaveValue("Box");
  const width = page.getByTestId("inspector-width");
  await width.fill(`3' 0"`);
  await width.press("Enter");
  await expect(width).toHaveValue(`3' 0"`);
  plan = await readStored(page);
  expect(plan.items.find((it) => it.id === box.id)!.dims.w).toBeCloseTo(0.9144, 3);

  // Escape cancels an edit instead of committing it.
  await width.fill(`5' 0"`);
  await width.press("Escape");
  await expect(width).toHaveValue(`3' 0"`);
  expect((await readStored(page)).items.find((it) => it.id === box.id)!.dims.w).toBeCloseTo(0.9144, 3);

  // Value survives deselect + reselect.
  await page.getByTestId("inspector-close").click();
  await expect(page.getByTestId("inspector")).toBeHidden();
  await page.getByTestId(`item-row-${box.id}`).locator(".item-main").click();
  await expect(page.getByTestId("inspector-width")).toHaveValue(`3' 0"`);

  // Undo the width change, then redo it.
  await page.getByTestId("undo-btn").click();
  await expect(page.getByTestId("inspector-width")).not.toHaveValue(`3' 0"`);
  expect((await readStored(page)).items.find((it) => it.id === box.id)!.dims.w).toBeCloseTo(0.5, 3);
  await expect(page.getByTestId("redo-btn")).toBeEnabled();
  await page.getByTestId("redo-btn").click();
  await expect(page.getByTestId("inspector-width")).toHaveValue(`3' 0"`);
  await expect(page.getByTestId("redo-btn")).toBeDisabled();

  // Undo twice more removes the lamp then the box... redo brings the lamp back.
  await page.getByTestId("undo-btn").click(); // width
  await page.getByTestId("undo-btn").click(); // lamp
  await expect(added).toHaveCount(1);
  await page.getByTestId("redo-btn").click();
  await expect(added).toHaveCount(2);
  await page.getByTestId("redo-btn").click();

  // Reload: the plan comes back from localStorage.
  await page.reload();
  await expect(page.getByTestId("scene-canvas").locator("canvas")).toBeVisible();
  await page.getByTestId("tab-add").click();
  await expect(added).toHaveCount(2);
  await page.getByTestId(`item-row-${box.id}`).locator(".item-main").click();
  await expect(page.getByTestId("inspector-width")).toHaveValue(`3' 0"`);
});
