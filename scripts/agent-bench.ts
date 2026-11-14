import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHome } from "../server/config";
import { openDatabase, recoverOnBoot } from "../server/db";
import { bootstrapDelta, mcnemarExact, percentile, summarize, wilson } from "../server/eval/stats";
import { runEval } from "../server/eval/runner";
import type { TaskResult } from "../server/eval/types";

const ROOT = join(import.meta.dirname, "..");
const BASELINE = join(ROOT, ".aikit", "agent-bench-baseline.json");
const REPEAT = Number(process.env.ATELIER_BENCH_REPEAT ?? "10");
const TASKS = ["r0-read-only", "r1-single-file", "r2-multi-file", "r5-delegation"];
const MAX_SUCCESS_DROP = 0.05;
const MAX_MEAN_LATENCY_RATIO = 1.25;

function bootstrapMean(values: number[], samples = 2_000, seed = 20261108): { mean: number; low: number; high: number } {
  if (values.length === 0) return { mean: 0, low: 0, high: 0 };
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const means: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) total += values[Math.floor(next() * values.length)] ?? 0;
    means.push(total / values.length);
  }
  return { mean, low: percentile(means, 0.025), high: percentile(means, 0.975) };
}

function key(result: Pick<TaskResult, "taskId" | "repeat">): string {
  return `${result.taskId}:${result.repeat}`;
}

function metrics(results: TaskResult[]): { overall: Record<string, unknown>; perTask: Record<string, unknown>; results: Array<{ taskId: string; repeat: number; ok: boolean; wallMs: number }> } {
  const passed = results.filter((result) => result.ok).length;
  const walls = results.map((result) => result.metrics.wallMs);
  const rate = results.length === 0 ? 0 : passed / results.length;
  const overall = {
    runs: results.length,
    passed,
    rate,
    wilson: wilson(passed, results.length),
    latency: { ...summarize(walls), ci: bootstrapMean(walls) },
  };
  const perTask: Record<string, unknown> = {};
  for (const taskId of TASKS) {
    const taskResults = results.filter((result) => result.taskId === taskId);
    const taskPassed = taskResults.filter((result) => result.ok).length;
    perTask[taskId] = {
      runs: taskResults.length,
      passed: taskPassed,
      rate: taskResults.length === 0 ? 0 : taskPassed / taskResults.length,
      wilson: wilson(taskPassed, taskResults.length),
      latency: summarize(taskResults.map((result) => result.metrics.wallMs)),
    };
  }
  return {
    overall,
    perTask,
    results: results.map((result) => ({ taskId: result.taskId, repeat: result.repeat, ok: result.ok, wallMs: result.metrics.wallMs })),
  };
}

