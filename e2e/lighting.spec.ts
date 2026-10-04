import { test, expect, type Page } from "@playwright/test";
import { readStored, settleCamera, shot, stableItemScreenPosition, waitForScene } from "./helpers";
import { brightness, lighting, seed, waitLighting, worldToScreen, type LightInfo } from "./lightingFixture";

// Lighting modes (Day / Evening / Night), lamps as light sources, and window blinds: toolbar, inspector, 3D window
// popover, Room tab and chat (mock parser) all drive the same plan fields (room.lighting, item.light,
// opening.covering). Headless runs use software WebGL, so these tests are slow-ish but render real shadows.

test.describe.configure({ timeout: 300_000 });

const light = (lights: LightInfo[], name: string) => {
  const l = lights.find((x) => x.name === name);
  expect(l, `light ${name}`).toBeTruthy();
  return l!;
};

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

test("lighting modes look clearly different (screenshots), and the room stays readable with the cutaway at night", async ({ page }) => {
  await seed(page);
  let lit = await lighting(page);
  expect(lit.mode).toBe("day");
  expect(lit.lampLights).toBe(3);
  expect(lit.sunBeams).toBe(2);
  // Daylight: lamps add little and cast no shadows; the open windows' sun beams are on.
  expect(lit.lampShadows).toBe(0);
  expect(light(lit.lights, "sun-win_1").intensity).toBeGreaterThan(50);
  await expect(page.getByTestId("lighting-day")).toHaveAttribute("aria-pressed", "true");
  await shot(page, "lighting-day.png");
  const day = await brightness(page);

  await page.getByTestId("lighting-evening").click();
  await waitLighting(page, "evening");
  lit = await lighting(page);
  expect(lit.lampShadows).toBe(2); // the brightest two of three lamps
  await shot(page, "lighting-evening.png");
  const evening = await brightness(page);

  await page.getByTestId("lighting-night").click();
  await waitLighting(page, "night");
  lit = await lighting(page);
  // Night: no sun at all, only the lamps.
  expect(light(lit.lights, "sun-win_1").intensity).toBe(0);
  expect(light(lit.lights, "lamp-light-pendant").intensity).toBeGreaterThan(1);
  await shot(page, "lighting-night.png");
  const night = await brightness(page);
  console.log(`mean brightness: day ${day.toFixed(1)}, evening ${evening.toFixed(1)}, night ${night.toFixed(1)}`);
  expect(day - evening).toBeGreaterThan(12);
  expect(evening - night).toBeGreaterThan(20);
  // Walls / floor still readable: not a black frame.
  expect(night).toBeGreaterThan(45);

  // Cutaway still works: from the default corner view the two walls facing the camera are faded, the others solid.
  const op = await page.evaluate(() => (window as unknown as { __plannerDebug: { getWallOpacities: () => Record<string, number> } }).__plannerDebug.getWallOpacities());
  expect(op.south).toBeLessThan(0.5);
  expect(op.east).toBeLessThan(0.5);
  expect(op.north).toBeGreaterThan(0.9);
  expect(op.west).toBeGreaterThan(0.9);

  // The mode is saved with the plan and comes back after a reload.
  expect((await readStored(page)).room.lighting).toBe("night");
  await page.reload();
  await waitForScene(page);
  await expect(page.getByTestId("lighting-night")).toHaveAttribute("aria-pressed", "true");
  expect((await lighting(page)).mode).toBe("night");
});

