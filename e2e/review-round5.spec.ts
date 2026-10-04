import { test, expect, type Page } from "@playwright/test";
import type { PlacedItem, Room } from "../src/shared/types";
import { SHAPE_PRESETS, defaultRoom } from "../src/lib/presets";
import { STORAGE_KEY, readStored, settleCamera, shot, stableItemScreenPosition, waitForScene } from "./helpers";
import { worldToScreen } from "./lightingFixture";

// Review round 5 fixes: the Eye-view drag down off a cat tower / desk onto the floor in front of it, "next to" a bin
// under a desk, the Mount dropdown hanging a floor lamp like "Hang from ceiling", and lamp settings not counting as
// unsaved design changes.

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

/** Drag from the item's screen position straight to `to` in steps, returning the drop label seen at the end. */
async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 24) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
}

test("Eye view: dragging the cat from the tower's top perch down onto the floor in front of the tower puts it on the floor", async ({ page }) => {
  const tower = fromPreset("cattower", "tower", { position: { x: 0.5, y: 0, z: -0.5 } });
  const cat = fromPreset("cat", "cat", { position: { x: 0.5, y: 1.5, z: -0.5 }, supportId: "tower" });
  await seed(page, { room: defaultRoom(), items: [tower, cat] });
  await page.getByTestId("camera-eye").click();
  await settleCamera(page);
  const grab = await stableItemScreenPosition(page, "cat");
  // The floor just in front of the tower's near corner (seen from the door).
  const floor = await worldToScreen(page, 0.1, 0, -0.1);
  await dragTo(page, grab, floor);
  await expect(page.getByTestId("drag-target-label")).toHaveText("On the floor");
  await shot(page, "drag-eye-cat-to-floor.png");
  await page.mouse.up();
  const moved = await itemById(page, "cat");
  expect(moved.supportId).toBeUndefined();
  expect(moved.position.y).toBe(0);
  // On the floor in front of the tower, not inside its footprint.
  const inside = Math.abs(moved.position.x - 0.5) < 0.3 && Math.abs(moved.position.z + 0.5) < 0.3;
  expect(inside).toBe(false);
  expect(Math.hypot(moved.position.x - 0.1, moved.position.z + 0.1)).toBeLessThan(0.25);
});

test("Eye view: dragging a table lamp off a turned desk onto the floor in front of it puts it on the floor", async ({ page }) => {
  const desk = fromPreset("desk", "desk", { position: { x: 0.3, y: 0, z: -0.3 }, rotationY: -Math.PI / 4 });
  const lamp = fromPreset("tablelamp", "lamp", { position: { x: 0.3, y: 0.75, z: -0.3 }, rotationY: -Math.PI / 4, supportId: "desk" });
  await seed(page, { room: defaultRoom(), items: [desk, lamp] });
  await page.getByTestId("camera-eye").click();
  await settleCamera(page);
  const grab = await stableItemScreenPosition(page, "lamp");
  // 0.3 m in front of the desk's front edge (its front faces the door side).
  const floor = await worldToScreen(page, 0.3 - Math.SQRT1_2 * 0.6, 0, -0.3 + Math.SQRT1_2 * 0.6);
  await dragTo(page, grab, floor);
  await expect(page.getByTestId("drag-target-label")).toHaveText("On the floor");
  await page.mouse.up();
  const moved = await itemById(page, "lamp");
  expect(moved.supportId).toBeUndefined();
  expect(moved.position.y).toBe(0);
  await shot(page, "drag-eye-lamp-off-desk.png");
});

test("chat: “add a floor lamp next to the bin” with the bin under a desk puts it beside the desk, near the bin", async ({ page }) => {
  await seed(page, { room: defaultRoom(), items: [] });
  await say(page, "add a desk against the west wall");
  await say(page, "add a bin under the desk");
  const plan0 = await readStored(page);
  const bin = plan0.items.find((it) => /bin/i.test(it.name))!;
  const desk = plan0.items.find((it) => it.name === "Desk")!;
  expect(bin.supportId).toBe(desk.id);
  const reply = await say(page, "add a floor lamp next to the bin");
  const chip = reply.getByTestId("chat-action-chip").first();
  await expect(chip).toHaveAttribute("data-status", "adjusted");
  await expect(chip).toContainText("beside Desk");
  const plan = await readStored(page);
  const lamp = plan.items.filter((it) => it.name === "Floor lamp").pop()!;
  expect(lamp.supportId).toBeUndefined();
  // On the room side of the desk (it stands against the west wall), close to the bin, not in the room's middle.
  expect(lamp.position.x).toBeGreaterThan(desk.position.x + desk.dims.d / 2);
  expect(Math.hypot(lamp.position.x - bin.position.x, lamp.position.z - bin.position.z)).toBeLessThan(0.8);
  await shot(page, "chat-lamp-next-to-bin-under-desk.png");
});

test("Inspector: Mount → Ceiling (hanging) hangs a floor lamp exactly like “Hang from ceiling”", async ({ page }) => {
  const a = fromPreset("floorlamp", "a", { position: { x: -0.8, y: 0, z: 0 } });
  const b = fromPreset("floorlamp", "b", { name: "Floor lamp 2", position: { x: 0.8, y: 0, z: 0 } });
  await seed(page, { room: defaultRoom(), items: [a, b] });
  await page.getByTestId("tab-add").click();
  await page.getByTestId("item-row-a").locator(".item-main").click();
  await page.getByTestId("inspector-mount").selectOption("ceiling");
  await expect(page.getByTestId("inspector-mount")).toHaveValue("ceiling");
  await page.getByTestId("item-row-b").locator(".item-main").click();
  await page.getByTestId("hang-btn").click();
  await expect(page.getByTestId("inspector-mount")).toHaveValue("ceiling");
  const viaMount = await itemById(page, "a");
  const viaButton = await itemById(page, "b");
  expect(viaMount.mount).toBe("ceiling");
  expect(viaMount.dims).toEqual(viaButton.dims);
  expect(viaMount.parts).toEqual(viaButton.parts);
  expect(viaMount.position.y).toBeCloseTo(viaButton.position.y, 6);
  // A shade on a cord, its bottom at pendant height (not an upright 5' 3" lamp with its base in mid-air).
  expect(viaMount.dims.h).toBeLessThan(1);
  await page.getByTestId("item-row-a").locator(".item-main").click();
  await shot(page, "inspector-mount-ceiling-floor-lamp.png");
});

test("Versions: switching a lamp off / dimming it is not an unsaved design change", async ({ page }) => {
  const lamp = fromPreset("floorlamp", "lamp", { position: { x: -0.8, y: 0, z: 0 }, light: { on: true, color: "#ffd8a8", intensity: 0.7 } });
  await seed(page, { room: defaultRoom(), items: [lamp] });
  await say(page, "save this as option A");
  await say(page, "turn off the floor lamp");
  expect((await itemById(page, "lamp")).light?.on).toBe(false);
  await page.getByTestId("versions-btn").click();
  await expect(page.getByTestId("versions-panel")).toBeVisible();
  await expect(page.getByTestId("version-row").first()).toHaveAttribute("data-name", /option a/i);
  await expect(page.getByTestId("versions-current")).toHaveCount(0);
});
