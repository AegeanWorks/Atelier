import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
export const VITE = join(ROOT, "node_modules", "vite", "bin", "vite.js");
export const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");

export function atelierHome() {
  return process.env.ATELIER_HOME?.trim() || join(homedir(), ".atelier");
}

export function tokenPath(home = atelierHome()) {
  return join(home, "runtime", "token");
}

export function readToken(home = atelierHome()) {
  const path = tokenPath(home);
  if (!existsSync(path)) throw new Error(`Why: no runtime token at ${path}. Fix: start atelier first.`);
  const token = readFileSync(path, "utf8").trim();
  if (token.length < 32) throw new Error(`Why: the runtime token at ${path} is invalid. Fix: stop atelier, remove the file, and restart.`);
  return token;
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(check, { timeoutMs = 10_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(intervalMs);
  }
  throw last ?? new Error(`Timed out after ${timeoutMs} ms`);
}

export function startServer({ home = atelierHome(), port = 0, env = {}, open = false } = {}) {
  const args = [TSX, "server/main.ts", "--port", String(port)];
  if (!open) args.push("--no-open");
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ATELIER_HOME: home, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  let resolveUrl;
  let rejectUrl;
  const url = new Promise((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  const onData = (chunk) => {
    buffer += chunk.toString();
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(buffer);
    if (match && resolveUrl) {
      resolveUrl(`http://127.0.0.1:${match[1]}`);
      resolveUrl = undefined;
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("exit", (code) => {
    if (resolveUrl) {
      rejectUrl(new Error(`Why: atelier exited with code ${code}. Fix: read the output below.\n${buffer.slice(-1200)}`));
      resolveUrl = undefined;
    }
  });
  return { child, url, output: () => buffer };
}

export async function stopServer(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(4000),
  ]);
}

export async function fetchJson(base, token, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(new URL(path, base), { ...init, headers });
  const text = await response.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

export function fileAgeMs(path) {
  return Date.now() - statSync(path).mtimeMs;
}
