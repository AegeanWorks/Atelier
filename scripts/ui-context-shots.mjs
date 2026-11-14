#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, startUi, stopUi } from "./browser.mjs";
import { ROOT } from "./runtime.mjs";

const out = join(ROOT, "shots", "context");
mkdirSync(out, { recursive: true });
const viewports = [
  { width: 390, height: 844, name: "narrow" },
  { width: 768, height: 1024, name: "tablet" },
  { width: 1440, height: 900, name: "desktop" },
];
// Layout evidence only: no provider is configured, so usage for a real session is served from a stub.
const LEVELS = [
  { name: "ok", used: 42_000, expectClass: "status-ok", expectText: "ctx 33%" },
  { name: "warn", used: 96_000, expectClass: "status-warn", expectText: "ctx 75%" },
  { name: "high", used: 120_000, expectClass: "status-bad", expectText: "ctx 94%" },
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
  const sessionId = await page.evaluate(async () => {
    const csrf = decodeURIComponent((document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("atelier_csrf=")) ?? "atelier_csrf=").slice("atelier_csrf=".length));
    const created = await (await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json", "x-atelier-csrf": csrf }, body: JSON.stringify({ title: "Context demo" }) })).json();
    return created.session.id;
  });
  await page.screenshot({ path: join(out, "before-desktop.png") });
  let level = LEVELS[0];
  await page.route(`**/api/usage?session=${sessionId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessionId, requests: 3, replays: 0, promptTokens: 200_000, completionTokens: 4000, cachedTokens: 0, costUsd: 0.42, unpricedRequests: 0, invalidEvents: 0, byModel: [], last: null, context: { providerId: "demo", model: "demo-128k", usedTokens: level.used, windowTokens: 128_000 } }),
    }),
  );
  for (const current of LEVELS) {
    level = current;
    await page.setViewportSize(viewports[2]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="context-meter"]', { timeout: 10_000 });
    for (const view of viewports) {
      await page.setViewportSize({ width: view.width, height: view.height });
      await page.waitForTimeout(500);
      const meter = page.locator('[data-testid="context-meter"]');
      const text = (await meter.textContent()) ?? "";
      const klass = (await meter.getAttribute("class")) ?? "";
      const box = await meter.boundingBox();
      const status = await page.locator('[data-testid="statusbar"]').boundingBox();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      const visible = box !== null && status !== null && box.x >= 0 && box.x + box.width <= view.width + 1 && box.y >= status.y - 1 && box.y + box.height <= status.y + status.height + 1;
      const right = text === current.expectText && klass.includes(current.expectClass);
      console.log(`${current.name}/${view.name}: text="${text}" class=${klass} inStatusBar=${visible} horizontalScroll=${overflow}`);
      if (!right || !visible || overflow) failed = true;
      await page.screenshot({ path: join(out, `after-${current.name}-${view.name}.png`) });
    }
  }
} finally {
  if (browser) await browser.close();
  if (ui) await stopUi(ui);
}
process.exit(failed ? 1 : 0);
