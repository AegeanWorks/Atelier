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
const out = join(ROOT, "shots", "streaming", label.length === 0 ? "current" : label);
mkdirSync(out, { recursive: true });
const viewports = [
  { width: 1440, height: 900, name: "desktop" },
];

// The real UI, a real session, and synthetic stream events through a stand-in event source:
// no provider is configured here, so a genuine streaming reply cannot be produced.
const FAKE_STREAM = `
(() => {
  window.EventSource = class {
    constructor() {
      this.listeners = {}; this.onopen = null; this.onerror = null;
      setTimeout(() => {
        if (this.onopen) this.onopen();
        const send = (type, data) => (this.listeners[type] || []).forEach((fn) => fn({ data: JSON.stringify(data), lastEventId: "9999" }));
        send("run.started", { runId: "run_demo" });
        const body = [
          "### Reading the workspace\\n",
          "The run is open, so the reply is still arriving.\\n\\n",
          "A fenced block follows:\\n\\n    const answer = 42;\\n",
        ];
        body.forEach((text, i) => setTimeout(() => send("text.delta", { runId: "run_demo", step: 0, text }), 150 * (i + 1)));
      }, 400);
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    close() {}
  };
})();
`;

let ui;
let browser;
let failed = false;
try {
  ui = await startUi();
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: viewports[2] });
  page.on("pageerror", (error) => console.error(`page error: ${error.message}`));
  await page.goto(ui.base, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10_000 });
  await page.evaluate(async () => {
    const csrf = decodeURIComponent((document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("atelier_csrf=")) ?? "atelier_csrf=").slice("atelier_csrf=".length));
    await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json", "x-atelier-csrf": csrf }, body: JSON.stringify({ title: "Streaming demo" }) });
  });
  await page.addInitScript(FAKE_STREAM);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="live-message"]', { timeout: 10_000 });
  await page.waitForTimeout(900);
  for (const view of viewports) {
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.waitForTimeout(300);
    const caret = await page.locator(".stream-caret").count() === 0 ? null : await page.locator(".stream-caret").boundingBox();
    const live = await page.locator('[data-testid="live-message"]').boundingBox();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const caretInside = caret !== null && live !== null && caret.x >= live.x - 1 && caret.x + caret.width <= live.x + live.width + 2;
    console.log(`${view.name}: caretVisible=${caret !== null} caretInsideLive=${caretInside} horizontalScroll=${overflow}`);
    if (label !== "before" && (caret === null || !caretInside)) failed = true;
    if (overflow > 1) failed = true;
    await page.screenshot({ path: join(out, `streaming-${view.name}.png`), fullPage: true });
  }
  console.log(`OK: streaming screenshots complete in shots/streaming/${label.length === 0 ? "current" : label}`);
} catch (error) {
  console.error("What: the streaming screenshot run failed.");
  console.error(`Why: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Fix: run `npm run build`, then retry; set EDGE_PATH if needed.");
  failed = true;
} finally {
  await browser?.close();
  await stopUi(ui);
}
process.exit(failed ? 1 : 0);
