import { test, expect, type Page } from "@playwright/test";
import type { PlacedItem, Room } from "../src/shared/types";
import { SHAPE_PRESETS, defaultRoom } from "../src/lib/presets";
import { STORAGE_KEY, readStored, settleCamera, shot, stableItemScreenPosition, waitForScene } from "./helpers";
import { bedroom, worldToScreen } from "./lightingFixture";

// Review round 3 fixes: stacking under / on levels survives hide + show, the Eye-view drag onto a cat tower level, the
// drag label saying where an item lands, chat placement beside a bed, the "Put on…" list, the Drop field and the
// hanging-lamp hint.

test.describe.configure({ timeout: 120_000 });

const preset = (key: string) => SHAPE_PRESETS.find((p) => p.key === key)!;
function fromPreset(key: string, id: string, over: Partial<PlacedItem> = {}): PlacedItem {
  const p = preset(key);
  return { id, name: p.label, position: { x: 0, y: 0, z: 0 }, rotationY: 0, dims: { ...p.dims }, color: p.color, mount: p.mount, parts: p.parts, origin: "shape", ...over };
}

async function seed(page: Page, plan: { room: Room; items: PlacedItem[] }) {
  await page.addInitScript(
    ([key, p]) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ state: { ...p, units: "imperial" }, version: 0 }));
    },
    [STORAGE_KEY, plan] as const,
  );
  await page.goto("/");
  await waitForScene(page);
}

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

const itemById = async (page: Page, id: string) => (await readStored(page)).items.find((it) => it.id === id)!;

test("a bin under the desk stays under it when the desk is hidden and shown again (the monitor goes back on top)", async ({ page }) => {
  const plan = bedroom();
  plan.items.push(fromPreset("cylinder", "bin", { name: "Bin", dims: { w: 0.25, h: 0.25, d: 0.25 }, position: { x: 1.53, y: 0, z: -0.55 }, supportId: "desk", supportSurfaceY: 0 }));
  await seed(page, plan);
  await say(page, "hide the desk");
  let bin = await itemById(page, "bin");
  expect(bin.supportId).toBeUndefined();
  expect(bin.position.y).toBe(0);
  await say(page, "show the desk");
  bin = await itemById(page, "bin");
  expect(bin.supportId).toBe("desk");
  expect(bin.supportSurfaceY).toBe(0);
  expect(bin.position.y).toBe(0);
  const monitor = await itemById(page, "monitor");
  expect(monitor.supportId).toBe("desk");
  expect(monitor.position.y).toBeCloseTo(0.75, 3);

  // The chat's own "put the bin under the desk" path, hidden and shown again.
  await say(page, "put the bin on the floor");
  await say(page, "put the bin under the desk");
  await say(page, "hide the desk");
  await say(page, "show the desk");
  bin = await itemById(page, "bin");
  expect(bin).toMatchObject({ supportId: "desk", supportSurfaceY: 0, position: { y: 0 } });
});

test("Eye view: dragging the cat from the top perch down to the middle platform puts it there; the label says where it lands", async ({ page }) => {
  const room = defaultRoom();
  const tower = fromPreset("cattower", "tower", { position: { x: -0.6, y: 0, z: -0.4 } });
  const cat = fromPreset("cat", "cat", { position: { x: -0.6, y: 1.5, z: -0.4 }, supportId: "tower" });
  await seed(page, { room, items: [tower, cat] });
  await page.getByTestId("camera-eye").click();
  await settleCamera(page);
  await stableItemScreenPosition(page, "cat");
  const grab = await worldToScreen(page, cat.position.x, 1.5 + cat.dims.h / 2, cat.position.z);
  const platform = await worldToScreen(page, tower.position.x + 0.2, 0.945, tower.position.z + 0.27);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(grab.x + ((platform.x - grab.x) * i) / 20, grab.y + ((platform.y - grab.y) * i) / 20);
  await expect(page.getByTestId("drag-target-label")).toHaveText("Cat tower — middle level");
  await shot(page, "drag-label-eye-cat-tower.png");
  await page.mouse.up();
  const moved = await itemById(page, "cat");
  expect(moved.supportId).toBe("tower");
  expect(moved.supportSurfaceY).toBeCloseTo(0.945, 3);
  expect(moved.position.y).toBeCloseTo(0.945, 3);
  // Stayed in view: its center projects inside the canvas.
  const box = (await page.getByTestId("scene-canvas").boundingBox())!;
  const at = await worldToScreen(page, moved.position.x, moved.position.y + moved.dims.h / 2, moved.position.z);
  expect(at.y).toBeLessThan(box.y + box.height);
});

