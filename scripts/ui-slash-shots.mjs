#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, startUi, stopUi } from "./browser.mjs";
import { ROOT } from "./runtime.mjs";

const out = join(ROOT, "shots", "slash");
mkdirSync(out, { recursive: true });
const viewports = [
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
  for (const view of viewports) {
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.fill('[data-testid="composer-input"]', "");
    await page.screenshot({ path: join(out, `before-${view.name}.png`) });
    await page.fill('[data-testid="composer-input"]', "/");
    await page.waitForSelector('[data-testid="slash-menu"]', { timeout: 5000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    const box = await page.locator('[data-testid="slash-menu"]').boundingBox();
    const inView = box !== null && box.x >= 0 && box.x + box.width <= view.width + 1;
    console.log(`${view.name}: horizontalScroll=${overflow} menuInViewport=${inView}`);
    if (overflow || !inView) failed = true;
    await page.screenshot({ path: join(out, `after-${view.name}.png`) });
  }
} finally {
  if (browser) await browser.close();
  if (ui) await stopUi(ui);
}
process.exit(failed ? 1 : 0);
