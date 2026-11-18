#!/usr/bin/env node
// G-004: the interface renders and does not scroll sideways in Chromium, Firefox and WebKit at 390, 768 and 1440 px.
import { ENGINES, launchEngine, startUi, stopUi } from "./browser.mjs";

const WIDTHS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];

// Host-speed bounds, not assertions: a full gate run can make a cold engine's first
// navigation far slower than an idle host, so give it room and let the checks below decide.
const NAVIGATE_MS = 45_000;
const SELECTOR_MS = 20_000;

async function checkEngine(engine, base) {
  const browser = await launchEngine(engine);
  try {
    const page = await browser.newPage({ viewport: WIDTHS[2] });
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: NAVIGATE_MS });
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: SELECTOR_MS });
    const rootChildren = await page.evaluate(() => document.querySelector("#root")?.children.length ?? 0);
    if (rootChildren === 0) throw new Error("#root rendered no children");
    await page.getByTestId("new-conversation").click();
    await page.waitForSelector('[data-testid="conversation-list"]', { timeout: SELECTOR_MS });
    for (const size of WIDTHS) {
      await page.setViewportSize(size);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (wide > 1) throw new Error(`horizontal overflow of ${wide}px at ${size.width} px`);
    }
    if (errors.length > 0) throw new Error(`console errors: ${errors.slice(0, 3).join(" | ")}`);
  } finally {
    await browser.close();
  }
}

let ui;
const failures = [];
try {
  ui = await startUi();
  for (const engine of ENGINES) {
    try {
      await checkEngine(engine, ui.base);
      console.log(`PASS browser: ${engine} rendered the shell, reached the API and has no sideways scroll at 390, 768 and 1440 px`);
    } catch (error) {
      failures.push(`${engine}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join(" || "));
  console.log("OK: browser smoke complete");
  process.exitCode = 0;
} catch (error) {
  console.error("What: the browser smoke test failed.");
  console.error(`Why: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Fix: run `npm run build`, install a missing engine with `node node_modules/playwright-core/cli.js install firefox webkit`, set EDGE_PATH if needed, then retry.");
  process.exitCode = 1;
} finally {
  await stopUi(ui);
}
