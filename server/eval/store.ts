import { randomUUID } from "node:crypto";
import type { DbHandle } from "../db.js";
import type { EvalRunResult, TaskResult } from "./types.js";

export interface EvalRunRow {
  id: string;
  suite: string;
  suite_hash: string;
  harness_version: string;
  model: string;
  provider: string;
  split: string;
  repeat: number;
  profile_json: string;
  status: string;
  metrics_json: string;
  environment_json: string;
  created: number;
  finished: number | null;
}

export interface EvalBaselineRow {
  id: string;
  label: string;
  suite: string;
  suite_hash: string;
  harness_version: string;
  model: string;
  provider: string;
  split: string;
  metrics_json: string;
  run_id: string;
  created: number;
}

export function saveEvalRun(handle: DbHandle, result: EvalRunResult, environment: unknown): void {
  handle.db
    .prepare("INSERT OR REPLACE INTO eval_runs (id, suite, suite_hash, harness_version, model, provider, split, repeat, profile_json, status, metrics_json, environment_json, created, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      result.runId,
      result.suite,
      result.suiteHash,
      result.harnessVersion,
      result.model,
      result.provider,
      result.split,
      result.repeat,
      JSON.stringify(result.profile),
      result.ok ? "finished" : "failed",
      JSON.stringify({ ...result.metrics, integrity: result.integrity }),
      JSON.stringify(environment),
      result.createdAt,
      result.finishedAt,
    );
}

export function saveEvalResult(handle: DbHandle, runId: string, result: TaskResult): void {
  handle.db
    .prepare("INSERT INTO eval_results (id, run_id, task_id, split, repeat, ok, metrics_json, findings_json, trace_ref, diff_ref, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), runId, result.taskId, result.split, result.repeat, result.ok ? 1 : 0, JSON.stringify({ ...result.metrics, integrity: result.integrity }), JSON.stringify(result.findings), result.traceRef, result.diffRef, Date.now());
}

export function getEvalRun(handle: DbHandle, id: string): EvalRunRow | null {
  const row = handle.db.prepare("SELECT * FROM eval_runs WHERE id = ?").get(id) as EvalRunRow | undefined;
  return row ?? null;
}

export function listEvalRuns(handle: DbHandle, limit = 50): EvalRunRow[] {
  return handle.db.prepare("SELECT * FROM eval_runs ORDER BY created DESC LIMIT ?").all(limit) as EvalRunRow[];
}

export function getEvalResults(handle: DbHandle, runId: string): Array<{ task_id: string; repeat: number; ok: number; metrics_json: string; findings_json: string }> {
  return handle.db.prepare("SELECT task_id, repeat, ok, metrics_json, findings_json FROM eval_results WHERE run_id = ? ORDER BY task_id, repeat").all(runId) as Array<{ task_id: string; repeat: number; ok: number; metrics_json: string; findings_json: string }>;
}

export function saveBaseline(handle: DbHandle, label: string, result: EvalRunResult): EvalBaselineRow {
  const row: EvalBaselineRow = {
    id: `base_${randomUUID()}`,
    label,
    suite: result.suite,
    suite_hash: result.suiteHash,
    harness_version: result.harnessVersion,
    model: result.model,
    provider: result.provider,
    split: result.split,
    metrics_json: JSON.stringify({ ...result.metrics, integrity: result.integrity }),
    run_id: result.runId,
    created: Date.now(),
  };
  handle.db
    .prepare("INSERT INTO eval_baselines (id, label, suite, suite_hash, harness_version, model, provider, split, metrics_json, run_id, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.label, row.suite, row.suite_hash, row.harness_version, row.model, row.provider, row.split, row.metrics_json, row.run_id, row.created);
  return row;
}

export function getBaseline(handle: DbHandle, label: string): EvalBaselineRow | null {
  const row = handle.db.prepare("SELECT * FROM eval_baselines WHERE label = ?").get(label) as EvalBaselineRow | undefined;
  return row ?? null;
}

export function listBaselines(handle: DbHandle, limit = 50): EvalBaselineRow[] {
  return handle.db.prepare("SELECT * FROM eval_baselines ORDER BY created DESC LIMIT ?").all(limit) as EvalBaselineRow[];
}

export function latestBaseline(handle: DbHandle, suite: string, split: string, model: string, provider: string): EvalBaselineRow | null {
  const row = handle.db
    .prepare("SELECT * FROM eval_baselines WHERE suite = ? AND split = ? AND model = ? AND provider = ? ORDER BY created DESC LIMIT 1")
    .get(suite, split, model, provider) as EvalBaselineRow | undefined;
  return row ?? null;
}

export function saveHarnessChange(
  handle: DbHandle,
  entry: { hypothesis: string; baselineId: string; candidateRunId: string; decision: "keep" | "revert" | "pending"; summary: unknown },
): void {
  handle.db
    .prepare("INSERT INTO harness_changes (id, hypothesis, baseline_id, candidate_run_id, decision, summary_json, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(`chg_${randomUUID()}`, entry.hypothesis, entry.baselineId, entry.candidateRunId, entry.decision, JSON.stringify(entry.summary), Date.now());
}
