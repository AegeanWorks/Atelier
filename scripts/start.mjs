#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./runtime.mjs";

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`What: atelier needs Node.js 22.12 or newer; this is ${process.versions.node}.`);
  console.error("Why: the declared runtime engine and the bundled build require it.");
  console.error("Fix: install Node.js 22.12 or newer from https://nodejs.org and start again.");
  process.exit(1);
}

const BUILDS = ["dist-server/server/main.js", "dist/index.html"];
const SOURCES = ["server", "src", "index.html", "vite.config.ts", "tsconfig.json", "tsconfig.server.json", "package.json"];

function newestMtime(path) {
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.mtimeMs;
  let newest = stats.mtimeMs;
  for (const entry of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, entry)));
  return newest;
}

function buildIsStale() {
  try {
    const outputs = BUILDS.map((path) => join(ROOT, path));
    if (!outputs.every((path) => existsSync(path))) return true;
    const builtAt = Math.min(...outputs.map((path) => statSync(path).mtimeMs));
    return SOURCES.some((path) => newestMtime(join(ROOT, path)) > builtAt);
  } catch {
    return true;
  }
}

function npm(args) {
  return spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    timeout: 300_000,
  });
}

if (!existsSync(`${ROOT}/node_modules/vite/bin/vite.js`)) {
  console.log("atelier: installing dependencies…");
  const installed = npm(["install"]);
  if (installed.error || installed.status !== 0) {
    console.error("What: the dependencies could not be installed.");
    console.error(`Why: npm install failed (${installed.error?.message ?? installed.status}).`);
    console.error("Fix: run `npm install` in this folder and read the first error.");
    process.exit(1);
  }
}

if (buildIsStale()) {
  console.log("atelier: building the server and UI…");
  const built = npm(["run", "build"]);
  if (built.error || built.status !== 0) {
    console.error("What: the production build failed.");
    console.error(`Why: the build exited with ${built.error?.message ?? built.status}.`);
    console.error("Fix: run `npm run build` and read the first error.");
    process.exit(1);
  }
}

const child = spawn(process.execPath, [`${ROOT}/dist-server/server/main.js`, ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error("What: atelier could not start.");
  console.error(`Why: ${error.message}`);
  console.error("Fix: run `npm run doctor` and check the state directory.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});

const stop = () => {
  if (child.exitCode === null) child.kill("SIGINT");
  setTimeout(() => process.exit(0), 1200).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

