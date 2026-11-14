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

const tabs = ["files", "git", "history", "plans", "preview", "task", "usage", "settings", "evals"];
const dir = label.length === 0 ? "panels" : `panels/${label}`;
const out = join(ROOT, "shots", dir);
mkdirSync(out, { recursive: true });

let ui;
let browser;
try {
  ui = await startUi();
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(ui.base, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 10_000 });
  await page.getByTestId("new-conversation").click();
  await page.waitForSelector('[data-testid="conversation-list"]', { timeout: 10_000 });

  for (const tab of tabs) {
    await page.getByTestId(`tab-${tab}`).click();
    await page.waitForSelector(`[data-testid="tab-${tab}"][aria-selected="true"]`, { timeout: 5_000 });
    await page.waitForTimeout(400);
    const path = join(out, `${tab}.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(`shot ${tab} ${path}`);
  }
  if (errors.length > 0) console.log(`page errors: ${errors.slice(0, 3).join(" | ")}`);
  console.log(`OK: panel screenshots complete in shots/${dir}`);
  process.exitCode = 0;
} catch (error) {
  console.error("What: the panel screenshot run failed.");
  console.error(`Why: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Fix: run `npm run build`, then retry; set EDGE_PATH if needed.");
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stopUi(ui);
}
