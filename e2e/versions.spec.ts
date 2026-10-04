import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import type { ChatRequest, DesignVersion } from "../src/shared/types";
import { ROOM_JPG, openApp, readStored, shot, waitForScene } from "./helpers";

// Room design versions (ROUND3-SPEC section 2): the Versions drawer, auto snapshots, chat save / restore (demo
// parser), export all + import.

const VERSIONS_KEY = "room-planner-versions-v1";

async function storedVersions(page: Page): Promise<DesignVersion[]> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), VERSIONS_KEY);
  return raw ? (JSON.parse(raw) as { versions: DesignVersion[] }).versions : [];
}

const itemNames = async (page: Page) => (await readStored(page)).items.map((it) => it.name);
const rows = (page: Page) => page.getByTestId("version-row");
const row = (page: Page, name: string) => page.locator(`[data-testid="version-row"][data-name="${name}"]`);

async function openVersions(page: Page) {
  if (!(await page.getByTestId("versions-panel").isVisible())) await page.getByTestId("versions-btn").click();
  await expect(page.getByTestId("versions-panel")).toBeVisible();
}

async function closeVersions(page: Page) {
  await page.getByTestId("versions-close").click();
  await expect(page.getByTestId("versions-panel")).toHaveCount(0);
}

async function addPreset(page: Page, key: string) {
  await page.getByTestId("tab-add").click();
  await page.getByTestId(`preset-${key}`).click();
}

/** Send a chat message and wait for the assistant's reply bubble (same as chat.spec.ts). */
async function say(page: Page, text: string) {
  await page.getByTestId("tab-chat").click();
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

test("save, change, restore, rename and delete versions from the toolbar drawer", async ({ page }) => {
  await openApp(page);
  await addPreset(page, "box");
  expect(await itemNames(page)).toEqual(["Box"]);

  await openVersions(page);
  await expect(page.getByTestId("versions-current")).toContainText("Current (unsaved changes)");
  await expect(page.getByTestId("version-name-input")).toHaveAttribute("placeholder", "Version 1");
  await page.getByTestId("version-name-input").fill("Option A");
  await page.getByTestId("version-save-btn").click();
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, "Option A")).toHaveAttribute("data-auto", "false");
  await expect(row(page, "Option A")).toContainText("1 item");
  await expect(page.getByTestId("versions-current")).toHaveCount(0);
  // A JPEG thumbnail of the 3D view, captured once the view shows the saved design.
  await expect(row(page, "Option A").getByTestId("version-thumb")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
  const thumbSize = await row(page, "Option A")
    .getByTestId("version-thumb")
    .evaluate((img: HTMLImageElement) => ({ w: img.naturalWidth, h: img.naturalHeight }));
  expect(Math.max(thumbSize.w, thumbSize.h)).toBe(200);
  await closeVersions(page);

  // Change the design: the drawer shows the unsaved current design on top.
  await addPreset(page, "desk");
  expect(await itemNames(page)).toEqual(["Box", "Desk"]);
  await openVersions(page);
  await expect(page.getByTestId("versions-current")).toContainText("2 items");
  await shot(page, "versions-panel.png");

  // Restore: the current design is kept first as an auto snapshot, and the restore is undoable.
  await row(page, "Option A").getByTestId("version-restore").click();
  await expect.poll(() => itemNames(page)).toEqual(["Box"]);
  await expect(page.getByTestId("versions-message")).toContainText("Restored “Option A”");
  const before = row(page, "Before restoring Option A");
  await expect(before).toHaveAttribute("data-auto", "true");
  await expect(before.getByTestId("version-auto-badge")).toBeVisible();
  await expect(before).toContainText("2 items");
  // Named versions are listed first, then the automatic ones (newest first in each); each shows its clock time.
  await expect(rows(page).first()).toHaveAttribute("data-name", "Option A");
  await expect(page.locator('[data-testid="version-row"][data-auto="true"]').first()).toHaveAttribute("data-name", "Before restoring Option A");
  await expect(row(page, "Option A").getByTestId("version-time")).toContainText(/just now · \d{1,2}:\d{2}/);
  // Right after a restore the design is that version: no "Current (unsaved changes)" row.
  await expect(page.getByTestId("versions-current")).toHaveCount(0);
  await page.getByTestId("undo-btn").click();
  await expect.poll(() => itemNames(page)).toEqual(["Box", "Desk"]);

  // Rename, then delete (asks with a second click).
  await row(page, "Option A").getByTestId("version-rename").click();
  await page.getByTestId("version-rename-input").fill("Plan A");
  await page.getByTestId("version-rename-input").press("Enter");
  await expect(row(page, "Plan A")).toHaveCount(1);
  await row(page, "Plan A").getByTestId("version-delete").click();
  await expect(row(page, "Plan A").getByTestId("version-delete")).toHaveText("Delete?");
  await row(page, "Plan A").getByTestId("version-delete").click();
  await expect(row(page, "Plan A")).toHaveCount(0);

  // Versions survive a reload.
  expect((await storedVersions(page)).map((v) => v.name)).toEqual(["Before restoring Option A"]);
  await page.reload();
  await waitForScene(page);
  await openVersions(page);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAttribute("data-name", "Before restoring Option A");
});

