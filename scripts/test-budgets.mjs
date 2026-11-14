#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, VITEST } from "./runtime.mjs";

const tiers = [
  { name: "unit", dir: "tests/unit", budgetMs: 20 },
  { name: "integration", dir: "tests/integration", budgetMs: 1000 },
];

let failed = false;
for (const tier of tiers) {
  const output = join(tmpdir(), `atelier-${tier.name}-${process.pid}.json`);
  const result = spawnSync(process.execPath, [VITEST, "run", tier.dir, "--reporter=json", "--outputFile", output], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180_000,
  });
  if (!existsSync(output)) {
    console.log(`FAIL ${tier.name}: no JSON report (exit ${result.status})`);
    console.log((result.stderr ?? "").split(/\r?\n/).slice(-6).join("\n"));
    failed = true;
    continue;
  }
  const report = JSON.parse(readFileSync(output, "utf8"));
  rmSync(output, { force: true });
  const assertions = (report.testResults ?? []).flatMap((file) => file.assertionResults ?? []);
  const durations = assertions.map((test) => Number(test.duration)).filter((value) => Number.isFinite(value));
  const average = durations.length > 0 ? durations.reduce((total, value) => total + value, 0) / durations.length : 0;
  const failedTests = Number(report.numFailedTests ?? 0);
  const over = average > tier.budgetMs;
  if (failedTests > 0 || over) failed = true;
  console.log(
    `${failedTests > 0 || over ? "FAIL" : "PASS"} ${tier.name}: ${assertions.length} test(s), avg ${average.toFixed(1)} ms, budget ${tier.budgetMs} ms`,
  );
}
process.exit(failed ? 1 : 0);
