#!/usr/bin/env node
// Scenario: the first-run provider hint, then a click on "Open Settings", at 390/768/1440.
// Usage: node scripts/ui-firstrun-shots.mjs before|after   (writes shots/firstrun/<label>-<width>.png)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, startUi, stopUi } from "./browser.mjs";
import { ROOT } from "./runtime.mjs";

const label = process.argv[2] === "before" ? "before" : "after";
const out = join(ROOT, "shots", "firstrun");
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
  for (const view of viewports) {
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.goto(ui.base, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForSelector('[data-testid="provider-notice"]', { timeout: 10_000 });
    await page.screenshot({ path: join(out, `${label}-${view.name}-hint.png`) });
    await page.click('[data-testid="provider-settings"]');
    await page.waitForTimeout(500);
    const box = await page.locator('[data-testid="workspace-tabs"]').boundingBox();
    const visible = box !== null && box.y >= 0 && box.y < view.height && box.x >= 0 && box.x < view.width;
    console.log(`${view.name}: settingsVisibleAfterClick=${visible}`);
    if (!visible) failed = true;
    await page.screenshot({ path: join(out, `${label}-${view.name}-settings.png`) });
  }
} finally {
  if (browser) await browser.close();
  if (ui) await stopUi(ui);
}
process.exit(failed && label === "after" ? 1 : 0);
