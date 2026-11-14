#!/usr/bin/env node
import { join } from "node:path";
import { launchBrowser, startUi, stopUi } from "./browser.mjs";
import { ROOT } from "./runtime.mjs";

let ui;
let browser;
try {
  ui = await startUi();
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(ui.base, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 10_000 });
  await page.addScriptTag({ path: join(ROOT, "node_modules", "axe-core", "axe.min.js") });
  const report = await page.evaluate(async () => {
    const result = await globalThis.axe.run(document, {
      runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
    });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({ target: node.target, html: node.html, failure: node.failureSummary })),
    }));
  });
  const serious = report.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  for (const violation of serious) {
    console.log(`VIOLATION ${violation.impact} ${violation.id}: ${violation.help} (${violation.nodes.length} node(s))`);
    for (const node of violation.nodes) {
      console.log(`  ${node.target.join(" ")} :: ${node.failure}`);
      console.log(`  ${node.html}`);
    }
  }
  if (serious.length > 0) throw new Error(`${serious.length} serious/critical accessibility violation(s)`);
  console.log(`PASS a11y: ${report.length} non-serious violation(s), 0 serious/critical`);
  process.exitCode = 0;
} catch (error) {
  console.error("What: the accessibility check failed.");
  console.error(`Why: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Fix: fix the named violation; do not lower the axe threshold.");
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stopUi(ui);
}
