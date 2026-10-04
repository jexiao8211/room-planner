import { test, expect, type Page } from "@playwright/test";
import { openApp, readStored, shot, stableItemScreenPosition } from "./helpers";

/** Client coordinates of a room-space point (see Scene.tsx DebugBridge). */
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

test("drag a box (stand-in monitor) onto a desk; the desk carries it; deleting the desk drops it", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("tab-add").click();
  await page.getByTestId("preset-desk").click();
  await page.getByTestId("preset-box").click();

  let plan = await readStored(page);
  const desk = plan.items.find((it) => it.name === "Desk")!;
  const box = plan.items.find((it) => it.name === "Box")!;
  expect(desk && box).toBeTruthy();
  expect(box.supportId).toBeUndefined();

  // Close the inspector so the canvas keeps its size, then drag the box onto the desk top in 3D.
  await page.getByTestId("inspector-close").click();
  await expect(page.getByTestId("inspector")).toBeHidden();
  const start = await stableItemScreenPosition(page, box.id);
  // Aim where the box's middle would be once it sits on the desk's center.
  const target = await worldToScreen(page, desk.position.x, desk.dims.h + box.dims.h / 2, desk.position.z);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const steps = 16;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(start.x + ((target.x - start.x) * i) / steps, start.y + ((target.y - start.y) * i) / steps);
  }
  await page.mouse.up();

  plan = await readStored(page);
  const stacked = plan.items.find((it) => it.id === box.id)!;
  expect(stacked.supportId).toBe(desk.id);
  expect(stacked.position.y).toBeCloseTo(desk.position.y + desk.dims.h, 4);
  expect(Math.abs(stacked.position.x - desk.position.x)).toBeLessThan(desk.dims.w / 2);
  expect(Math.abs(stacked.position.z - desk.position.z)).toBeLessThan(desk.dims.d / 2);

  // The inspector says where it sits, and the item list indents it under the desk.
  await expect(page.getByTestId("inspector")).toBeVisible();
  await expect(page.getByTestId("inspector-support")).toHaveText("Desk");
  await expect(page.getByTestId("put-on-floor-btn")).toBeVisible();
  await expect(page.getByTestId(`item-row-${box.id}`)).toHaveAttribute("data-depth", "1");
  await expect(page.getByTestId(`item-on-${box.id}`)).toContainText("on Desk");

  // Move the desk with the inspector's X field: the box comes along and stays on top.
  await page.getByTestId("units-toggle").click(); // metric, so X takes plain meters
  await page.getByTestId(`item-row-${desk.id}`).locator(".item-main").click();
  await expect(page.getByTestId("inspector-name")).toHaveValue("Desk");
  const x = page.getByTestId("inspector-x");
  await x.click();
  await x.fill("-1 m");
  await x.press("Enter");
  plan = await readStored(page);
  const movedDesk = plan.items.find((it) => it.id === desk.id)!;
  const carried = plan.items.find((it) => it.id === box.id)!;
  expect(movedDesk.position.x).toBeCloseTo(-1, 4);
  expect(carried.position.x).toBeCloseTo(stacked.position.x + (-1 - desk.position.x), 4);
  expect(carried.position.z).toBeCloseTo(stacked.position.z, 4);
  expect(carried.position.y).toBeCloseTo(desk.dims.h, 4);
  expect(carried.supportId).toBe(desk.id);

  // One undo puts both back.
  await page.getByTestId("undo-btn").click();
  plan = await readStored(page);
  expect(plan.items.find((it) => it.id === desk.id)!.position.x).toBeCloseTo(desk.position.x, 4);
  expect(plan.items.find((it) => it.id === box.id)!.position.x).toBeCloseTo(stacked.position.x, 4);
  expect(plan.items.find((it) => it.id === box.id)!.supportId).toBe(desk.id);

  // Deleting the desk drops the box to the floor.
  await page.getByTestId(`item-row-${desk.id}`).locator(".item-main").click();
  await expect(page.getByTestId("inspector-name")).toHaveValue("Desk");
  await page.getByTestId("delete-btn").click();
  plan = await readStored(page);
  expect(plan.items.find((it) => it.id === desk.id)).toBeUndefined();
  const dropped = plan.items.find((it) => it.id === box.id)!;
  expect(dropped.position.y).toBe(0);
  expect(dropped.supportId).toBeUndefined();
  await expect(page.getByTestId(`item-row-${box.id}`)).toHaveAttribute("data-depth", "0");

  // Undo brings the desk back with the box on it.
  await page.getByTestId("undo-btn").click();
  plan = await readStored(page);
  expect(plan.items.find((it) => it.id === box.id)!.supportId).toBe(desk.id);
  expect(plan.items.find((it) => it.id === box.id)!.position.y).toBeCloseTo(desk.dims.h, 4);
});

