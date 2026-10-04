import { test, expect, type Page } from "@playwright/test";
import type { PlacedItem } from "../src/shared/types";
import { openApp, readStored, settleCamera, shot, stableItemScreenPosition, waitForScene } from "./helpers";

// The chat drives the planner end to end in mock mode: the API answers with the demo parser (server/mockChat.ts),
// the browser applies the actions (src/ui/chat/executeActions.ts).

const CHAT_KEY = "room-planner-chat-v1";

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

/**
 * Type a message, send it with Enter and wait for the assistant's reply bubble. Returns the reply locator (a search
 * turn adds a second bubble after it: the search progress / results).
 */
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

/** Half extents of an item's footprint on the floor, after its rotation (rotationY is in radians). */
function halfExtents(it: PlacedItem) {
  const r = it.rotationY;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  return { x: (c * it.dims.w + s * it.dims.d) / 2, z: (s * it.dims.w + c * it.dims.d) / 2 };
}

const byName = (items: PlacedItem[], name: string) => items.filter((it) => it.name === name);
/** A rotation (radians) as degrees in [0, 360). */
const deg = (rad: number) => ((((rad * 180) / Math.PI) % 360) + 360) % 360;

test("chat is the main way to drive the planner: add, stack, recolor, undo, search, place, rotate, reload", async ({ page }) => {
  await openApp(page);

  // Chat is the first tab and is open by default, showing the example prompts.
  const tabs = page.getByRole("tab");
  await expect(tabs.first()).toHaveAttribute("data-testid", "tab-chat");
  await expect(page.getByTestId("tab-chat")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await expect(page.getByTestId("chat-example")).toHaveCount(4);
  await shot(page, "chat-empty.png");

  let plan = await readStored(page);
  const room = plan.room;
  const startCount = plan.items.length;

  // 1. Clicking an example sends it: "Add a desk against the west wall".
  await page.getByTestId("chat-example").filter({ hasText: "Add a desk against the west wall" }).click();
  await expect(page.locator('[data-testid="chat-message"][data-role="user"]').first()).toHaveText("Add a desk against the west wall");
  const first = page.locator('[data-testid="chat-message"][data-role="assistant"]').first();
  await expect(first).toBeVisible();
  await expect(first.getByTestId("chat-action-chip").first()).toHaveAttribute("data-ok", "true");
  await expect(first).toContainText("demo parser");
  plan = await readStored(page);
  expect(plan.items.length).toBe(startCount + 1);
  const [desk1] = byName(plan.items, "Desk");
  // Flush against the west wall (x = -width/2), facing into the room.
  expect(desk1.position.x - halfExtents(desk1).x).toBeCloseTo(-room.width / 2, 2);
  expect(deg(desk1.rotationY)).toBeCloseTo(90, 3);
  expect(desk1.position.y).toBe(0);

  // 2. "put a monitor on the desk" -> a Monitor resting on the desk.
  let reply = await say(page, "put a monitor on the desk");
  await expect(reply.getByTestId("chat-action-chip").first()).toHaveAttribute("data-ok", "true");
  await expect(reply.getByTestId("chat-action-chip").first()).toContainText("Desk");
  plan = await readStored(page);
  let desk = plan.items.find((it) => it.id === desk1.id)!;
  let monitor = byName(plan.items, "Monitor")[0];
  expect(monitor, "monitor added").toBeTruthy();
  expect(monitor.supportId).toBe(desk.id);
  expect(monitor.position.y).toBeCloseTo(desk.position.y + desk.dims.h, 4);
  expect(Math.abs(monitor.position.x - desk.position.x)).toBeLessThan(halfExtents(desk).x);
  expect(Math.abs(monitor.position.z - desk.position.z)).toBeLessThan(halfExtents(desk).z);
  await settleCamera(page);
  await shot(page, "chat-monitor-on-desk.png");

  // 3. "make the monitor black" -> color changes; "Undo this" on that message reverts only that turn.
  const colorBefore = monitor.color;
  reply = await say(page, "make the monitor black");
  plan = await readStored(page);
  monitor = plan.items.find((it) => it.id === monitor.id)!;
  expect(monitor.color).not.toBe(colorBefore);
  expect(monitor.color.toLowerCase()).toMatch(/^#(1|2)[0-9a-f]{5}$/); // a near-black hex
  await reply.getByTestId("chat-undo").click();
  await expect(reply).toContainText("Undone");
  plan = await readStored(page);
  monitor = plan.items.find((it) => it.id === monitor.id)!;
  expect(monitor.color).toBe(colorBefore);
  // The earlier turns are untouched: the desk and the stacked monitor are still there.
  expect(plan.items.find((it) => it.id === desk1.id)).toBeTruthy();
  expect(monitor.supportId).toBe(desk1.id);
  // Redo brings the black back; the earlier turns' "Undo this" buttons are still offered.
  await reply.getByTestId("chat-redo").click();
  plan = await readStored(page);
  expect(plan.items.find((it) => it.id === monitor.id)!.color).not.toBe(colorBefore);

  // 4. Product search from the chat: progress bubble, then a results message with cards.
  reply = await say(page, "find a japanese hanging lamp under $200");
  await expect(reply).toContainText("1-3 minutes");
  const results = page.getByTestId("chat-results");
  await expect(page.getByTestId("chat-search-progress").or(results)).toBeVisible();
  await expect(results).toBeVisible({ timeout: 20_000 });
  const cards = results.getByTestId("chat-results-card");
  expect(await cards.count()).toBeGreaterThan(0);
  await expect(cards.first().getByTestId("chat-result-add")).toBeVisible();
  await shot(page, "chat-search-results.png");
  const firstName = (await cards.first().locator(".chat-result-name").textContent())!.trim();

  // 5. "add the first one in the north-east corner" -> that product, hung from the ceiling in the NE corner.
  reply = await say(page, "add the first one in the north-east corner");
  await expect(reply.getByTestId("chat-action-chip").first()).toHaveAttribute("data-ok", "true");
  plan = await readStored(page);
  const lamp = plan.items.find((it) => it.product && it.name === firstName) ?? plan.items.find((it) => it.product);
  expect(lamp, "product placed").toBeTruthy();
  expect(lamp!.product!.name).toBe(firstName);
  expect(lamp!.mount).toBe("ceiling");
  expect(lamp!.position.y + lamp!.dims.h).toBeCloseTo(room.height, 2);
  // North-east: x towards +width/2, z towards -depth/2, within a metre of the corner.
  expect(lamp!.position.x).toBeGreaterThan(room.width / 2 - 1);
  expect(lamp!.position.z).toBeLessThan(-room.depth / 2 + 1);
  expect(lamp!.position.x + halfExtents(lamp!).x).toBeLessThanOrEqual(room.width / 2 + 1e-6);
  expect(lamp!.position.z - halfExtents(lamp!).z).toBeGreaterThanOrEqual(-room.depth / 2 - 1e-6);
  await settleCamera(page);
  await shot(page, "chat-product-placed.png");

  // 6. Select the desk in 3D (click its top, away from the monitor), then "rotate it 90 degrees".
  plan = await readStored(page);
  desk = plan.items.find((it) => it.id === desk1.id)!;
  // Start from nothing selected so the click is what selects the desk.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await stableItemScreenPosition(page, desk.id);
  // The desk runs along z (rotated 90°): click its top 0.45 m from the middle, clear of the monitor.
  const target = await worldToScreen(page, desk.position.x, desk.dims.h, desk.position.z + 0.45);
  await page.mouse.click(target.x, target.y);
  await expect(page.getByTestId("inspector-name")).toHaveValue("Desk");
  // The inspector opening resizes the canvas; let the layout settle before chatting.
  await page.waitForTimeout(300);
  const monitorBefore = plan.items.find((it) => it.id === monitor.id)!;
  reply = await say(page, "rotate it 90 degrees");
  await expect(reply.getByTestId("chat-action-chip").first()).toHaveAttribute("data-ok", "true");
  await expect(reply.getByTestId("chat-action-chip").first()).toContainText("Desk");
  plan = await readStored(page);
  const rotated = plan.items.find((it) => it.id === desk1.id)!;
  expect(deg(rotated.rotationY - desk.rotationY)).toBeCloseTo(90, 3);
  // The monitor rides along: still on the desk, turned with it.
  const carried = plan.items.find((it) => it.id === monitor.id)!;
  expect(carried.supportId).toBe(desk1.id);
  expect(deg(carried.rotationY - monitorBefore.rotationY)).toBeCloseTo(90, 3);
  expect(carried.position.y).toBeCloseTo(rotated.dims.h, 4);
  await settleCamera(page);
  await shot(page, "chat-rotated.png");

  // 7. The conversation survives a reload (results cards included); the plan too.
  const messageCount = await page.getByTestId("chat-message").count();
  expect(messageCount).toBeGreaterThanOrEqual(10);
  const stored = await page.evaluate((k) => localStorage.getItem(k), CHAT_KEY);
  expect(stored).not.toBeNull();
  await page.reload();
  await waitForScene(page);
  await expect(page.getByTestId("tab-chat")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("chat-message")).toHaveCount(messageCount);
  await expect(page.locator('[data-testid="chat-message"][data-role="user"]').first()).toHaveText("Add a desk against the west wall");
  await expect(page.getByTestId("chat-results").getByTestId("chat-results-card").first()).toBeVisible();
  // The newest message is scrolled into view (thumbnails that load late must not push it out of sight).
  await page.waitForTimeout(500);
  await expect(page.getByTestId("chat-message").last()).toBeInViewport({ ratio: 0.9 });
  await expect(page.getByTestId("chat-message").last()).toContainText("Rotated the desk");
  const after = await readStored(page);
  expect(after.items.find((it) => it.id === monitor.id)!.supportId).toBe(desk1.id);
  await shot(page, "chat-after-reload.png");
});

test("unknown requests get a friendly help reply with no changes; Shift+Enter makes a new line", async ({ page }) => {
  await openApp(page);
  const before = (await readStored(page)).items.length;
  const input = page.getByTestId("chat-input");
  await input.fill("first line");
  await input.press("Shift+Enter");
  await input.pressSequentially("second line");
  await expect(input).toHaveValue("first line\nsecond line");
  await input.fill("");
  const reply = await say(page, "sing me a song about chairs");
  await expect(reply.getByTestId("chat-action-chip")).toHaveCount(0);
  await expect(reply.getByTestId("chat-undo")).toHaveCount(0);
  expect((await readStored(page)).items.length).toBe(before);
});
