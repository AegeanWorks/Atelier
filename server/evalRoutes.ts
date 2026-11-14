import { Hono } from "hono";
import { AtelierError } from "./config.js";
import type { DbHandle } from "./db.js";
import { compareToLatest } from "./eval/compare.js";
import { getEvalResults, getEvalRun, listBaselines, listEvalRuns } from "./eval/store.js";

export interface EvalRouteDeps {
  db: DbHandle;
}

function parsedRun(row: ReturnType<typeof listEvalRuns>[number]) {
  return {
    id: row.id,
    suite: row.suite,
    suiteHash: row.suite_hash,
    harnessVersion: row.harness_version,
    model: row.model,
    provider: row.provider,
    split: row.split,
    repeat: row.repeat,
    profile: JSON.parse(row.profile_json) as unknown,
    status: row.status,
    metrics: JSON.parse(row.metrics_json) as unknown,
    environment: JSON.parse(row.environment_json) as unknown,
    created: row.created,
    finished: row.finished,
  };
}

export function createEvalRoutes(deps: EvalRouteDeps): Hono {
  const app = new Hono();

  app.get("/evals/runs", (c) => c.json({ runs: listEvalRuns(deps.db).map(parsedRun) }));

  app.get("/evals/baselines", (c) => c.json({
    baselines: listBaselines(deps.db).map((baseline) => ({
      id: baseline.id,
      label: baseline.label,
      suite: baseline.suite,
      split: baseline.split,
      harnessVersion: baseline.harness_version,
      model: baseline.model,
      provider: baseline.provider,
      metrics: JSON.parse(baseline.metrics_json) as unknown,
      runId: baseline.run_id,
      created: baseline.created,
    })),
  }));


  app.get("/evals/runs/:id", (c) => {
    const row = getEvalRun(deps.db, c.req.param("id"));
    if (row === null) throw new AtelierError("EVAL_RUN_MISSING", "Eval run not found.", c.req.param("id"), "Refresh the Evals tab.");
    return c.json({
      run: parsedRun(row),
      results: getEvalResults(deps.db, row.id).map((result) => ({
        taskId: result.task_id,
        repeat: result.repeat,
        ok: result.ok === 1,
        metrics: JSON.parse(result.metrics_json) as unknown,
        findings: JSON.parse(result.findings_json) as unknown,
      })),
    });
  });

  app.get("/evals/compare", (c) => {
    const candidate = c.req.query("candidate");
    if (candidate === undefined) throw new AtelierError("EVAL_COMPARE", "Missing candidate.", "The query has no candidate run id.", "Pass ?candidate=<runId>.");
    return c.json(compareToLatest(deps.db, candidate, c.req.query("baseline")));
  });

  return app;
}
