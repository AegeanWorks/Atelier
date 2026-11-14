#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, startUi, stopUi } from "./browser.mjs";
import { ROOT } from "./runtime.mjs";

const out = join(ROOT, "shots", "hooks");
mkdirSync(out, { recursive: true });
const viewports = [
  { width: 390, height: 844, name: "narrow" },
  { width: 768, height: 1024, name: "tablet" },
  { width: 1440, height: 900, name: "desktop" },
];
let ui;
let browser;
let failed = false;

async function openHooks(page) {
  const box = await page.locator('[data-testid="workspace-tabs"]').boundingBox();
  const viewportHeight = page.viewportSize().height;
  const onScreen = box !== null && box.y >= 0 && box.y < viewportHeight && box.x >= 0;
  if (!onScreen) await page.getByRole("button", { name: "Open workspace" }).click({ timeout: 5000 });
  await page.waitForTimeout(400);
  await page.getByRole("tab", { name: /settings/i }).click();
  await page.waitForSelector('[data-testid="hooks-card"]', { timeout: 10_000 });
  await page.locator('[data-testid="hooks-card"]').scrollIntoViewIfNeeded();
}

try {
  ui = await startUi();
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: viewports[2] });
  await page.goto(ui.base, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10_000 });
  await openHooks(page);
  await page.screenshot({ path: join(out, "before-desktop.png") });
  await page.fill('[data-testid="hook-name"]', "Block writes");
  await page.fill('[data-testid="hook-match"]', "write_file|edit_file");
  await page.fill('[data-testid="hook-command"]', "node scripts/check-writes.js");
  await page.click('[data-testid="save-hook"]');
  await page.waitForSelector('[data-testid="hook-row"]', { timeout: 10_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10_000 });
  await openHooks(page);
  await page.waitForSelector('[data-testid="hook-row"]', { timeout: 10_000 });
  console.log("hook persisted across a reload through the real server");
  for (const view of viewports) {
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.waitForTimeout(700);
    await openHooks(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    const row = await page.locator('[data-testid="hook-row"]').first().boundingBox();
    const form = await page.locator('[data-testid="add-hook"]').boundingBox();
    const inView = row !== null && form !== null && row.x >= 0 && row.x + row.width <= view.width + 1 && form.x + form.width <= view.width + 1;
    console.log(`${view.name}: horizontalScroll=${overflow} rowAndFormInViewport=${inView}`);
    if (overflow || !inView) failed = true;
    await page.screenshot({ path: join(out, `after-${view.name}.png`) });
  }
} finally {
  if (browser) await browser.close();
  if (ui) await stopUi(ui);
}
process.exit(failed ? 1 : 0);
