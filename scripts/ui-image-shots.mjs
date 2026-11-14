#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, startUi, stopUi } from "./browser.mjs";
import { ROOT } from "./runtime.mjs";

// A real 8x8 red PNG so the thumbnail has pixels to decode.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR42mP8z8Dwn4EIwDiqEAAGWwH/0xK4OQAAAABJRU5ErkJggg==",
  "base64",
);
const out = join(ROOT, "shots", "images");
mkdirSync(out, { recursive: true });
const viewports = [
  { width: 390, height: 844, name: "narrow" },
  { width: 768, height: 1024, name: "tablet" },
  { width: 1440, height: 900, name: "desktop" },
];
let ui;
let browser;
let failed = false;
try {
  ui = await startUi();
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: viewports[2] });
  await page.goto(ui.base, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10_000 });
  await page.screenshot({ path: join(out, "before-desktop.png") });
  await page.setInputFiles('[data-testid="image-input"]', [
    { name: "a.png", mimeType: "image/png", buffer: PNG },
    { name: "b.png", mimeType: "image/png", buffer: Buffer.concat([PNG, Buffer.from([0])]) },
  ]);
  await page.waitForSelector('[data-testid="pending-image"]', { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="pending-image"]').length === 2, null, { timeout: 10_000 });
  const decoded = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="pending-image"] img')).every((img) => img.complete && img.naturalWidth > 0));
  console.log(`thumbnails decoded through cookie auth: ${decoded}`);
  if (!decoded) failed = true;
  for (const view of viewports) {
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.waitForTimeout(700);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    const box = await page.locator('[data-testid="image-tray"]').boundingBox();
    const inView = box !== null && box.x >= 0 && box.x + box.width <= view.width + 1;
    console.log(`${view.name}: horizontalScroll=${overflow} trayInViewport=${inView}`);
    if (overflow || !inView) failed = true;
    await page.screenshot({ path: join(out, `after-${view.name}.png`) });
  }
} finally {
  if (browser) await browser.close();
  if (ui) await stopUi(ui);
}
process.exit(failed ? 1 : 0);
