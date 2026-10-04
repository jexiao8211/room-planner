// Regenerates e2e/fixtures/room.jpg: a small synthetic "room photo" drawn on a canvas in headless Chromium.
// Usage: node e2e/fixtures/make-room-jpg.mjs
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const browser = await chromium.launch();
const page = await browser.newPage();
const b64 = await page.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = 640;
  c.height = 480;
  const g = c.getContext("2d");
  g.fillStyle = "#e9e4dc"; // back wall
  g.fillRect(0, 0, 640, 480);
  g.fillStyle = "#d8d1c5"; // side walls
  g.beginPath(); g.moveTo(0, 0); g.lineTo(140, 90); g.lineTo(140, 330); g.lineTo(0, 480); g.fill();
  g.beginPath(); g.moveTo(640, 0); g.lineTo(500, 90); g.lineTo(500, 330); g.lineTo(640, 480); g.fill();
  g.fillStyle = "#b89874"; // floor
  g.beginPath(); g.moveTo(0, 480); g.lineTo(140, 330); g.lineTo(500, 330); g.lineTo(640, 480); g.fill();
  g.fillStyle = "#bcd7ee"; // window
  g.fillRect(260, 130, 120, 90);
  g.fillStyle = "#c9c2b6"; // bed
  g.fillRect(200, 280, 220, 80);
  g.fillStyle = "#8b6f4e";
  g.fillRect(200, 240, 220, 40);
  return c.toDataURL("image/jpeg", 0.8).split(",")[1];
});
await browser.close();
const out = fileURLToPath(new URL("./room.jpg", import.meta.url));
writeFileSync(out, Buffer.from(b64, "base64"));
console.log(`wrote ${out}`);