test("Iso view: dragging onto a desk / under it / onto the floor, the dragged item's label names the target", async ({ page }) => {
  const room = defaultRoom();
  const desk = fromPreset("desk", "desk", { position: { x: 0.6, y: 0, z: -0.6 } });
  const bin = fromPreset("cylinder", "bin", { name: "Bin", dims: { w: 0.25, h: 0.25, d: 0.25 }, position: { x: -0.8, y: 0, z: 0.6 } });
  await seed(page, { room, items: [desk, bin] });
  await stableItemScreenPosition(page, "bin");
  const grab = await worldToScreen(page, bin.position.x, 0.12, bin.position.z);
  const top = await worldToScreen(page, desk.position.x, 0.75, desk.position.z);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(grab.x + ((top.x - grab.x) * i) / 20, grab.y + ((top.y - grab.y) * i) / 20);
  await expect(page.getByTestId("drag-target-label")).toHaveText("↑ On Desk");
  await shot(page, "drag-label-on-desk.png");
  const floor = await worldToScreen(page, -1, 0, 0.9);
  for (let i = 1; i <= 10; i++) await page.mouse.move(top.x + ((floor.x - top.x) * i) / 10, top.y + ((floor.y - top.y) * i) / 10);
  await expect(page.getByTestId("drag-target-label")).toHaveText("On the floor");
  await page.mouse.up();
  await expect(page.getByTestId("drag-target-label")).toHaveCount(0);
});

test("“add a floor lamp by the bed” lands on free floor beside the bed, not in the nightstand; the chip reads cleanly", async ({ page }) => {
  await seed(page, bedroom());
  const reply = await say(page, "add a floor lamp by the bed");
  const chip = reply.getByTestId("chat-action-chip").first();
  await expect(chip).toHaveAttribute("data-status", "ok");
  await expect(chip).toHaveText(/Added Floor lamp · next to Bed$/);
  const plan = await readStored(page);
  const lamp = plan.items.filter((it) => it.name === "Floor lamp").pop()!;
  const ns = plan.items.find((it) => it.id === "nightstand")!;
  const overlapX = Math.abs(lamp.position.x - ns.position.x) < (lamp.dims.w + ns.dims.d) / 2;
  const overlapZ = Math.abs(lamp.position.z - ns.position.z) < (lamp.dims.d + ns.dims.w) / 2;
  expect(overlapX && overlapZ).toBe(false);
  await shot(page, "chat-floor-lamp-by-bed.png");
});

test("Put on… lists only sensible surfaces; Drop clamps and shows what it used; an old floor pendant gets a hang hint", async ({ page }) => {
  const plan = bedroom();
  plan.items.push(fromPreset("cylinder", "bin", { name: "Bin", dims: { w: 0.25, h: 0.25, d: 0.25 }, position: { x: 0.9, y: 0, z: 1.2 } }));
  plan.items.push(fromPreset("pendant", "oldpendant", { name: "Paper pendant", mount: "floor", position: { x: -0.3, y: 0, z: 1.2 } }));
  await seed(page, plan);
  await page.getByTestId("tab-add").click();
  await page.getByTestId("item-row-bin").locator(".item-main").click();
  await expect(page.getByTestId("inspector-name")).toHaveValue("Bin");
  const options = await page.getByTestId("put-on-select").locator("option").allTextContents();
  expect(options).toContain("On top of Desk");
  expect(options).toContain("Under Desk");
  for (const bad of ["Floor lamp", "Monitor", "Table lamp", "Rug", "Hanging lamp"]) expect(options.join("|")).not.toContain(bad);

  // An old pendant saved as a floor item: the Inspector points at "Hang from ceiling".
  await page.getByTestId("item-row-oldpendant").locator(".item-main").click();
  await expect(page.getByTestId("hang-hint")).toBeVisible();
  await page.getByTestId("hang-btn").click();
  await expect(page.getByTestId("inspector-mount")).toHaveValue("ceiling");
  // Drop 0 is clamped to the pendant's own body (not ignored) and the field shows what was used.
  const drop = page.getByTestId("inspector-drop");
  await drop.fill("0");
  await drop.press("Enter");
  const used = (await itemById(page, "oldpendant")).dims.h;
  await expect(drop).toHaveValue(new RegExp(used < 0.6 ? "^1' ?[0-9]" : "."));
  expect(used).toBeLessThan(0.9);
  await drop.fill("20'");
  await drop.press("Enter");
  const p = await itemById(page, "oldpendant");
  expect(p.position.y).toBeCloseTo(0.3, 2);
  await expect(drop).toHaveValue(/^7' ?\d/);
});
