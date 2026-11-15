#!/usr/bin/env node
// G-004: no serious or critical axe violation on the shell or on any workspace panel, in the dark and the light theme.
import { join } from "node:path";
import { launchBrowser, startUi, stopUi } from "./browser.mjs";
import { ROOT } from "./runtime.mjs";

const THEMES = ["dark", "light"];

async function scan(page, where) {
  const report = await page.evaluate(async () => {
    const result = await globalThis.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({ target: node.target, html: node.html, failure: node.failureSummary })),
    }));
  });
  return report.map((violation) => ({ ...violation, where }));
}

/** WCAG contrast of every visible text node, with translucent backgrounds composited the way the browser paints them. */
async function contrast(page, where) {
  const found = await page.evaluate(() => {
    const parse = (value) => {
      const m = /rgba?\(([^)]+)\)/.exec(value);
      if (m === null) return null;
      const parts = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    const over = (top, bottom) => {
      const a = top.a + bottom.a * (1 - top.a);
      if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
      return { r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a, g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a, b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a, a };
    };
    const lum = (c) => {
      const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const ratio = (a, b) => { const l1 = lum(a); const l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    const page = parse(getComputedStyle(document.body).backgroundColor);
    const root = page !== null && page.a > 0 ? page : { r: 255, g: 255, b: 255, a: 1 };
    // A gradient or image behind text has no single colour to measure, so such text is left to a person's review.
    const painted = (el) => {
      for (let node = el; node !== null && node !== document.body; node = node.parentElement) {
        if (getComputedStyle(node).backgroundImage !== "none") return true;
      }
      return false;
    };
    const backdrop = (el) => {
      const chain = [];
      for (let node = el; node !== null; node = node.parentElement) {
        const c = parse(getComputedStyle(node).backgroundColor);
        if (c !== null && c.a > 0) chain.push(c);
      }
      return chain.reduceRight((below, layer) => over(layer, below), { ...root, a: 1 });
    };
    const out = [];
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      if ((n.nodeValue ?? "").trim().length === 0) continue;
      const el = n.parentElement;
      if (el === null || seen.has(el)) continue;
      seen.add(el);
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
      if (el.closest(":disabled, [aria-disabled='true'], script, style, [hidden]") !== null) continue;
      const fg = parse(style.color);
      if (fg === null || painted(el)) continue;
      const bg = backdrop(el);
      const text = over(fg, bg);
      const size = parseFloat(style.fontSize);
      const bold = Number(style.fontWeight) >= 700;
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      const got = ratio(text, bg);
      if (got < need) out.push({ ratio: Number(got.toFixed(2)), need, text: (n.nodeValue ?? "").trim().slice(0, 40), el: `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ")[0] : ""}`, fg: style.color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})` });
    }
    return out;
  });
  return found.map((entry) => ({ ...entry, where }));
}

let ui;
let browser;
try {
  ui = await startUi();
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const all = [];
  const low = [];
  let scans = 0;
  for (const theme of THEMES) {
    await page.goto(ui.base, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.evaluate((value) => localStorage.setItem("atelier.theme", value), theme);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 10_000 });
    await page.addScriptTag({ path: join(ROOT, "node_modules", "axe-core", "axe.min.js") });
    await page.getByTestId("new-conversation").click();
    await page.waitForSelector('[data-testid="conversation-header"]', { timeout: 10_000 });
    const tabs = (await page.getByTestId("workspace-tabs").getByRole("tab").allInnerTexts()).map((name) => name.trim());
    for (const name of tabs) {
      await page.getByRole("tab", { name, exact: true }).click();
      await page.waitForTimeout(200);
      all.push(...(await scan(page, `${theme} theme, ${name} panel`)));
      low.push(...(await contrast(page, `${theme} theme, ${name} panel`)));
      scans += 1;
    }
  }
  const serious = all.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  for (const violation of serious) {
    console.log(`VIOLATION ${violation.impact} ${violation.id} [${violation.where}]: ${violation.help} (${violation.nodes.length} node(s))`);
    for (const node of violation.nodes.slice(0, 3)) {
      console.log(`  ${node.target.join(" ")} :: ${node.failure}`);
    }
  }
  const worst = new Map();
  for (const entry of low) {
    const key = `${entry.el} "${entry.text}" ${entry.fg} on ${entry.bg}`;
    if (!worst.has(key) || worst.get(key).ratio > entry.ratio) worst.set(key, entry);
  }
  for (const entry of [...worst.values()].sort((a, b) => a.ratio - b.ratio).slice(0, 25)) {
    console.log(`LOW CONTRAST ${entry.ratio}:1 (needs ${entry.need}) [${entry.where}] ${entry.el} "${entry.text}" ${entry.fg} on ${entry.bg}`);
  }
  if (serious.length > 0) throw new Error(`${serious.length} serious/critical accessibility violation(s) across ${scans} scans`);
  if (worst.size > 0) throw new Error(`${worst.size} text colour pair(s) below the WCAG contrast ratio across ${scans} scans`);
  console.log(`PASS a11y: ${scans} scans (${THEMES.join(" and ")} theme, every panel), ${all.length} non-serious violation(s), 0 serious/critical, every visible text colour pair meets WCAG contrast`);
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
