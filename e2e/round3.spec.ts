import { test, expect, type Page } from "@playwright/test";
import type { DesignVersion } from "../src/shared/types";
import { STORAGE_KEY, readStored, waitForScene } from "./helpers";
import { bedroom, lighting, waitLighting } from "./lightingFixture";

// Round 3 integration: one chat message drives lighting + blinds + a lamp (a lighting-only turn is not a design change:
// no auto snapshot); a saved version restores all of it from the Versions drawer; and the crowded round-3 toolbar still
// fits at 1280 and 1024 px.

test.describe.configure({ timeout: 300_000 });

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

async function seedPendantOff(page: Page) {
  const plan = bedroom();
  plan.items = plan.items.map((it) => (it.id === "pendant" ? { ...it, light: { on: false, color: "#ffd8a8", intensity: 0.7 } } : it));
  await page.addInitScript(
    ([key, p]) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ state: { ...p, units: "imperial" }, version: 0 }));
    },
    [STORAGE_KEY, plan] as const,
  );
  await page.goto("/");
  await waitForScene(page);
}

const windows = async (page: Page) => (await readStored(page)).room.openings.filter((o) => o.kind === "window").map((o) => o.covering ?? "open");
const pendantOn = async (page: Page) => (await readStored(page)).items.find((it) => it.id === "pendant")?.light?.on;

test("“make it night, close the blinds and turn on the pendant” in one message, then restore the saved daytime version", async ({ page }) => {
  await seedPendantOff(page);
  expect(await windows(page)).toEqual(["open", "open"]);
  expect(await pendantOn(page)).toBe(false);
  await page.getByTestId("versions-btn").click();
  await page.getByTestId("version-name-input").fill("Daytime");
  await page.getByTestId("version-save-btn").click();
  await page.getByTestId("versions-close").click();

  const reply = await say(page, "make it night, close the blinds and turn on the pendant");
  await expect(reply).toContainText(/night/i);
  await waitLighting(page, "night");
  await expect(page.getByTestId("lighting-night")).toHaveAttribute("aria-pressed", "true");
  expect(await windows(page)).toEqual(["closed", "closed"]);
  expect(await pendantOn(page)).toBe(true);
  const lit = await lighting(page);
  expect(lit.lights.filter((l) => l.name.startsWith("sun-")).every((l) => l.intensity === 0)).toBe(true);
  expect(lit.lights.find((l) => l.name === "lamp-light-pendant")!.intensity).toBeGreaterThan(1);
  // Every chip is ok (no ok-with-an-error).
  const chips = reply.locator("[data-status]");
  expect(await chips.count()).toBeGreaterThanOrEqual(3);
  for (const s of await chips.evaluateAll((els) => els.map((e) => e.getAttribute("data-status")))) expect(s).toBe("ok");

  // Lighting, blinds and lamps are how the room is viewed: no "Before chat changes" auto version for this turn, and
  // the design still counts as saved.
  const versions = await page.evaluate(() => JSON.parse(localStorage.getItem("room-planner-versions-v1") ?? '{"versions":[]}').versions as DesignVersion[]);
  expect(versions.map((v) => v.name)).toEqual(["Daytime"]);
  expect(versions[0].room.lighting ?? "day").toBe("day");

  await page.getByTestId("versions-btn").click();
  await page.locator('[data-testid="version-row"][data-name="Daytime"]').getByTestId("version-restore").click();
  // Review round 5: restoring brings back the design and keeps how the room is viewed now (README): still night, the
  // blinds still closed, the pendant still on ("make it day" switches the view back).
  await expect(page.getByTestId("versions-message")).toContainText("Restored “Daytime”");
  await waitLighting(page, "night");
  await expect(page.getByTestId("lighting-night")).toHaveAttribute("aria-pressed", "true");
  expect(await windows(page)).toEqual(["closed", "closed"]);
  expect(await pendantOn(page)).toBe(true);
  expect((await readStored(page)).items.find((it) => it.id === "tablelamp")?.supportId).toBe("nightstand");
});

for (const width of [1440, 1366, 1280, 1024]) {
  test(`the round-3 toolbar (Light + Versions) fits at ${width} px: nothing cut off`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await page.goto("/");
    await waitForScene(page);
    const check = async () => {
      const overflow = await page.locator(".toolbar").evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      for (const id of ["lighting-night", "versions-btn", "export-btn", "reset-btn"]) {
        const box = await page.getByTestId(id).boundingBox();
        expect(box, id).not.toBeNull();
        expect(box!.x + box!.width, `${id} right edge`).toBeLessThanOrEqual(width);
      }
    };
    await check();
    // The "Versions" text shows wherever there is room for it (down to ~1100 px); below, the icon has a tooltip.
    await expect(page.getByTestId("versions-btn").locator(".versions-label")).toBeVisible({ visible: width > 1100 });
    // Reset's "Click again to reset" state still fits.
    await page.getByTestId("reset-btn").click();
    await expect(page.getByTestId("reset-btn")).toContainText("Click again");
    await check();
    if (width === 1280) await page.locator(".toolbar").screenshot({ path: "docs/screenshots/toolbar-1280.png" });
    if (width === 1024) await page.locator(".toolbar").screenshot({ path: "docs/screenshots/toolbar-1024.png" });
  });
}
