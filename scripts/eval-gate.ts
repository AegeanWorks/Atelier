import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHome } from "../server/config";
import { openDatabase, recoverOnBoot } from "../server/db";
import { compareToLatest } from "../server/eval/compare";
import { runEval } from "../server/eval/runner";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const suiteArg = value("--suite") ?? "atelier-core";
const suiteDir = existsSync(join(ROOT, "evals", "suites", suiteArg)) ? join(ROOT, "evals", "suites", suiteArg) : join(ROOT, suiteArg);
const split = value("--split") ?? "dev";
if (split === "test") {
  console.error("Why: the gate never runs the test split. Fix: use --split dev.");
  process.exit(2);
}
const repeat = Number(value("--repeat") ?? "1");
const profile = value("--profile") ?? "full-v1";
const db = openDatabase(ensureHome());
try {
  recoverOnBoot(db);
  const run = await runEval(db, { suiteDir, split: "dev", profile, repeat, resultsRoot: join(ROOT, "evals", "results") });
  const comparison = compareToLatest(db, run.runId, value("--baseline"));
  console.log(`gate ${comparison.ok ? "PASS" : "FAIL"} run=${run.runId} baseline=${comparison.baselineLabel}`);
  console.log(`candidate mean=${run.metrics.mean.toFixed(3)} delta=${comparison.delta.mean.toFixed(3)} ci=[${comparison.delta.low.toFixed(3)}, ${comparison.delta.high.toFixed(3)}]`);
  for (const failure of comparison.failures) console.log(`FAIL ${failure.code}: ${failure.message}`);
  for (const warning of comparison.warnings) console.log(`WARN ${warning.code}: ${warning.message}`);
  process.exitCode = comparison.ok ? 0 : 1;
} finally {
  db.close();
}
