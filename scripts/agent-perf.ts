import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../server/agent";
import { compactMessages, estimateTokens } from "../server/compaction";
import { ensureHome } from "../server/config";
import { appendMessage, createSession, listEvents, listMessages, openDatabase, recoverOnBoot } from "../server/db";
import { FixtureProviderAdapter } from "../server/eval/fixtures";
import { appendSessionEvent, createRun } from "../server/runs";
import { loadConfig, loadSecrets, saveConfig } from "../server/state";
import { executeTool } from "../server/tools";
import type { FixtureSpec } from "../server/eval/types";

const ROOT = join(import.meta.dirname, "..");
const BASELINE = join(ROOT, ".aikit", "agent-perf-baseline.json");
/**
 * Absolute ceilings, in milliseconds. These describe the machine, not the code: they were
 * recorded on a faster host and the pre-change tree fails commitP95Ms here too (5.5 ms against
 * 5, measured with this recorder at commit 8336b54). commitP95Ms was raised to 10 ms on the
 * user's instruction once this host was measured; the relative check below stays the tighter
 * of the two, so only a real regression fails rather than a slow moment.
 */
const BUDGETS = {
  agentRunP95Ms: 150,
  toolDispatchP95Ms: 10,
  commitP95Ms: 10,
  sessionSwitchP95Ms: 80,
  compactionP50Ms: 5,
} as const;

/**
 * How many independent measurements a recorded baseline is built from, and how many a gate run
 * tolerates before it trusts itself. One measurement is not evidence: the same metric on the
 * same machine ranged from 3.42 ms to 46.72 ms across processes, so a single sample describes
 * the moment, not the machine.
 */
const RECORD_RUNS = Number(process.env.ATELIER_PERF_RUNS ?? "5");
const GATE_RUNS = Number(process.env.ATELIER_PERF_GATE_RUNS ?? "3");

/** A metric above this fraction of the baseline median, or above this many times its MAD, fails. */
const REGRESSION_RATIO = 1.5;
const REGRESSION_MADS = 6;

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const rank = fraction * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  const value = low * (1 - weight) + high * weight;
  return Number(value.toFixed(2));
}

const RUN_WARMUP = 3;
const RUN_BATCHES = 3;
const RUNS_PER_BATCH = 42;

function stableP95(values: number[], batches: number): number {
  const size = Math.floor(values.length / batches);
  if (size === 0) return percentile(values, 0.95);
  const perBatch: number[] = [];
  for (let batch = 0; batch < batches; batch += 1) {
    perBatch.push(percentile(values.slice(batch * size, (batch + 1) * size), 0.95));
  }
  return Number(percentile(perBatch, 0.5).toFixed(2));
}

function spec(): FixtureSpec {
  return {
    provider: "fixture",
    models: [{ id: "fixture-model", name: "Fixture" }],
    responses: [
      { events: [{ type: "tool-call", id: "r1", name: "read_file", input: { path: "notes.txt" } }, { type: "finish", reason: "tool_calls" }] },
      { events: [{ type: "text-delta", text: "42" }, { type: "usage", promptTokens: 30, completionTokens: 1 }, { type: "finish", reason: "stop" }] },
    ],
  };
}

export type Metrics = Record<string, number>;

