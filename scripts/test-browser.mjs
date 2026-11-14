#!/usr/bin/env node
import { launchBrowser, startUi, stopUi } from "./browser.mjs";

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
  const rootChildren = await page.evaluate(() => document.querySelector("#root")?.children.length ?? 0);
  if (rootChildren === 0) throw new Error("#root rendered no children");
  if (errors.length > 0) throw new Error(`console errors: ${errors.slice(0, 3).join(" | ")}`);

  await page.getByTestId("new-conversation").click();
  await page.waitForSelector('[data-testid="conversation-list"]', { timeout: 10_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  const narrowOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (narrowOverflow) throw new Error("horizontal overflow at 390 px");

  console.log("PASS browser: app shell rendered in Chromium");
  console.log("PASS browser: new conversation reached the durable API");
  console.log("PASS browser: 390 px has no horizontal overflow");
  console.log("OK: browser smoke complete");
  process.exitCode = 0;
} catch (error) {
  console.error("What: the browser smoke test failed.");
  console.error(`Why: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Fix: run `npm run test:browser` after `npm install`; set EDGE_PATH if needed.");
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stopUi(ui);
}