test("a lamp's light: inspector on/off, brightness and warm/cool", async ({ page }) => {
  await seed(page);
  await page.getByTestId("lighting-night").click();
  await waitLighting(page, "night");

  // Select the pendant in 3D: the inspector shows its light controls.
  const p = await stableItemScreenPosition(page, "pendant");
  await page.mouse.click(p.x, p.y);
  await expect(page.getByTestId("inspector")).toBeVisible();
  const toggle = page.getByTestId("light-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await settleCamera(page);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect((await readStored(page)).items.find((it) => it.id === "pendant")!.light!.on).toBe(false);
  await expect.poll(async () => light((await lighting(page)).lights, "lamp-light-pendant").intensity).toBe(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("light-brightness").press("End");
  await expect.poll(async () => (await readStored(page)).items.find((it) => it.id === "pendant")!.light!.intensity).toBe(1);
  const before = (await readStored(page)).items.find((it) => it.id === "pendant")!.light!.color;
  await page.getByTestId("light-warmth").press("Home");
  await expect.poll(async () => (await readStored(page)).items.find((it) => it.id === "pendant")!.light!.color).not.toBe(before);
  const cool = (await readStored(page)).items.find((it) => it.id === "pendant")!.light!.color;
  // Cool light has more blue than red.
  expect(parseInt(cool.slice(5, 7), 16)).toBeGreaterThan(parseInt(cool.slice(1, 3), 16));
  await expect.poll(async () => light((await lighting(page)).lights, "lamp-light-pendant").color).toBe(cool);

  // Turning all three lamps off makes the night room clearly darker (but not black); on again, it's lit again.
  await page.keyboard.press("Escape");
  await say(page, "turn off all the lights");
  const items = (await readStored(page)).items;
  expect(items.filter((it) => it.light).every((it) => it.light!.on === false)).toBe(true);
  await settleCamera(page);
  const dark = await brightness(page);
  await say(page, "turn on all the lights");
  await settleCamera(page);
  const lit = await brightness(page);
  console.log(`night with lamps ${lit.toFixed(1)}, without ${dark.toFixed(1)}`);
  expect(lit - dark).toBeGreaterThan(6);
  expect(dark).toBeGreaterThan(30);
});

test("windows: click a window in 3D to close its blinds, Room tab and chat open / close them", async ({ page }) => {
  await seed(page);
  // Click the north window's glass: a small popover with Open / Blinds closed.
  const c = await worldToScreen(page, -3.66 / 2 + 1.6, 0.9 + 0.6 + 0.25, -3.35 / 2);
  await page.mouse.click(c.x, c.y);
  const pop = page.getByTestId("window-popover");
  await expect(pop).toBeVisible();
  await expect(pop).toContainText("north");
  await expect(page.getByTestId("window-open-btn")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("window-close-btn").click();
  await expect(page.getByTestId("window-close-btn")).toHaveAttribute("aria-pressed", "true");
  expect((await readStored(page)).room.openings.find((o) => o.id === "win_1")!.covering).toBe("closed");
  // Its sun beam goes out; the other window's stays.
  await expect.poll(async () => light((await lighting(page)).lights, "sun-win_1").intensity).toBeLessThan(0.1);
  expect(light((await lighting(page)).lights, "sun-win_2").intensity).toBeGreaterThan(50);
  await page.getByTestId("window-popover-close").click();
  await expect(pop).toBeHidden();
  await page.waitForTimeout(600);
  await shot(page, "window-closed.png");

  // Room tab: the openings list has a Blinds toggle for each window (none for the door).
  await page.getByTestId("tab-room").click();
  await expect(page.getByTestId("opening-covering-closed-win_1")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("opening-covering-open-door_1")).toHaveCount(0);
  await page.getByTestId("opening-covering-open-win_1").click();
  expect((await readStored(page)).room.openings.find((o) => o.id === "win_1")!.covering).toBe("open");
  await page.getByTestId("opening-covering-closed-win_2").click();
  expect((await readStored(page)).room.openings.find((o) => o.id === "win_2")!.covering).toBe("closed");

  // Chat (demo parser): close all, then open only the one by the desk (the east window).
  await page.getByTestId("tab-chat").click();
  let reply = await say(page, "close the blinds");
  await expect(reply.getByTestId("chat-action-chip").first()).toContainText("Closed the blinds");
  let openings = (await readStored(page)).room.openings;
  expect(openings.filter((o) => o.kind === "window").every((o) => o.covering === "closed")).toBe(true);
  reply = await say(page, "open the window by the desk");
  await expect(reply).toContainText("by the desk");
  openings = (await readStored(page)).room.openings;
  expect(openings.find((o) => o.id === "win_2")!.covering).toBe("open");
  expect(openings.find((o) => o.id === "win_1")!.covering).toBe("closed");
});

test("chat drives lighting end to end: night, lamps off / warmer, and a new lamp lights up", async ({ page }) => {
  await seed(page);
  let reply = await say(page, "make it night");
  await expect(reply.getByTestId("chat-action-chip").first()).toContainText("Night");
  await expect(page.getByTestId("lighting-night")).toHaveAttribute("aria-pressed", "true");
  await waitLighting(page, "night");

  reply = await say(page, "turn off the pendant");
  await expect(reply.getByTestId("chat-action-chip").first()).toContainText("Turned off Hanging lamp");
  let items = (await readStored(page)).items;
  expect(items.find((it) => it.id === "pendant")!.light!.on).toBe(false);

  const warmBefore = items.find((it) => it.id === "tablelamp")!.light!.color;
  reply = await say(page, "make the table lamp warmer");
  await expect(reply.getByTestId("chat-action-chip").first()).toContainText("warmer");
  items = (await readStored(page)).items;
  const warm = items.find((it) => it.id === "tablelamp")!.light!.color;
  expect(warm).not.toBe(warmBefore);
  // Warmer = less blue.
  expect(parseInt(warm.slice(5, 7), 16)).toBeLessThan(parseInt(warmBefore.slice(5, 7), 16));

  // A new lamp from chat gets a light of its own.
  reply = await say(page, "add a floor lamp next to the bed");
  items = (await readStored(page)).items;
  const added = items.filter((it) => it.name === "Floor lamp").find((it) => it.id !== "floorlamp")!;
  expect(added.light).toMatchObject({ on: true });
  await expect.poll(async () => (await lighting(page)).lampLights).toBe(4);

  // One "Undo this" reverts just that reply.
  reply = await say(page, "make it day");
  await expect(page.getByTestId("lighting-day")).toHaveAttribute("aria-pressed", "true");
  await reply.getByTestId("chat-undo").click();
  await expect(page.getByTestId("lighting-night")).toHaveAttribute("aria-pressed", "true");
});