test("Put on… / Put on floor from the inspector", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("tab-add").click();
  await page.getByTestId("preset-desk").click();
  await page.getByTestId("preset-box").click();
  let plan = await readStored(page);
  const desk = plan.items.find((it) => it.name === "Desk")!;
  const box = plan.items.find((it) => it.name === "Box")!;

  // The box is selected: put it on the desk from the picker.
  await expect(page.getByTestId("inspector-name")).toHaveValue("Box");
  await page.getByTestId("put-on-select").selectOption(desk.id);
  await expect(page.getByTestId("inspector-support")).toHaveText("Desk");
  plan = await readStored(page);
  expect(plan.items.find((it) => it.id === box.id)!.supportId).toBe(desk.id);
  expect(plan.items.find((it) => it.id === box.id)!.position.y).toBeCloseTo(desk.dims.h, 4);

  // And back down.
  await page.getByTestId("put-on-floor-btn").click();
  await expect(page.getByTestId("put-on-select")).toBeVisible();
  plan = await readStored(page);
  expect(plan.items.find((it) => it.id === box.id)!.supportId).toBeUndefined();
  expect(plan.items.find((it) => it.id === box.id)!.position.y).toBe(0);
});

/** Send a chat message and wait for the reply. */
async function say(page: Page, text: string) {
  const replies = page.locator('[data-testid="chat-message"][data-role="assistant"]');
  const before = await replies.count();
  const input = page.getByTestId("chat-input");
  await input.fill(text);
  await input.press("Enter");
  await expect.poll(() => replies.count()).toBeGreaterThan(before);
  await expect(page.getByTestId("chat-typing")).toBeHidden();
  return replies.nth(before);
}

