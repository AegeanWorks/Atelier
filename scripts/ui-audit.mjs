#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, startUi, stopUi } from "./browser.mjs";
import { ROOT } from "./runtime.mjs";

const out = join(ROOT, "shots", "audit");
mkdirSync(out, { recursive: true });
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(ui.base, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 10_000 });

  const report = { generatedAt: new Date().toISOString(), viewports: [] };
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(ui.base, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 10_000 });
    await page.waitForTimeout(300);

    const metrics = await page.evaluate(() => {
      const doc = document.documentElement;
      const pageOverflow = doc.scrollWidth - doc.clientWidth;
      const workspace = document.querySelector('[data-testid="workspace"]');
      const workspaceRect = workspace instanceof HTMLElement ? workspace.getBoundingClientRect() : null;
      const tabs = [...document.querySelectorAll('[data-testid^="tab-"]')].map((node) => {
        const rect = node.getBoundingClientRect();
        const inside = workspaceRect === null
          ? null
          : rect.left >= workspaceRect.left - 0.5 && rect.right <= workspaceRect.right + 0.5;
        return { id: node.getAttribute("data-testid"), width: Math.round(rect.width), height: Math.round(rect.height), inside };
      });
      const visible = (rect) => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      const controls = [...document.querySelectorAll("button, input, select, textarea, [role=option]")]
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter((entry) => visible(entry.rect))
        .map((entry) => ({
          id: entry.node.getAttribute("data-testid") ?? entry.node.getAttribute("aria-label") ?? entry.node.textContent?.trim().slice(0, 24) ?? "",
          width: Math.round(entry.rect.width),
          height: Math.round(entry.rect.height),
        }));
      const undersized = controls.filter((control) => control.width < 24 || control.height < 24);
      const clipped = [...document.querySelectorAll(".conversation-title, .header-sub, .provider-meta, .workspace-tabs button, .field > span")]
        .filter((node) => node.scrollWidth > node.clientWidth + 1)
        .filter((node) => !(node.getAttribute("title") ?? "").trim())
        .map((node) => node.textContent?.trim().slice(0, 40) ?? "");
      return { pageOverflow, tabs, undersized, clipped };
    });
    report.viewports.push({ name: viewport.name, ...metrics });
    const failed = metrics.pageOverflow > 0 || metrics.tabs.some((tab) => tab.inside === false);
    console.log(`${failed ? "FAIL" : "PASS"} ${viewport.name}: overflow ${metrics.pageOverflow}px, ${metrics.tabs.length} tabs, ${metrics.undersized.length} undersized controls, ${metrics.clipped.length} clipped labels`);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(ui.base, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 10_000 });
  await page.getByTestId("new-conversation").click();
  await page.waitForSelector('[data-testid="conversation-list"]', { timeout: 10_000 });

  report.panels = [];
  for (const tab of ["files", "git", "history", "plans", "preview", "task", "usage", "settings", "evals"]) {
    await page.getByTestId(`tab-${tab}`).click();
    await page.waitForSelector(`[data-testid="tab-${tab}"][aria-selected="true"]`, { timeout: 5_000 });
    await page.waitForTimeout(350);
    const metrics = await page.evaluate(() => {
      const doc = document.documentElement;
      const visible = (rect) => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      const panel = document.querySelector('[data-testid="workspace-panel"]');
      const scope = panel instanceof HTMLElement ? panel : document.body;
      const controls = [...scope.querySelectorAll("button, input, select, textarea, [role=option]")]
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter((entry) => visible(entry.rect))
        .map((entry) => ({
          id: entry.node.getAttribute("data-testid") ?? entry.node.getAttribute("aria-label") ?? entry.node.textContent?.trim().slice(0, 24) ?? "",
          width: Math.round(entry.rect.width),
          height: Math.round(entry.rect.height),
        }));
      const clipped = [...scope.querySelectorAll(".provider-meta, .workspace-tabs button, .field > span, .conversation-title")]
        .filter((node) => node.scrollWidth > node.clientWidth + 1)
        .filter((node) => !(node.getAttribute("title") ?? "").trim())
        .map((node) => node.textContent?.trim().slice(0, 40) ?? "");
      return {
        pageOverflow: doc.scrollWidth - doc.clientWidth,
        undersized: controls.filter((control) => control.width < 24 || control.height < 24),
        clipped,
      };
    });
    report.panels.push({ id: tab, ...metrics });
    console.log(`${metrics.pageOverflow > 0 ? "FAIL" : "INFO"} panel ${tab}: overflow ${metrics.pageOverflow}px, ${metrics.undersized.length} undersized, ${metrics.clipped.length} clipped`);
  }

  const path = join(out, "report.json");
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`report ${path}`);
  const failed = report.viewports.some((entry) => entry.pageOverflow > 0 || entry.tabs.some((tab) => tab.inside === false));
  console.log(failed ? "FAIL: measured layout problem" : "OK: no page overflow and every tab stays inside the workspace");
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  console.error("What: the UI audit failed.");
  console.error(`Why: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Fix: run `npm run build`, then retry; set EDGE_PATH if needed.");
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stopUi(ui);
}
