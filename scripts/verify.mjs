#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, atelierHome } from "./runtime.mjs";

const json = process.argv.includes("--json");
const checks = [
  { name: "typecheck", script: "typecheck" },
  { name: "test", script: "test" },
  { name: "lint", script: "lint" },
  { name: "build", script: "build" },
  { name: "agent-perf", script: "test:agent-perf" },
  { name: "agent-bench", script: "test:agent-bench" },
];

const results = [];
for (const check of checks) {
  const started = performance.now();
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", check.script], {
    cwd: ROOT,
    shell: process.platform === "win32",
    encoding: "utf8",
    timeout: 300_000,
  });
  const durationMs = Math.round(performance.now() - started);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const dir = join(atelierHome(), "verify");
  mkdirSync(dir, { recursive: true });
  const artifact = join(dir, `${check.name}.log`);
  writeFileSync(artifact, `${output}\n`, "utf8");
  results.push({
    name: check.name,
    status: result.status === 0 ? "pass" : "fail",
    durationMs,
    summary: result.status === 0 ? "ok" : output.split(/\r?\n/).filter(Boolean).slice(-3).join(" | "),
    artifact,
  });
}

const payload = {
  schema: 1,
  ok: results.every((result) => result.status === "pass"),
  checks: results,
  artifacts: results.map((result) => result.artifact),
  durationMs: results.reduce((total, result) => total + result.durationMs, 0),
};

const target = join(atelierHome(), "verify", "last.json");
mkdirSync(join(atelierHome(), "verify"), { recursive: true });
writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

if (json) console.log(JSON.stringify(payload, null, 2));
else {
  for (const result of results) console.log(`${result.status === "pass" ? "PASS" : "FAIL"} ${result.name} (${result.durationMs} ms)`);
  console.log(`verify ${payload.ok ? "PASS" : "FAIL"} — ${target}`);
}
process.exit(payload.ok ? 0 : 1);
