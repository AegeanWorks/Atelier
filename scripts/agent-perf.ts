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
const BUDGETS = {
  agentRunP95Ms: 150,
  toolDispatchP95Ms: 10,
  commitP95Ms: 5,
  sessionSwitchP95Ms: 80,
  compactionP50Ms: 5,
} as const;

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

  const metrics = {
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
  const update = process.argv.includes("--update");
  const failures: string[] = [];
  for (const [key, budget] of Object.entries(BUDGETS)) {
    const value = metrics[key as keyof typeof metrics];
    if (value > budget) failures.push(`${key} ${value} ms > budget ${budget} ms`);
  }
  if (update) {
    writeFileSync(BASELINE, `${JSON.stringify({ schema: 1, createdAt: Date.now(), budgets: BUDGETS, metrics }, null, 2)}\n`);
  } else {
    try {
      const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as { metrics?: Record<string, number> };
      for (const [key, baselineValue] of Object.entries(baseline.metrics ?? {})) {
        if (!key.endsWith("P95Ms") || key === "compactionP95Ms" || key === "sessionSwitchP95Ms") continue;
        const value = metrics[key as keyof typeof metrics];
        if (typeof value === "number" && value > baselineValue * 1.5) failures.push(`${key} ${value} ms > baseline ${baselineValue} ms +50%`);
      }
    } catch {
      failures.push(`missing baseline ${BASELINE}; run npm run agent-perf:baseline`);
    }
  }

  const payload = { ok: failures.length === 0, budgets: BUDGETS, metrics, failures };
  if (process.argv.includes("--json")) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`agent-perf ${payload.ok ? "PASS" : "FAIL"}`);
    for (const [key, value] of Object.entries(metrics)) console.log(`${key}=${value}`);
    for (const failure of failures) console.log(`FAIL ${failure}`);
  }
  process.exitCode = payload.ok ? 0 : 1;
} finally {
  handle.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}
