#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, startUi, stopUi } from "./browser.mjs";
import { ROOT } from "./runtime.mjs";

const out = join(ROOT, "shots", "approval");
mkdirSync(out, { recursive: true });
const viewports = [
  { width: 1440, height: 900, name: "desktop" },
];
let ui;
let browser;
let failed = false;

// The real UI, a real session, and a synthetic approval.request delivered through a stand-in event stream:
// no provider is configured here, so a genuine tool approval cannot be produced.
const FAKE_STREAM = `
(() => {
  const Real = window.EventSource;
  window.EventSource = class {
    constructor(url) {
      this.url = url; this.listeners = {}; this.onopen = null; this.onerror = null;
      setTimeout(() => {
        if (this.onopen) this.onopen();
        const send = (type, data) => (this.listeners[type] || []).forEach((fn) => fn({ data: JSON.stringify(data), lastEventId: "9999" }));
        send("approval.request", { approvalId: "ap_demo", runId: "run_demo", callId: "c1", tool: "bash", action: "exec", resource: "npm test -- --reporter=dot", reason: "bash requires approval in build mode" });
      }, 400);
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    close() {}
  };
  window.__RealEventSource = Real;
})();
`;

function overlaps(a, b) {
  return a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
}

try {
  ui = await startUi();
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: viewports[2] });
  await page.goto(ui.base, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10_000 });
  await page.evaluate(async () => {
    const csrf = decodeURIComponent((document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("atelier_csrf=")) ?? "atelier_csrf=").slice("atelier_csrf=".length));
    await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json", "x-atelier-csrf": csrf }, body: JSON.stringify({ title: "Approval demo" }) });
  });
  await page.addInitScript(FAKE_STREAM);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="approval-dock"]', { timeout: 10_000 });
  for (const view of viewports) {
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.waitForTimeout(700);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    const names = ["approval-approve", "approval-always", "approval-deny"];
    const boxes = [];
    for (const name of names) boxes.push(await page.locator(`[data-testid="${name}"]`).boundingBox());
    const inView = boxes.every((box) => box !== null && box.x >= 0 && box.x + box.width <= view.width + 1 && box.y >= 0 && box.y + box.height <= view.height + 1);
    const apart = boxes.every((a, i) => boxes.every((b, j) => i === j || a === null || b === null || !overlaps(a, b)));
    const sizes = boxes.map((box) => (box === null ? "none" : `${Math.round(box.width)}x${Math.round(box.height)}`)).join(" ");
    console.log(`${view.name}: horizontalScroll=${overflow} buttonsInViewport=${inView} noOverlap=${apart} sizes=${sizes}`);
    if (overflow || !inView || !apart) failed = true;
    await page.screenshot({ path: join(out, `after-${view.name}.png`) });
  }
} finally {
  if (browser) await browser.close();
  if (ui) await stopUi(ui);
}
process.exit(failed ? 1 : 0);
