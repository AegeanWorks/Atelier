#!/usr/bin/env node
// Scenario: open the workspace overlay, then return to the conversation, at 1440.
// Usage: node scripts/ui-workspace-exit-shots.mjs before|after   (writes shots/workspace-exit/<label>-<width>-*.png)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, startUi, stopUi } from "./browser.mjs";
import { ROOT } from "./runtime.mjs";

const label = process.argv[2] === "before" ? "before" : "after";
const out = join(ROOT, "shots", "workspace-exit");
mkdirSync(out, { recursive: true });
const viewports = [
  { width: 1440, height: 900, name: "desktop" },
];
let ui;
let browser;
let failed = false;

async function composerReachable(page, view) {
  const box = await page.locator('[data-testid="composer-input"]').boundingBox();
  const top = box === null ? null : await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="workspace"]') !== null, { x: box.x + 4, y: box.y + 4 });
  return box !== null && box.y >= 0 && box.y < view.height && top === false;
}

try {
  ui = await startUi();
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: viewports[2] });
  for (const view of viewports) {
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.goto(ui.base, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10_000 });
    const opener = page.getByRole("button", { name: "Open workspace" });
    if (await opener.isVisible()) await opener.click();
    await page.waitForTimeout(450);
    await page.screenshot({ path: join(out, `${label}-${view.name}-open.png`) });
    const back = page.getByRole("button", { name: /back to conversation/i });
    if (await back.isVisible().catch(() => false)) await back.click();
    await page.waitForTimeout(450);
    const reachable = await composerReachable(page, view);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log(`${view.name}: composerReachableAfterOpen=${reachable} horizontalScroll=${overflow}`);
    if (!reachable || overflow) failed = true;
    await page.screenshot({ path: join(out, `${label}-${view.name}-back.png`) });
  }
} finally {
  if (browser) await browser.close();
  if (ui) await stopUi(ui);
}
process.exit(failed && label === "after" ? 1 : 0);