const home = mkdtempSync(join(tmpdir(), "atelier-agent-bench-home-"));
const paths = ensureHome(home);
const db = openDatabase(paths);
recoverOnBoot(db);
try {
  const run = await runEval(db, {
    suiteDir: join(ROOT, "evals", "suites", "atelier-core"),
    split: "dev",
    taskIds: TASKS,
    profile: "full-v1",
    repeat: REPEAT,
    resultsRoot: mkdtempSync(join(tmpdir(), "atelier-agent-bench-results-")),
  });
  const current = metrics(run.results);
  const update = process.argv.includes("--update");
  const failures: string[] = [];
  let comparison: Record<string, unknown> | null = null;
  if (update) {
    writeFileSync(BASELINE, `${JSON.stringify({ schema: 1, createdAt: Date.now(), repeat: REPEAT, tasks: TASKS, ...current }, null, 2)}\n`);
  } else {
    try {
      const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as { results: Array<{ taskId: string; repeat: number; ok: boolean; wallMs: number }>; repeat: number };
      if (baseline.repeat !== REPEAT) throw new Error(`baseline repeat ${baseline.repeat} does not match ${REPEAT}`);
      const baselineByKey = new Map(baseline.results.map((result) => [key(result), result]));
      const currentByKey = new Map(current.results.map((result) => [key(result), result]));
      const keys = [...currentByKey.keys()].filter((entryKey) => baselineByKey.has(entryKey));
      const baselineLatency = keys.map((entryKey) => baselineByKey.get(entryKey)?.wallMs ?? 0);
      const currentLatency = keys.map((entryKey) => currentByKey.get(entryKey)?.wallMs ?? 0);
      const latency = bootstrapDelta(baselineLatency, currentLatency, { seed: 20261108 });
      let baselineOnly = 0;
      let candidateOnly = 0;
      for (const entryKey of keys) {
        const before = baselineByKey.get(entryKey)?.ok ?? false;
        const after = currentByKey.get(entryKey)?.ok ?? false;
        if (before && !after) baselineOnly += 1;
        if (!before && after) candidateOnly += 1;
      }
      const pValue = mcnemarExact(baselineOnly, candidateOnly);
      const baselineRate = keys.length === 0 ? 0 : keys.filter((entryKey) => baselineByKey.get(entryKey)?.ok === true).length / keys.length;
      const currentRate = keys.length === 0 ? 0 : keys.filter((entryKey) => currentByKey.get(entryKey)?.ok === true).length / keys.length;
      const meanBefore = baselineLatency.reduce((total, value) => total + value, 0) / Math.max(1, baselineLatency.length);
      const meanAfter = currentLatency.reduce((total, value) => total + value, 0) / Math.max(1, currentLatency.length);
      comparison = { keys: keys.length, success: { baseline: baselineRate, candidate: currentRate, baselineOnly, candidateOnly, mcnemarP: pValue }, latency: { ...latency, baselineMean: meanBefore, candidateMean: meanAfter } };
      if (currentRate < baselineRate - MAX_SUCCESS_DROP) failures.push(`success rate ${currentRate.toFixed(3)} < baseline ${baselineRate.toFixed(3)} - ${MAX_SUCCESS_DROP}`);
      if (pValue < 0.05 && currentRate < baselineRate) failures.push(`success regression is significant (McNemar p=${pValue.toFixed(4)})`);
      if (meanBefore > 0 && meanAfter > meanBefore * MAX_MEAN_LATENCY_RATIO && latency.low > 0) failures.push(`mean latency ${meanAfter.toFixed(1)} ms > baseline ${meanBefore.toFixed(1)} ms +${Math.round((MAX_MEAN_LATENCY_RATIO - 1) * 100)}%`);
    } catch (error) {
      failures.push(`baseline unavailable: ${error instanceof Error ? error.message : String(error)}; run npm run agent-bench:baseline`);
    }
  }
  const payload = { ok: failures.length === 0, repeat: REPEAT, tasks: TASKS, ...current, comparison, failures };
  if (process.argv.includes("--json")) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`agent-bench ${payload.ok ? "PASS" : "FAIL"} repeat=${REPEAT}`);
    console.log(`overall ${current.overall.passed}/${current.overall.runs} rate=${Number(current.overall.rate).toFixed(3)} wilson=[${Number((current.overall.wilson as { low: number }).low).toFixed(3)}, ${Number((current.overall.wilson as { high: number }).high).toFixed(3)}]`);
    console.log(`latency mean=${Number((current.overall.latency as { mean: number }).mean).toFixed(2)} p50=${Number((current.overall.latency as { p50: number }).p50).toFixed(2)} p95=${Number((current.overall.latency as { p95: number }).p95).toFixed(2)}`);
    for (const [taskId, task] of Object.entries(current.perTask)) {
      const entry = task as { rate: number; latency: { mean: number; p95: number } };
      console.log(`${taskId} rate=${entry.rate.toFixed(3)} mean=${entry.latency.mean.toFixed(2)} p95=${entry.latency.p95.toFixed(2)}`);
    }
    if (comparison !== null) console.log(`comparison ${JSON.stringify(comparison)}`);
    for (const failure of failures) console.log(`FAIL ${failure}`);
  }
  process.exitCode = payload.ok ? 0 : 1;
} finally {
  db.close();
  rmSync(home, { recursive: true, force: true });
}