/** One complete measurement pass against its own throwaway state directory. */
async function measureOnce(): Promise<Metrics> {
  const home = mkdtempSync(join(tmpdir(), "atelier-agent-perf-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "atelier-agent-perf-ws-"));
  const paths = ensureHome(home);
  saveConfig(paths, {
    ...loadConfig(paths),
    providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
    defaults: { provider: "fixture", model: "fixture-model" },
    mcpServers: [],
  });
  const handle = openDatabase(paths);
  recoverOnBoot(handle);
  writeFileSync(join(workspace, "notes.txt"), "vault key: 42\n");
  try {
    const agentRuns: number[] = [];
    const config = loadConfig(paths);
    const secrets = loadSecrets(paths);
    for (let index = 0; index < RUN_WARMUP + RUN_BATCHES * RUNS_PER_BATCH; index += 1) {
      const session = createSession(handle, `agent-perf-${index}`);
      appendMessage(handle, session.id, "user", "Read notes and answer.", null);
      const run = createRun(handle, session.id, null, null, workspace);
      handle.db.prepare("UPDATE runs SET profile_id = 'build' WHERE id = ?").run(run.id);
      const started = performance.now();
      const outcome = await runAgent(handle, config, secrets, run, "fixture", "fixture-model", new AbortController().signal, { adapter: new FixtureProviderAdapter(spec()), approve: async () => true });
      if (outcome.status !== "finished") throw new Error(`agent run failed: ${outcome.reason ?? outcome.status}`);
      if (index >= RUN_WARMUP) agentRuns.push(performance.now() - started);
    }

    const session = createSession(handle, "agent-perf-tools");
    const run = createRun(handle, session.id, null, null, workspace);
    handle.db.prepare("UPDATE runs SET profile_id = 'build' WHERE id = ?").run(run.id);
    const dispatch: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const started = performance.now();
      const result = await executeTool(handle, run, "build", { id: `tool-${index}`, name: "read_file", input: { path: "notes.txt" } });
      if (!result.ok) throw new Error(result.output);
      dispatch.push(performance.now() - started);
    }

    const commits: number[] = [];
    for (let index = 0; index < 1000; index += 1) {
      const started = performance.now();
      appendSessionEvent(handle, session.id, "perf.event", { index });
      commits.push(performance.now() - started);
    }

    const switchSession = createSession(handle, "agent-perf-switch");
    for (let index = 0; index < 500; index += 1) {
      appendSessionEvent(handle, switchSession.id, "perf.switch", { index });
      appendMessage(handle, switchSession.id, index % 2 === 0 ? "user" : "assistant", `message ${index}`, null);
    }
    const switches: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      listEvents(handle, switchSession.id);
      listMessages(handle, switchSession.id);
      switches.push(performance.now() - started);
    }

    const messages = Array.from({ length: 200 }, (_value, index) => ({ role: index % 2 === 0 ? "user" as const : "assistant" as const, content: `turn ${index} ${"x".repeat(4_000)}` }));
    const compactions: number[] = [];
    for (let index = 0; index < 25; index += 1) {
      const started = performance.now();
      const result = compactMessages(messages, 12_000);
      if (result.stats.afterTokens >= estimateTokens(messages.map((message) => message.content).join(""))) throw new Error("compaction did not reduce context");
      compactions.push(performance.now() - started);
    }

    return {
      agentRunP50Ms: percentile(agentRuns, 0.5),
      agentRunP95Ms: stableP95(agentRuns, RUN_BATCHES),
      toolDispatchP50Ms: percentile(dispatch, 0.5),
      toolDispatchP95Ms: stableP95(dispatch, 4),
      commitP50Ms: percentile(commits, 0.5),
      commitP95Ms: stableP95(commits, 5),
      sessionSwitchP50Ms: percentile(switches, 0.5),
      sessionSwitchP95Ms: percentile(switches, 0.95),
      compactionP50Ms: percentile(compactions, 0.5),
      compactionP95Ms: percentile(compactions, 0.95),
    };
  } finally {
    handle.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** Median absolute deviation: a spread estimate that one slow outlier cannot inflate. */
function mad(values: number[], median: number): number {
  if (values.length === 0) return 0;
  return Number(percentile(values.map((value) => Math.abs(value - median)), 0.5).toFixed(2));
}

export interface Aggregate {
  median: Metrics;
  mad: Metrics;
  min: Metrics;
  max: Metrics;
  runs: number;
}

/** Independent passes, reduced to a median plus the spread that produced it. */
async function measure(runs: number): Promise<Aggregate> {
  const passes: Metrics[] = [];
  for (let index = 0; index < Math.max(1, runs); index += 1) passes.push(await measureOnce());
  const keys = Object.keys(passes[0] ?? {});
  const median: Metrics = {};
  const deviation: Metrics = {};
  const min: Metrics = {};
  const max: Metrics = {};
  for (const key of keys) {
    const values = passes.map((pass) => pass[key] ?? 0);
    median[key] = percentile(values, 0.5);
    deviation[key] = mad(values, median[key] ?? 0);
    min[key] = Math.min(...values);
    max[key] = Math.max(...values);
  }
  return { median, mad: deviation, min, max, runs: passes.length };
}

/**
 * Fail a metric that rose beyond both a ratio and the baseline's own spread.
 *
 * The ratio catches a real regression; the MAD bound keeps a single noisy gate run from
 * failing against a baseline whose recorded spread already explains the difference.
 */
function regressions(candidate: Metrics, baseline: { median: Metrics; mad: Metrics | undefined }): string[] {
  const failures: string[] = [];
  for (const [key, baselineValue] of Object.entries(baseline.median ?? {})) {
    if (!key.endsWith("P95Ms") || key === "compactionP95Ms" || key === "sessionSwitchP95Ms") continue;
    const value = candidate[key];
    if (typeof value !== "number") continue;
    const ratioLimit = baselineValue * REGRESSION_RATIO;
    const spread = (baseline.mad?.[key] ?? 0) * REGRESSION_MADS;
    const limit = Math.max(ratioLimit, baselineValue + spread);
    if (value > limit) failures.push(`${key} ${value} ms > baseline ${baselineValue} ms (limit ${Number(limit.toFixed(2))} ms)`);
  }
  return failures;
}

const update = process.argv.includes("--update");
const json = process.argv.includes("--json");

try {
  const aggregate = await measure(update ? RECORD_RUNS : GATE_RUNS);
  const failures: string[] = [];
  // A hard budget is about the machine, so it is checked on every run including a recording.
  for (const [key, budget] of Object.entries(BUDGETS)) {
    const value = aggregate.median[key];
    if (typeof value === "number" && value > budget) failures.push(`${key} ${value} ms > budget ${budget} ms`);
  }
  let baseline: { median: Metrics; mad: Metrics | undefined } | null = null;
  if (update) {
    writeFileSync(
      BASELINE,
      `${JSON.stringify({ schema: 2, createdAt: Date.now(), budgets: BUDGETS, runs: aggregate.runs, median: aggregate.median, mad: aggregate.mad, min: aggregate.min, max: aggregate.max }, null, 2)}\n`,
    );
  } else {
    try {
      const raw = JSON.parse(readFileSync(BASELINE, "utf8")) as { median?: Metrics; metrics?: Metrics; mad?: Metrics };
      // A schema-1 baseline recorded one pass and called it `metrics`; keep reading it.
      baseline = { median: raw.median ?? raw.metrics ?? {}, mad: raw.mad };
    } catch {
      failures.push(`missing baseline ${BASELINE}; run npm run agent-perf:baseline`);
    }
  }
  if (baseline !== null) failures.push(...regressions(aggregate.median, baseline));

  const payload = { ok: failures.length === 0, budgets: BUDGETS, runs: aggregate.runs, metrics: aggregate.median, mad: aggregate.mad, failures };
  if (json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`agent-perf ${payload.ok ? "PASS" : "FAIL"} runs=${aggregate.runs}`);
    for (const [key, value] of Object.entries(aggregate.median)) console.log(`${key}=${value}`);
    for (const key of Object.keys(aggregate.mad)) if ((aggregate.mad[key] ?? 0) > 0) console.log(`${key}.mad=${aggregate.mad[key]}`);
    for (const failure of failures) console.log(`FAIL ${failure}`);
  }
  process.exitCode = payload.ok ? 0 : 1;
} catch (error) {
  console.error(`What: the perf measurement did not complete.`);
  console.error(`Why: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Fix: run `npm run test:agent-perf` alone; a busy machine can make a run time out.");
  process.exitCode = 1;
}
