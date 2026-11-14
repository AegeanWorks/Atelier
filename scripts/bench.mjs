#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { ROOT, TSX } from "./runtime.mjs";

const built = `${ROOT}/dist-server/server/main.js`;
const entry = existsSync(built) ? built : `${ROOT}/server/main.ts`;
const args = existsSync(built) ? [entry, "--help"] : [TSX, entry, "--help"];
const started = performance.now();
const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 10_000 });
const elapsed = Math.round(performance.now() - started);
const payload = {
  schema: 1,
  helpMs: elapsed,
  exit: result.status,
  built: existsSync(built),
  budgetMs: 1000,
  ok: result.status === 0 && elapsed < 1000,
};
console.log(JSON.stringify(payload, null, 2));
process.exit(payload.ok ? 0 : 1);
