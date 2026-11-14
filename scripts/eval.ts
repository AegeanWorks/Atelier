import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHome } from "../server/config";
import { openDatabase, recoverOnBoot } from "../server/db";
import { runEval } from "../server/eval/runner";
import { saveBaseline } from "../server/eval/store";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const json = args.includes("--json");
const suiteArg = value("--suite") ?? "atelier-core";
const suiteDir = existsSync(join(ROOT, "evals", "suites", suiteArg)) ? join(ROOT, "evals", "suites", suiteArg) : join(ROOT, suiteArg);
const split = (value("--split") ?? "dev") as "dev" | "test";
if (split === "test" && !args.includes("--release")) {
  console.error("Why: the test split is frozen for release evidence. Fix: pass --release.");
  process.exit(2);
}
const repeat = Number(value("--repeat") ?? "1");
if (!Number.isInteger(repeat) || repeat < 1) {
  console.error("Why: --repeat must be a positive integer. Fix: pass --repeat 3.");
  process.exit(2);
}
const profile = value("--profile") ?? "full-v1";
const baselineIndex = args.indexOf("--baseline");
const baselineLabel = baselineIndex >= 0
  ? (args[baselineIndex + 1] !== undefined && !args[baselineIndex + 1]?.startsWith("--")
      ? args[baselineIndex + 1]
      : `baseline-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`)
  : undefined;
const home = ensureHome();
const db = openDatabase(home);
try {
  recoverOnBoot(db);
  const run = await runEval(db, {
    suiteDir,
    split,
    profile,
    repeat,
    model: value("--model") ?? "fixture-model",
    provider: value("--provider") ?? "fixture",
    resultsRoot: join(ROOT, "evals", "results"),
  });
  if (baselineLabel !== undefined) saveBaseline(db, baselineLabel, run);
  if (json) console.log(JSON.stringify({ ...run, baseline: baselineLabel ?? null }, null, 2));
  else {
    console.log(`eval ${run.ok ? "PASS" : "FAIL"} ${run.suite}/${run.split} profile=${run.profile.id} harness=${run.harnessVersion.slice(0, 12)}`);
    console.log(`mean=${run.metrics.mean.toFixed(3)} r0.8=${run.metrics.r08.toFixed(3)} r1=${run.metrics.r1.toFixed(3)} pass@k=${run.metrics.passAtK.toFixed(3)} rr=${run.metrics.rr.toFixed(3)} csr=${run.metrics.csr.toFixed(3)} es=${run.metrics.es.toFixed(3)} integrity=${run.integrity}`);
    for (const result of run.results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.taskId}#${result.repeat} steps=${result.metrics.steps} [${result.findings.map((finding) => finding.code).join(",") || "clean"}]`);
    console.log(`run ${run.runId}${baselineLabel === undefined ? "" : ` · baseline ${baselineLabel}`}`);
  }
  process.exitCode = run.ok ? 0 : 1;
} finally {
  db.close();
}