/** Press at `from`, move in small steps to `to`, release. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, beforeRelease?: () => Promise<void>) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 20;
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  if (beforeRelease) await beforeRelease();
  await page.mouse.up();
}

test("dragging a monitor by its screen and releasing with the pointer ON the desk top stacks it (the natural gesture)", async ({ page }) => {
  await openApp(page);
  await say(page, "add a desk against the north wall");
  await say(page, "add a monitor in the sw corner");
  // Deselect (the chat selected the monitor): the inspector closes and the canvas keeps its size while dragging.
  await page.getByTestId("inspector-close").click();
  await expect(page.getByTestId("inspector")).toBeHidden();

  let plan = await readStored(page);
  const desk = plan.items.find((it) => it.name === "Desk")!;
  let mon = plan.items.find((it) => it.name === "Monitor")!;
  expect(mon.supportId).toBeUndefined();

  // Grab the monitor's screen (well above its bottom) and release with the pointer on the CENTER of the desk top.
  await stableItemScreenPosition(page, mon.id);
  const grab = await worldToScreen(page, mon.position.x, mon.position.y + mon.dims.h * 0.7, mon.position.z);
  const top = await worldToScreen(page, desk.position.x, desk.dims.h, desk.position.z);
  await drag(page, grab, top, async () => {
    // While dragging over the desk only the monitor's label shows (the desk's hover label would cover it).
    await expect(page.getByTestId("hover-item-label")).toHaveCount(0);
    await shot(page, "stack-drag-onto-desk.png");
  });
  plan = await readStored(page);
  mon = plan.items.find((it) => it.id === mon.id)!;
  expect(mon.supportId).toBe(desk.id);
  expect(mon.position.y).toBeCloseTo(desk.dims.h, 4);
  // Fully on the desk top, not hanging off it or sunk inside it.
  expect(Math.abs(mon.position.x - desk.position.x)).toBeLessThanOrEqual(desk.dims.w / 2 - mon.dims.w / 2 + 1e-3);
  expect(Math.abs(mon.position.z - desk.position.z)).toBeLessThanOrEqual(desk.dims.d / 2 - mon.dims.d / 2 + 1e-3);

  // The chat takes it back off ("put the monitor on the floor"): it lands in front of the desk.
  const reply = await say(page, "put the monitor on the floor");
  await expect(reply.getByTestId("chat-action-chip").first()).toHaveAttribute("data-ok", "true");
  plan = await readStored(page);
  mon = plan.items.find((it) => it.id === mon.id)!;
  expect(mon.supportId).toBeUndefined();
  expect(mon.position.y).toBe(0);
  expect(mon.position.z).toBeGreaterThan(desk.position.z + desk.dims.d / 2);

  // Releasing on the desk's FRONT EDGE stacks it too.
  await page.getByTestId("inspector-close").click();
  await expect(page.getByTestId("inspector")).toBeHidden();
  await stableItemScreenPosition(page, mon.id);
  const grab2 = await worldToScreen(page, mon.position.x, mon.position.y + mon.dims.h * 0.7, mon.position.z);
  const edge = await worldToScreen(page, desk.position.x + 0.3, desk.dims.h, desk.position.z + desk.dims.d / 2 - 0.03);
  await drag(page, grab2, edge);
  plan = await readStored(page);
  mon = plan.items.find((it) => it.id === mon.id)!;
  expect(mon.supportId).toBe(desk.id);
  expect(mon.position.y).toBeCloseTo(desk.dims.h, 4);
});

test("dragging a box to the floor between the desk's legs puts it UNDER the desk; it moves with the desk", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("tab-add").click();
  await page.getByTestId("preset-desk").click();
  await page.getByTestId("preset-box").click();
  let plan = await readStored(page);
  const desk = plan.items.find((it) => it.name === "Desk")!;
  let box = plan.items.find((it) => it.name === "Box")!;

  await page.getByTestId("inspector-close").click();
  await expect(page.getByTestId("inspector")).toBeHidden();
  await stableItemScreenPosition(page, box.id);
  const grab = await worldToScreen(page, box.position.x, box.dims.h / 2, box.position.z);
  // The floor right under the middle of the desk's front edge: seen between its legs, below its top.
  const under = await worldToScreen(page, desk.position.x, 0, desk.position.z + 0.1);
  await drag(page, grab, under, async () => {
    await shot(page, "stack-drag-under-desk.png");
  });
  plan = await readStored(page);
  box = plan.items.find((it) => it.id === box.id)!;
  expect(box.supportId).toBe(desk.id);
  expect(box.supportSurfaceY).toBe(0);
  expect(box.position.y).toBe(0);
  expect(Math.abs(box.position.x - desk.position.x)).toBeLessThan(desk.dims.w / 2);
  expect(Math.abs(box.position.z - desk.position.z)).toBeLessThan(desk.dims.d / 2);
  await expect(page.getByTestId("inspector-stack-where")).toHaveText("Under");
  await expect(page.getByTestId("inspector-support")).toHaveText("Desk");

  // Moving the desk carries it along, still under it (never pulled up on top).
  await page.getByTestId("units-toggle").click();
  await page.getByTestId(`item-row-${desk.id}`).locator(".item-main").click();
  await expect(page.getByTestId("inspector-name")).toHaveValue("Desk");
  const x = page.getByTestId("inspector-x");
  await x.click();
  await x.fill("-1 m");
  await x.press("Enter");
  plan = await readStored(page);
  const carried = plan.items.find((it) => it.id === box.id)!;
  expect(carried.supportId).toBe(desk.id);
  expect(carried.supportSurfaceY).toBe(0);
  expect(carried.position.y).toBe(0);
  expect(carried.position.x).toBeCloseTo(box.position.x + (-1 - desk.position.x), 3);
  await expect(page.getByTestId(`item-on-${box.id}`)).toContainText("under Desk");
});

test("dragging a cat onto the cat tower's middle platform puts it on that level; Put on… lists the levels", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("tab-add").click();
  await page.getByTestId("preset-cattower").click();
  await page.getByTestId("preset-cat").click();
  let plan = await readStored(page);
  const tower = plan.items.find((it) => it.name === "Cat tower")!;
  let cat = plan.items.find((it) => it.name === "Cat")!;

  // The cat is selected: its Put on… picker names the tower's levels.
  await expect(page.getByTestId("inspector-name")).toHaveValue("Cat");
  const options = await page.getByTestId("put-on-select").locator("option").allTextContents();
  expect(options).toContain("Cat tower — top");
  expect(options.some((o) => o.startsWith("Cat tower — middle level"))).toBe(true);

  await page.getByTestId("inspector-close").click();
  await expect(page.getByTestId("inspector")).toBeHidden();
  await stableItemScreenPosition(page, cat.id);
  const grab = await worldToScreen(page, cat.position.x, cat.dims.h / 2, cat.position.z);
  // A point on the middle platform (0.945 m) near its front-right edge, beside the post and clear of the perch above.
  const platform = await worldToScreen(page, tower.position.x + 0.2, 0.945, tower.position.z + 0.27);
  await drag(page, grab, platform, async () => {
    await shot(page, "stack-drag-cat-tower.png");
  });
  plan = await readStored(page);
  cat = plan.items.find((it) => it.id === cat.id)!;
  expect(cat.supportId).toBe(tower.id);
  expect(cat.supportSurfaceY).toBeCloseTo(0.945, 3);
  expect(cat.position.y).toBeCloseTo(0.945, 3);
  await expect(page.getByTestId("inspector-stack-where")).toHaveText("On the middle level of");

  // Dragging it to the top perch puts it on top.
  await page.getByTestId("inspector-close").click();
  await expect(page.getByTestId("inspector")).toBeHidden();
  await stableItemScreenPosition(page, cat.id);
  const grab2 = await worldToScreen(page, cat.position.x, cat.position.y + cat.dims.h / 2, cat.position.z);
  const perch = await worldToScreen(page, tower.position.x, 1.5, tower.position.z);
  await drag(page, grab2, perch);
  plan = await readStored(page);
  cat = plan.items.find((it) => it.id === cat.id)!;
  expect(cat.supportId).toBe(tower.id);
  expect(cat.supportSurfaceY).toBeUndefined();
  expect(cat.position.y).toBeCloseTo(1.5, 3);
});

test("chat: under the desk, the cat tower's middle level, hang from the ceiling, lower by 6 inches; Inspector hang + drop", async ({ page }) => {
  await openApp(page);
  await say(page, "add a desk against the north wall");
  let reply = await say(page, "add a bin under the desk");
  await expect(reply.getByTestId("chat-action-chip").first()).toHaveAttribute("data-status", "ok");
  let plan = await readStored(page);
  const desk = plan.items.find((it) => it.name === "Desk")!;
  const bin = plan.items.find((it) => it.name === "Bin")!;
  expect(bin.supportId).toBe(desk.id);
  expect(bin.supportSurfaceY).toBe(0);

  await say(page, "add a cat tower in the sw corner");
  reply = await say(page, "add a cat on the middle level of the cat tower");
  await expect(reply.getByTestId("chat-action-chip").first()).toHaveAttribute("data-status", "ok");
  plan = await readStored(page);
  const cat = plan.items.find((it) => it.name === "Cat")!;
  expect(cat.supportId).toBe(plan.items.find((it) => it.name === "Cat tower")!.id);
  expect(cat.position.y).toBeCloseTo(0.945, 2);

  await say(page, "add a hanging lamp");
  plan = await readStored(page);
  const before = plan.items.find((it) => it.name === "Hanging lamp")!;
  reply = await say(page, "lower the hanging lamp by 6 inches");
  await expect(reply.getByTestId("chat-action-chip").first()).toContainText("Lowered Hanging lamp");
  plan = await readStored(page);
  const lamp = plan.items.find((it) => it.id === before.id)!;
  expect(lamp.mount).toBe("ceiling");
  expect(lamp.dims.h).toBeCloseTo(before.dims.h + 0.1524, 3);
  expect(lamp.position.y + lamp.dims.h).toBeCloseTo(plan.room.height, 3);

  // Inspector: the hanging lamp has a Drop field; a box gets a "Hang from ceiling" button.
  await page.getByTestId("tab-add").click();
  await page.getByTestId(`item-row-${lamp.id}`).locator(".item-main").click();
  await page.getByTestId("units-toggle").click(); // metric
  const drop = page.getByTestId("inspector-drop");
  await drop.click();
  await drop.fill("1 m");
  await drop.press("Enter");
  plan = await readStored(page);
  expect(plan.items.find((it) => it.id === lamp.id)!.position.y).toBeCloseTo(plan.room.height - 1, 3);

  await page.getByTestId("preset-box").click();
  await expect(page.getByTestId("inspector-name")).toHaveValue("Box");
  await page.getByTestId("hang-btn").click();
  await expect(page.getByTestId("inspector-mount")).toHaveValue("ceiling");
  await expect(page.getByTestId("inspector-drop")).toBeVisible();
});
