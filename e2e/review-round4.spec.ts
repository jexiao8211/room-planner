import { test, expect, type Page } from "@playwright/test";
import { openApp, readStored, settleCamera, shot, stableItemScreenPosition } from "./helpers";

// Review round 4: dragging with the inspector closed, "add it" after a preview, taking things down from a stack.

async function worldToScreen(page: Page, x: number, y: number, z: number) {
  const p = await page.evaluate(
    ([px, py, pz]) =>
      (window as unknown as { __plannerDebug: { worldToScreen: (a: number, b: number, c: number) => { x: number; y: number } | null } }).__plannerDebug.worldToScreen(
        px,
        py,
        pz,
      ),
    [x, y, z] as const,
  );
  expect(p).not.toBeNull();
  return p!;
}

async function say(page: Page, text: string) {
  const replies = page.locator('[data-testid="chat-message"][data-role="assistant"]');
  const before = await replies.count();
  const input = page.getByTestId("chat-input");
  await input.fill(text);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect.poll(() => replies.count()).toBeGreaterThan(before);
  await expect(page.getByTestId("chat-typing")).toBeHidden();
  return replies.nth(before);
}

test("dragging an item with the inspector closed keeps the whole view visible until the drop", async ({ page }) => {
  await openApp(page);
  await say(page, "add a nightstand in the ne corner");
  await say(page, "add a table lamp in the se corner");
  let plan = await readStored(page);
  const stand = plan.items.find((it) => it.name === "Nightstand")!;
  const lamp = plan.items.find((it) => it.name === "Table lamp")!;
  await page.getByTestId("inspector-close").click();
  await expect(page.getByTestId("inspector")).toBeHidden();
  await settleCamera(page);

  const start = await stableItemScreenPosition(page, lamp.id);
  const target = await worldToScreen(page, stand.position.x, stand.dims.h + lamp.dims.h / 2, stand.position.z);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const steps = 16;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(start.x + ((target.x - start.x) * i) / steps, start.y + ((target.y - start.y) * i) / steps);
    // Mid-drag: no inspector covering the right of the view, and the drop target stays where it was on screen.
    if (i === steps / 2) {
      await page.waitForTimeout(800);
      await expect(page.getByTestId("inspector")).toBeHidden();
    }
  }
  const standNow = await worldToScreen(page, stand.position.x, stand.dims.h, stand.position.z);
  const viewport = page.viewportSize()!;
  expect(standNow.x).toBeLessThan(viewport.width);
  await page.mouse.up();

  // Dropped on the nightstand; the item is selected (the inspector opens) on release.
  await expect(page.getByTestId("inspector")).toBeVisible();
  await expect(page.getByTestId("inspector-name")).toHaveValue("Table lamp");
  plan = await readStored(page);
  expect(plan.items.find((it) => it.id === lamp.id)!.supportId).toBe(stand.id);

  // With an item selected (inspector already open), a press still selects right away.
  await page.getByTestId("inspector-close").click();
  await settleCamera(page);
  const at = await stableItemScreenPosition(page, stand.id);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId("inspector")).toBeVisible();
});

test('"add it" after previewing a chat result adds that product; "put the lamp on the floor" takes it down', async ({ page }) => {
  await openApp(page);
  await say(page, "add a desk against the north wall");
  await say(page, "find a walnut nightstand");
  const results = page.getByTestId("chat-results");
  await expect(results).toBeVisible({ timeout: 20_000 });
  const first = results.getByTestId("chat-results-card").first();
  const name = (await first.locator(".chat-result-name").textContent())!.trim();
  await first.getByTestId("chat-result-preview").click();
  await expect(page.getByTestId("preview-chip")).toBeVisible();

  const reply = await say(page, "add it next to the desk");
  await expect(reply.getByTestId("chat-action-chip").first()).toHaveAttribute("data-ok", "true");
  await expect(reply.getByTestId("chat-action-chip").first()).toContainText(name);
  let plan = await readStored(page);
  expect(plan.items.some((it) => it.name === "It")).toBe(false);
  const product = plan.items.find((it) => it.product?.name === name);
  expect(product, "the previewed product was added").toBeTruthy();
  // The ghost is gone: it is in the room now.
  await expect(page.getByTestId("preview-chip")).toBeHidden();
  await settleCamera(page);
  await shot(page, "chat-preview-add-it.png");

  // Stack a lamp on a box on the desk, then take it down: it lands on the floor, not on the desk.
  await say(page, "add a box on the desk");
  await say(page, "add a table lamp on the box");
  const down = await say(page, "put the lamp on the floor");
  await expect(down.getByTestId("chat-action-chip").first()).toHaveAttribute("data-ok", "true");
  plan = await readStored(page);
  const lamp = plan.items.find((it) => it.name === "Table lamp")!;
  expect(lamp.supportId).toBeUndefined();
  expect(lamp.position.y).toBe(0);
});
