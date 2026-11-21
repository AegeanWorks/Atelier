#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, startUi, stopUi } from "./browser.mjs";
import { ROOT } from "./runtime.mjs";

const label = (process.argv[2] ?? "").trim();
if (label.length > 0 && !/^[a-z0-9_-]+$/i.test(label)) {
  console.error("What: the screenshot label is invalid.");
  console.error(`Why: '${label}' is not a plain directory name.`);
  console.error("Fix: pass a label like before or after.");
  process.exit(1);
}
const out = join(ROOT, "shots", "composer", label.length === 0 ? "current" : label);
mkdirSync(out, { recursive: true });
const viewports = [
  { width: 1440, height: 900, name: "desktop" },
];

let ui;
let browser;
try {
  ui = await startUi();
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: viewports[2] });
  page.on("pageerror", (error) => console.error(`page error: ${error.message}`));
  // Layout evidence only: the stock shots have no provider, so the composer model chip is
  // never reached. The config read is served from a stub that names a real default model.
  await page.route("**/api/config", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        providers: [],
        roles: { executor: null, manager: null, auditor: null, compactor: null },
        defaults: { provider: "local", model: "claude-3.5-sonnet" },
        mcpServers: [],
        hooks: [],
        rules: [],
      }),
    });
  });
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(ui.base, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForSelector('[data-testid="composer"]', { timeout: 10_000 });
    await page.waitForTimeout(300);
    const path = join(out, `composer-${viewport.name}.png`);
    await page.screenshot({ path, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(`shot ${viewport.name} ${path}${overflow > 1 ? ` OVERFLOW ${overflow}px` : ""}`);
    if (overflow > 1) throw new Error(`horizontal overflow at ${viewport.width}px: ${overflow}px`);
  }
  console.log(`OK: composer screenshots complete in shots/composer/${label.length === 0 ? "current" : label}`);
  process.exitCode = 0;
} catch (error) {
  console.error("What: the composer screenshot run failed.");
  console.error(`Why: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Fix: run `npm run build`, then retry; set EDGE_PATH if needed.");
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stopUi(ui);
}
