import { existsSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit } from "playwright-core";
import { ROOT, startServer, stopServer } from "./runtime.mjs";

const CANDIDATES = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter((value) => typeof value === "string" && value.length > 0);

export function findBrowser() {
  return CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

/** The engines G-004 requires; Chromium uses the installed Edge or Chrome, the others the Playwright cache. */
export const ENGINES = ["chromium", "firefox", "webkit"];

export async function launchEngine(engine) {
  if (engine === "chromium") return launchBrowser();
  const launcher = engine === "firefox" ? firefox : engine === "webkit" ? webkit : null;
  if (launcher === null) throw new Error(`Unknown browser engine '${engine}'.`);
  try {
    return await launcher.launch({ headless: true });
  } catch (error) {
    const first = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    throw new Error(`${engine} could not start (${first}). Run 'node node_modules/playwright-core/cli.js install ${engine}' once.`);
  }
}

export async function launchBrowser() {
  const executablePath = findBrowser();
  if (executablePath === null) {
    throw new Error("No Edge or Chrome executable found. Set EDGE_PATH to a Chromium-based browser.");
  }
  return chromium.launch({ executablePath, headless: true });
}

export function ensureBuild() {
  if (existsSync(join(ROOT, "dist", "index.html"))) return;
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    timeout: 300_000,
  });
  if (result.status !== 0) throw new Error("The production build failed.");
}

export async function startUi() {
  ensureBuild();
  const home = mkdtempSync(join(tmpdir(), "atelier-browser-"));
  const server = startServer({ home, port: 0 });
  const base = await server.url;
  return { home, server, base };
}

export async function stopUi(context) {
  if (context?.server) await stopServer(context.server.child);
}
