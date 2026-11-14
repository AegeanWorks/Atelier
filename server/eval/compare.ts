import { AtelierError } from "../config.js";
import type { DbHandle } from "../db.js";
import { bootstrapDelta, mcnemarExact } from "./stats.js";
import { getBaseline, getEvalResults, getEvalRun, latestBaseline, type EvalBaselineRow, type EvalRunRow } from "./store.js";

export interface CompareFinding {
  code: string;
  message: string;
}

export interface CompareResult {
  ok: boolean;
  baselineLabel: string;
  baselineRunId: string;
  candidateRunId: string;
  delta: { mean: number; low: number; high: number };
  mcnemar: number;
  flips: { improved: string[]; lost: string[]; unchanged: string[] };
  failures: CompareFinding[];
  warnings: CompareFinding[];
}

function taskScores(handle: DbHandle, runId: string): Map<string, number> {
  const rows = getEvalResults(handle, runId);
  const grouped = new Map<string, number[]>();
  for (const row of rows) {
    const metrics = JSON.parse(row.metrics_json) as { score?: number };
    const values = grouped.get(row.task_id) ?? [];
    values.push(typeof metrics.score === "number" ? metrics.score : row.ok === 1 ? 1 : 0);
    grouped.set(row.task_id, values);
  }
  const scores = new Map<string, number>();
  for (const [task, values] of grouped) scores.set(task, values.reduce((total, value) => total + value, 0) / values.length);
  return scores;
}

export function compareRuns(handle: DbHandle, baseline: EvalBaselineRow, candidateRunId: string): CompareResult {
  const candidate = getEvalRun(handle, candidateRunId);
  if (candidate === null) throw new AtelierError("EVAL_RUN_MISSING", "Candidate run not found.", candidateRunId, "Run the suite first.");
  if (baseline.suite_hash !== candidate.suite_hash) throw new AtelierError("EVAL_SUITE_MISMATCH", "Baseline and candidate suites differ.", `${baseline.suite_hash} vs ${candidate.suite_hash}`, "Compare runs from the same frozen suite.");
  if (baseline.model !== candidate.model || baseline.provider !== candidate.provider || baseline.split !== candidate.split) {
    throw new AtelierError("EVAL_ENV_MISMATCH", "Baseline and candidate environment differ.", `${baseline.model}/${baseline.provider}/${baseline.split} vs ${candidate.model}/${candidate.provider}/${candidate.split}`, "Use the same model, provider and split.");
  }
  const baselineScores = taskScores(handle, baseline.run_id);
  const candidateScores = taskScores(handle, candidate.id);
  const taskIds = [...new Set([...baselineScores.keys(), ...candidateScores.keys()])].sort();
  const baseValues = taskIds.map((task) => baselineScores.get(task) ?? 0);
  const candidateValues = taskIds.map((task) => candidateScores.get(task) ?? 0);
  const improved = taskIds.filter((task) => (candidateScores.get(task) ?? 0) > (baselineScores.get(task) ?? 0));
  const lost = taskIds.filter((task) => (candidateScores.get(task) ?? 0) < (baselineScores.get(task) ?? 0));
  const unchanged = taskIds.filter((task) => (candidateScores.get(task) ?? 0) === (baselineScores.get(task) ?? 0));
  const delta = bootstrapDelta(baseValues, candidateValues);
  const mcnemar = mcnemarExact(lost.length, improved.length);
  const baselineMetrics = JSON.parse(baseline.metrics_json) as { csr?: number; costUsd?: number; mean?: number };
  const candidateMetrics = JSON.parse(candidate.metrics_json) as { csr?: number; costUsd?: number; mean?: number };
  const candidateIntegrity = JSON.parse(candidate.metrics_json) as { integrity?: string };
  const failures: CompareFinding[] = [];
  const warnings: CompareFinding[] = [];
  if (candidateIntegrity.integrity === "violated") failures.push({ code: "INTEGRITY", message: "candidate has an integrity violation" });
  if ((candidateMetrics.csr ?? 0) < (baselineMetrics.csr ?? 0) - 1e-9) failures.push({ code: "CSR", message: "CSR regressed" });
  if (lost.length >= 2) failures.push({ code: "TASK_LOSS", message: `${lost.length} tasks regressed` });
  if (delta.high < 0) failures.push({ code: "DELTA_CI", message: "paired delta CI is entirely below zero" });
  if (delta.low <= 0 && delta.high >= 0) warnings.push({ code: "DELTA_NOISE", message: "paired delta CI overlaps zero" });
  if ((candidateMetrics.costUsd ?? 0) > (baselineMetrics.costUsd ?? 0) * 1.25) warnings.push({ code: "COST", message: "cost rose more than 25%" });
  if (delta.mean > 0 && candidateMetrics.mean !== undefined && baselineMetrics.mean !== undefined && candidateMetrics.mean <= baselineMetrics.mean) {
    warnings.push({ code: "MEAN", message: "paired delta positive but aggregate mean did not move" });
  }
  return {
    ok: failures.length === 0,
    baselineLabel: baseline.label,
    baselineRunId: baseline.run_id,
    candidateRunId,
    delta,
    mcnemar,
    flips: { improved, lost, unchanged },
    failures,
    warnings,
  };
}

export function compareToLatest(handle: DbHandle, candidateRunId: string, baselineLabel?: string): CompareResult {
  const candidate = getEvalRun(handle, candidateRunId);
  if (candidate === null) throw new AtelierError("EVAL_RUN_MISSING", "Candidate run not found.", candidateRunId, "Run the suite first.");
  const baseline = baselineLabel !== undefined
    ? getBaseline(handle, baselineLabel)
    : latestBaseline(handle, candidate.suite, candidate.split, candidate.model, candidate.provider);
  if (baseline === null) throw new AtelierError("EVAL_BASELINE", "No matching baseline.", `${candidate.suite}/${candidate.split}/${candidate.model}`, "Create a baseline with `npm run eval:baseline`.");
  return compareRuns(handle, baseline, candidateRunId);
}

export function runRowMetrics(row: EvalRunRow): Record<string, number> {
  return JSON.parse(row.metrics_json) as Record<string, number>;
}
