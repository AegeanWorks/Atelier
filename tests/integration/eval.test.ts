import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditRun } from "../../server/audit";
import { ensureHome } from "../../server/config";
import { openDatabase, recoverOnBoot } from "../../server/db";
import { loadSuite, runEvalTask } from "../../server/eval";
import { listRuns } from "../../server/runs";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("eval lab", () => {
  it("runs the suite, reports metrics and passes audit", async () => {
    const paths = ensureHome(tempDir("atelier-eval-home-"));
    const db = openDatabase(paths);
    try {
      recoverOnBoot(db);
      const tasks = loadSuite(join(process.cwd(), "evals", "atelier-core", "tasks.json"));
      const results = [];
      for (const task of tasks) {
        const workspace = tempDir(`atelier-eval-${task.id}-`);
        results.push({ task, workspace, result: await runEvalTask(db, workspace, task) });
      }
      expect(results.every((entry) => entry.result.ok)).toBe(true);
      const denied = results.find((entry) => entry.task.id === "plan-denied");
      expect(denied?.workspace).toBeDefined();
      expect(existsSync(join(denied?.workspace ?? "", "should-not-exist.txt"))).toBe(false);
      const runs = listRuns(db);
      expect(runs.length).toBeGreaterThanOrEqual(tasks.length);
      for (const run of runs) {
        const audit = auditRun(db, run.id);
        expect(audit.findings.filter((finding) => finding.level === "L1")).toHaveLength(0);
      }
    } finally {
      db.close();
    }
  });
});
