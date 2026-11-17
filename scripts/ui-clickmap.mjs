#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, startUi, stopUi } from "./browser.mjs";
import { ROOT } from "./runtime.mjs";

const OUT = join(ROOT, ".aikit", "clickmap.log");
const TABS = ["files", "git", "history", "plans", "preview", "task", "usage", "settings", "evals"];

const lines = [];
const record = (line) => {
  lines.push(line);
  console.log(line);
};

let ui;
let browser;
let verified = 0;
try {
  mkdirSync(join(ROOT, ".aikit"), { recursive: true });
  ui = await startUi();
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(ui.base, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 10_000 });

  const drive = async (testId, observe, selector) => {
    try {
      await page.getByTestId(testId).first().click({ timeout: 5_000 });
      await page.waitForSelector(selector, { state: "visible", timeout: 5_000 });
      record(`click ${testId} -> ${observe}`);
      verified += 1;
    } catch (error) {
      record(`click ${testId} -> failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  };

  await drive("new-conversation", "conversation-list visible", '[data-testid="conversation-list"]');
  for (const tab of TABS) {
    await drive(`tab-${tab}`, `${tab}-panel visible and the tab selected`, `[data-testid="${tab}-panel"]`);
    const selected = await page.getByTestId(`tab-${tab}`).first().getAttribute("aria-selected");
    if (selected !== "true") record(`click tab-${tab} -> the panel opened but the tab does not read as selected`);
  }
  await drive("toggle-terminal", "terminal-drawer visible", '[data-testid="terminal-drawer"]');

  const seen = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button, [role="tab"], a, input, select, textarea')];
    return nodes.filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getAttribute("data-testid");
    }).map((node) => node.getAttribute("data-testid"));
  });
  const driven = new Set(lines.filter((line) => line.startsWith("click ")).map((line) => line.split(" ")[1]));
  for (const testId of [...new Set(seen)].sort()) {
    if (!driven.has(testId)) record(`skip ${testId} -> needs data, a configured provider or an approval; drive it by testid`);
  }

  if (verified === 0) throw new Error("no control could be driven");
  writeFileSync(OUT, `# controls driven from the running UI by scripts/ui-clickmap.mjs\n${lines.join("\n")}\n`);
  console.log(`OK: clickmap written to .aikit/clickmap.log (${verified} controls verified)`);
  process.exitCode = 0;
} catch (error) {
  console.error("What: the clickmap run failed.");
  console.error(`Why: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Fix: run `npm run build`, then retry; set EDGE_PATH if needed.");
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stopUi(ui);
}
