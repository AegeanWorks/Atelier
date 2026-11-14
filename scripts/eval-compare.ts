import { ensureHome } from "../server/config";
import { openDatabase } from "../server/db";
import { compareToLatest } from "../server/eval/compare";

const args = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const candidate = value("--candidate");
if (candidate === undefined) {
  console.error("Why: --candidate <runId> is required. Fix: pass the run id printed by `npm run eval`.");
  process.exit(2);
}
const db = openDatabase(ensureHome());
try {
  const result = compareToLatest(db, candidate, value("--baseline"));
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`compare ${result.ok ? "PASS" : "FAIL"} baseline=${result.baselineLabel} candidate=${result.candidateRunId}`);
    console.log(`delta=${result.delta.mean.toFixed(3)} ci=[${result.delta.low.toFixed(3)}, ${result.delta.high.toFixed(3)}] mcnemar=${result.mcnemar.toFixed(4)}`);
    console.log(`flips improved=${result.flips.improved.length} lost=${result.flips.lost.length} unchanged=${result.flips.unchanged.length}`);
    for (const failure of result.failures) console.log(`FAIL ${failure.code}: ${failure.message}`);
    for (const warning of result.warnings) console.log(`WARN ${warning.code}: ${warning.message}`);
  }
  process.exitCode = result.ok ? 0 : 1;
} finally {
  db.close();
}
