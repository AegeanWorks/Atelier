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
const out = join(ROOT, "shots", label);
mkdirSync(out, { recursive: true });
const stateName = (kind) => (label.length === 0 ? kind : kind === "before" ? "empty" : "conversation");
const viewports = [
  { width: 390, height: 844, name: "narrow" },
  { width: 768, height: 1024, name: "tablet" },
  { width: 1440, height: 900, name: "desktop" },
];

let ui;
let browser;
try {
  ui = await startUi();
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(ui.base, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 10_000 });
  const before = join(out, `atelier-${stateName("before")}.png`);
  await page.screenshot({ path: before, fullPage: true });
  console.log(`shot ${stateName("before")} ${before}`);

  await page.getByTestId("new-conversation").click();
  await page.waitForSelector('[data-testid="conversation-list"]', { timeout: 10_000 });
  const after = join(out, `atelier-${stateName("after")}.png`);
  await page.screenshot({ path: after, fullPage: true });
  console.log(`shot ${stateName("after")} ${after}`);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(ui.base, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 10_000 });
    const path = join(out, `atelier-${viewport.name}-dark.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(`shot ${viewport.name} ${path}`);
  }
  if (errors.length > 0) throw new Error(`console errors: ${errors.slice(0, 3).join(" | ")}`);
  console.log(`OK: screenshots complete${label.length === 0 ? "" : ` in shots/${label}`}`);
  process.exitCode = 0;
} catch (error) {
  console.error("What: the screenshot run failed.");
  console.error(`Why: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Fix: run `npm run build`, then retry; set EDGE_PATH if needed.");
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stopUi(ui);
}
