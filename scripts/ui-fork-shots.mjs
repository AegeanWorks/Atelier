#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, startUi, stopUi } from "./browser.mjs";
import { ROOT } from "./runtime.mjs";

const out = join(ROOT, "shots", "fork");
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
  // Seed a conversation through the real API; with no provider the run blocks after storing the user message.
  await page.evaluate(async () => {
    const csrf = decodeURIComponent((document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("atelier_csrf=")) ?? "atelier_csrf=").slice("atelier_csrf=".length));
    const headers = { "content-type": "application/json", "x-atelier-csrf": csrf };
    const created = await (await fetch("/api/sessions", { method: "POST", headers, body: JSON.stringify({ title: "Fork demo" }) })).json();
    await fetch(`/api/sessions/${created.session.id}/runs`, { method: "POST", headers, body: JSON.stringify({ prompt: "Explain this repository" }) });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="fork-message"]', { timeout: 10_000 });
  for (const view of viewports) {
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.waitForTimeout(700);
    await page.locator('[data-testid="message"]').first().hover();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    const box = await page.locator('[data-testid="fork-message"]').first().boundingBox();
    const inView = box !== null && box.x >= 0 && box.x + box.width <= view.width + 1 && box.height >= 18;
    console.log(`${view.name}: horizontalScroll=${overflow} forkButtonVisibleAndTappable=${inView} size=${box === null ? "none" : `${Math.round(box.width)}x${Math.round(box.height)}`}`);
    if (overflow || !inView) failed = true;
    await page.screenshot({ path: join(out, `after-${view.name}.png`) });
  }
  await page.setViewportSize(viewports[0]);
  await page.locator('[data-testid="fork-message"]').first().click();
  await page.waitForFunction(() => document.body.innerText.includes("Fork: Fork demo"), null, { timeout: 10_000 });
  console.log("fork opened a new conversation in the real app");
} finally {
  if (browser) await browser.close();
  if (ui) await stopUi(ui);
}
process.exit(failed ? 1 : 0);
