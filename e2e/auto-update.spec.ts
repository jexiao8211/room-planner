import { test, expect } from "@playwright/test";
import { openApp, waitForScene } from "./helpers";

// Auto-update (src/ui/autoUpdate.ts) only runs in a production build served from release/ (npm start); this suite
// runs the Vite dev server, where it must stay off. What it can cover here: the dev page never polls or reloads,
// the chat draft survives a reload, and a request the server dropped mid-way offers a one-click Resend that
// survives a reload. The reload-when-safe behavior itself is proven against vite preview by a separate script
// (see the round 3 report).

test("the dev server page never polls /version.json and never shows the update bar", async ({ page }) => {
  const polls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/version.json")) polls.push(r.url());
  });
  // Even a version.json with another id must be ignored by a dev page.
  await page.route("**/version.json*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"buildId":"other"}' }));
  await openApp(page);
  await page.evaluate(() => {
    (window as unknown as { __marker?: number }).__marker = 1;
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(2500);
  expect(polls).toEqual([]);
  await expect(page.getByTestId("update-bar")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
});

test("a typed chat message survives a reload", async ({ page }) => {
  await openApp(page);
  const input = page.getByTestId("chat-input");
  await input.click();
  await page.keyboard.type("put a lamp next to the bed");
  await page.reload();
  await waitForScene(page);
  await expect(page.getByTestId("chat-input")).toHaveValue("put a lamp next to the bed");
  await expect(page.getByTestId("chat-input")).toBeFocused();
  // Sending clears the saved draft too.
  await page.getByTestId("chat-input").press("Enter");
  await expect(page.locator('[data-testid="chat-message"][data-role="assistant"]').first()).toBeVisible();
  await page.reload();
  await waitForScene(page);
  await expect(page.getByTestId("chat-input")).toHaveValue("");
});

test("a chat request the server dropped mid-way offers Resend, also after a reload", async ({ page }) => {
  await openApp(page);
  // The preview proxy answers 502 with an empty body when the API is restarting (a redeploy).
  let drop = true;
  await page.route("**/api/chat", (route) => (drop ? route.fulfill({ status: 502, contentType: "text/plain", body: "" }) : route.continue()));
  const input = page.getByTestId("chat-input");
  await input.fill("add a desk against the west wall");
  await input.press("Enter");
  const error = page.locator('[data-testid="chat-message"][data-kind="error"]').last();
  // Under the dev server there is no new build to point at, so it says the connection dropped.
  await expect(error).toContainText("please resend");
  await expect(error.getByTestId("chat-retry")).toHaveText("Resend");

  await page.reload();
  await waitForScene(page);
  const restored = page.locator('[data-testid="chat-message"][data-kind="error"]').last();
  await expect(restored.getByTestId("chat-retry")).toHaveText("Resend");
  drop = false;
  await restored.getByTestId("chat-retry").click();
  await expect(page.locator('[data-testid="chat-message"][data-role="assistant"]').last()).toContainText(/desk/i);
});

test("an API error that isn't a dropped connection keeps the plain Retry", async ({ page }) => {
  await openApp(page);
  await page.route("**/api/chat", (route) =>
    route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Claude returned an unusable chat answer. Please try again." }) }),
  );
  await page.getByTestId("chat-input").fill("add a desk");
  await page.getByTestId("chat-input").press("Enter");
  const error = page.locator('[data-testid="chat-message"][data-kind="error"]').last();
  await expect(error).toContainText("unusable chat answer");
  await expect(error.getByTestId("chat-retry")).toHaveText("Retry");
});
