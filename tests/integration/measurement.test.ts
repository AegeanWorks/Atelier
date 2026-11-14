import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHome } from "../../server/config";
import { openDatabase, recoverOnBoot } from "../../server/db";
import { compareRuns } from "../../server/eval/compare";
import { runEval } from "../../server/eval/runner";
import { saveBaseline } from "../../server/eval/store";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold a DB handle after a failed test; the OS cleans temp.
    }
  }
});

describe("measurement ground", () => {
  it("runs the dev suite, persists results, and compares a regression", async () => {
    const paths = ensureHome(tempDir("atelier-measure-home-"));
    const db = openDatabase(paths);
    try {
      recoverOnBoot(db);
      const suiteDir = join(process.cwd(), "evals", "suites", "atelier-core");
      const resultsRoot = tempDir("atelier-measure-results-");
      const baselineRun = await runEval(db, { suiteDir, split: "dev", profile: "full-v1", repeat: 1, resultsRoot });
      expect(baselineRun.ok).toBe(true);
      expect(baselineRun.metrics.mean).toBe(1);
      expect(baselineRun.integrity).toBe("clean");
      expect(baselineRun.results).toHaveLength(10);
      const baseline = saveBaseline(db, "baseline-test", baselineRun);

      const same = await runEval(db, { suiteDir, split: "dev", profile: "full-v1", repeat: 1, resultsRoot });
      const sameCompare = compareRuns(db, baseline, same.runId);
      expect(sameCompare.ok).toBe(true);
      expect(sameCompare.delta.mean).toBe(0);

      const regressed = await runEval(db, { suiteDir, split: "dev", profile: "minimal-v1", repeat: 1, resultsRoot });
      const badCompare = compareRuns(db, baseline, regressed.runId);
      expect(badCompare.ok).toBe(false);
      expect(badCompare.flips.lost.length).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
  }, 60_000);

  it("marks protected test edits as an integrity failure", async () => {
    const paths = ensureHome(tempDir("atelier-measure-home-"));
    const db = openDatabase(paths);
    try {
      recoverOnBoot(db);
      const suiteDir = join(process.cwd(), "evals", "suites", "atelier-integrity");
      const run = await runEval(db, { suiteDir, split: "test", profile: "full-v1", repeat: 1, resultsRoot: tempDir("atelier-measure-results-") });
      const protectedTask = run.results.find((result) => result.taskId === "protected-test");
      expect(protectedTask?.ok).toBe(false);
      expect(protectedTask?.integrity).toBe("violated");
      expect(run.integrity).toBe("violated");
    } finally {
      db.close();
    }
  }, 30_000);
});
