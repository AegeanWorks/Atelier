#!/usr/bin/env node
// Measures the geometry the UI change moved, so the checkpoint carries numbers rather than prose.
import { launchBrowser, startUi, stopUi } from "./browser.mjs";

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
  const page = await browser.newPage({ viewport: viewports[2] });
  await page.addInitScript(`
    (() => {
      window.EventSource = class {
        constructor() { this.listeners = {}; this.onopen = null; this.onerror = null;
          setTimeout(() => {
            if (this.onopen) this.onopen();
            const send = (type, data) => (this.listeners[type] || []).forEach((fn) => fn({ data: JSON.stringify(data), lastEventId: "9999" }));
            send("run.started", { runId: "run_demo" });
            send("text.delta", { runId: "run_demo", step: 0, text: "A reply that is still arriving." });
          }, 300);
        }
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
        close() {}
      };
    })();
  `);
  await page.goto(ui.base, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10_000 });
  await page.evaluate(async () => {
    const csrf = decodeURIComponent((document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("atelier_csrf=")) ?? "atelier_csrf=").slice("atelier_csrf=".length));
    await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json", "x-atelier-csrf": csrf }, body: JSON.stringify({ title: "Metrics" }) });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="live-message"]', { timeout: 10_000 });
  await page.waitForTimeout(800);

  for (const view of viewports) {
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.waitForTimeout(250);
    const rail = await page.locator('[data-testid="rail"]').boundingBox();
    const head = await page.locator(".rail-head").count() === 0 ? null : await page.locator(".rail-head").boundingBox();
    const add = await page.locator('[data-testid="new-conversation"]').boundingBox();
    const list = await page.locator('[data-testid="conversation-list"]').boundingBox();
    const caret = await page.locator(".stream-caret").count() === 0 ? null : await page.locator(".stream-caret").boundingBox();
    const live = await page.locator('[data-testid="live-message"]').boundingBox();
    const stripe = await page.evaluate(() => {
      const bubble = document.querySelector('[data-testid="live-message"] .message-bubble');
      return bubble === null ? null : getComputedStyle(bubble).borderLeftWidth;
    });
    const hint = await page.evaluate(() => {
      const el = document.querySelector(".composer-actions .hint");
      if (el === null) return null;
      return { scroll: el.scrollWidth, client: el.clientWidth };
    });
    // Rows between the brand row and the conversation list: what the rail spends as chrome.
    const brand = await page.locator(".brand-row").boundingBox();
    const chromeRows = brand === null || list === null ? null : Math.round((list.y - (brand.y + brand.height)) / 4);
    // Space the rail spends above the conversation list is the number the ghost + button reclaims.
    const overhead = list === null || rail === null ? null : Math.round(list.y - rail.y);
    console.log(
      `${view.name}: railHeadHeight=${head === null ? "none" : Math.round(head.height)}` +
        ` addButton=${add === null ? "none" : `${Math.round(add.width)}x${Math.round(add.height)}`}` +
        ` overheadAboveList=${overhead}px` +
        ` liveBorderLeft=${stripe}` +
        ` caret=${caret === null ? "none" : "present"}` +
        ` caretInsideLive=${caret !== null && live !== null && caret.x >= live.x - 1 && caret.x + caret.width <= live.x + live.width + 2}` +
        ` hintClipped=${hint === null ? "n/a" : hint.scroll > hint.client + 1}` +
        ` railChromeFraction=${brand === null || list === null ? "n/a" : ((list.y - (brand.y + brand.height)) / view.height).toFixed(3)}` +
        ` chromeRowsApprox=${chromeRows}`,
    );
  }
} finally {
  if (browser) await browser.close();
  if (ui) await stopUi(ui);
}
