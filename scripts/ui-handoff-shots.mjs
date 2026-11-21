#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, startUi, stopUi } from "./browser.mjs";
import { ROOT } from "./runtime.mjs";

const out = join(ROOT, "shots", "handoff");
mkdirSync(out, { recursive: true });
const viewports = [
  { width: 1440, height: 900, name: "desktop" },
];
let ui;
let browser;
let failed = false;

// No provider is configured here, so a genuine assistant reply cannot be produced. The real UI is served a
// stubbed message list for one real session, which is exactly what it renders after a plan-mode run finishes.
const MESSAGES = [
  { id: "m1", session_id: "SESSION", seq: 1, role: "user", text: "Plan how to add rate limiting to the API", client_id: null, created: 1 },
  { id: "m2", session_id: "SESSION", seq: 2, role: "assistant", text: "1. Add a token bucket in server/limits.ts\n2. Apply it in app.ts middleware\n3. Cover it with an integration test", client_id: null, created: 2 },
];

try {
  ui = await startUi();
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: viewports[2] });
  await page.goto(ui.base, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10_000 });
  const sessionId = await page.evaluate(async () => {
    const csrf = decodeURIComponent((document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("atelier_csrf=")) ?? "atelier_csrf=").slice("atelier_csrf=".length));
    const created = await (await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json", "x-atelier-csrf": csrf }, body: JSON.stringify({ title: "Handoff demo" }) })).json();
    return created.session.id;
  });
  await page.route(`**/api/sessions/${sessionId}/messages`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages: MESSAGES.map((message) => ({ ...message, session_id: sessionId })) }) }),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="message"]', { timeout: 10_000 });
  await page.screenshot({ path: join(out, "before-desktop.png") });
  const hiddenInBuild = (await page.locator('[data-testid="handoff"]').count()) === 0;
  console.log(`bar hidden in Build mode: ${hiddenInBuild}`);
  if (!hiddenInBuild) failed = true;
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await page.waitForSelector('[data-testid="handoff"]', { timeout: 10_000 });
  for (const view of viewports) {
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.waitForTimeout(700);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    const bar = await page.locator('[data-testid="handoff"]').boundingBox();
    const button = await page.locator('[data-testid="handoff-build"]').boundingBox();
    const composer = await page.locator('[data-testid="composer-input"]').boundingBox();
    const inView = bar !== null && button !== null && bar.x >= 0 && bar.x + bar.width <= view.width + 1 && button.x + button.width <= view.width + 1 && button.y + button.height <= view.height + 1;
    const clearOfInput = bar !== null && composer !== null && bar.y + bar.height <= composer.y + 1;
    console.log(`${view.name}: horizontalScroll=${overflow} barAndButtonInViewport=${inView} barAboveInput=${clearOfInput} button=${button === null ? "none" : `${Math.round(button.width)}x${Math.round(button.height)}`}`);
    if (overflow || !inView || !clearOfInput) failed = true;
    await page.screenshot({ path: join(out, `after-${view.name}.png`) });
  }
} finally {
  if (browser) await browser.close();
  if (ui) await stopUi(ui);
}
process.exit(failed ? 1 : 0);