test("building a room from photos keeps the previous design as an auto version", async ({ page }) => {
  await openApp(page);
  await addPreset(page, "box");
  await page.getByTestId("tab-room").click();
  await page.getByTestId("photo-input").setInputFiles(ROOM_JPG);
  await page.getByTestId("build-room-btn").click();
  await page.getByTestId("build-confirm-btn").click();
  await expect(page.getByTestId("build-notes")).toBeVisible({ timeout: 20_000 });
  const built = await readStored(page);
  expect(built.items.every((it) => it.origin === "existing")).toBe(true);

  const [snap] = await storedVersions(page);
  expect(snap).toMatchObject({ name: "Before photo build", auto: true, reason: "photo-build" });
  expect(snap.items.map((it) => it.name)).toEqual(["Box"]);
  expect(snap.thumbnail).toMatch(/^data:image\/jpeg;base64,/);

  await openVersions(page);
  await expect(row(page, "Before photo build")).toHaveAttribute("data-auto", "true");
  await row(page, "Before photo build").getByTestId("version-restore").click();
  await expect.poll(() => itemNames(page)).toEqual(["Box"]);
  // The photo-built room was kept too.
  await expect(row(page, "Before restoring Before photo build")).toContainText(`${built.items.length} item`);
});

test("chat saves and restores versions (demo parser)", async ({ page }) => {
  const bodies: ChatRequest[] = [];
  page.on("request", (req) => {
    if (req.url().endsWith("/api/chat")) bodies.push(req.postDataJSON() as ChatRequest);
  });
  await openApp(page);

  await say(page, "add a desk");
  let reply = await say(page, "save this as option A");
  await expect(reply.getByTestId("chat-action-chip")).toHaveAttribute("data-ok", "true");
  await expect(reply.getByTestId("chat-action-chip")).toContainText("Saved version “Option A”");
  expect((await storedVersions(page)).map((v) => v.name)).toEqual(["Option A"]);

  await say(page, "add a bed");
  expect(await itemNames(page)).toEqual(["Desk", "Bed"]);

  reply = await say(page, "go back to option A");
  await expect(reply.getByTestId("chat-action-chip")).toHaveAttribute("data-ok", "true");
  await expect(reply.getByTestId("chat-action-chip")).toContainText("Restored “Option A”");
  await expect.poll(() => itemNames(page)).toEqual(["Desk"]);
  // The scene sent with that message listed the saved versions.
  const sent = bodies[bodies.length - 1].scene.versions!;
  expect(sent.map((v) => v.name)).toEqual(["Option A"]);
  expect(sent[0]).toMatchObject({ auto: false, id: expect.stringMatching(/^ver_/) });

  // "The previous version" is the newest one: the design kept just before restoring.
  reply = await say(page, "restore the previous version");
  await expect(reply.getByTestId("chat-action-chip")).toContainText("Restored “Before restoring Option A”");
  await expect.poll(() => itemNames(page)).toEqual(["Desk", "Bed"]);

  // A version that doesn't exist: an answer, nothing changes.
  reply = await say(page, "go back to option Z");
  await expect(reply).toContainText("couldn't find a saved version");
  expect(await itemNames(page)).toEqual(["Desk", "Bed"]);
});

test("export all versions, then import them back", async ({ page }) => {
  await openApp(page);
  await addPreset(page, "box");
  await openVersions(page);
  await page.getByTestId("version-name-input").fill("Option A");
  await page.getByTestId("version-save-btn").click();
  await expect(rows(page)).toHaveCount(1);

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("versions-export-all").click()]);
  expect(download.suggestedFilename()).toBe("room-plan-versions.json");
  const file = await download.path();
  const data = JSON.parse(await readFile(file, "utf8"));
  expect(data.kind).toBe("room-planner-versions");
  expect(data.items.map((it: { name: string }) => it.name)).toEqual(["Box"]);
  expect(data.versions.map((v: DesignVersion) => v.name)).toEqual(["Option A"]);

  // Lose the version and change the design, then import the file.
  await row(page, "Option A").getByTestId("version-delete").click();
  await row(page, "Option A").getByTestId("version-delete").click();
  await expect(rows(page)).toHaveCount(0);
  await closeVersions(page);
  await addPreset(page, "desk");
  await page.getByTestId("import-input").setInputFiles(file);
  await expect.poll(() => itemNames(page)).toEqual(["Box"]);
  await openVersions(page);
  await expect(rows(page)).toHaveCount(2);
  await expect(row(page, "Option A")).toHaveCount(1);
  await expect(row(page, "Before import")).toContainText("2 items");
});
