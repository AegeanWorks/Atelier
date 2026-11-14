import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runAgent } from "../agent.js";
import { auditRun } from "../audit.js";
import { AtelierError } from "../config.js";
import { createSession, listEvents, type DbHandle } from "../db.js";
import { hashRequest } from "../providers/http.js";
import { collectProvider } from "../providers/run.js";
import type { ChatRequest } from "../providers/types.js";
import { createRun, listRunSteps } from "../runs.js";
import { loadConfig, loadSecrets, type Config } from "../state.js";
import { execInWorkspace } from "../terminal.js";
import { executeTool, resolveInside } from "../tools.js";
import { FixtureProviderAdapter, loadFixture } from "./fixtures.js";
import { gradeQuality, type QualityGrade } from "./quality.js";
import { FULL_PROFILE, harnessVersion, profileFor } from "./harness.js";
import { saveEvalResult, saveEvalRun } from "./store.js";
import { percentile, summarize } from "./stats.js";
import type { EvalRunResult, EvalTask, RunMetrics, TaskResult, TaskMetrics, HarnessProfile } from "./types.js";

export interface RunOptions {
  suiteDir: string;
  split: "dev" | "test";
  profile?: string | HarnessProfile;
  repeat?: number;
  model?: string;
  provider?: string;
  resultsRoot: string;
  workspaceRoot?: string | undefined;
  taskIds?: string[] | undefined;
}

function loadTasks(suiteDir: string): EvalTask[] {
  const tasksDir = join(suiteDir, "tasks");
  const tasks = readdirSync(tasksDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(tasksDir, name), "utf8")) as EvalTask);
  if (tasks.length === 0) throw new AtelierError("EVAL_EMPTY", "Eval suite has no tasks.", tasksDir, "Add task JSON files.");
  const suite = tasks[0]?.suite;
  if (suite === undefined || tasks.some((task) => task.suite !== suite)) throw new AtelierError("EVAL_SUITE", "Eval tasks disagree on suite.", tasksDir, "Use one suite name.");
  return tasks;
}

export function suiteHash(tasks: EvalTask[]): string {
  return hashRequest(tasks);
}

function fingerprint(root: string): Record<string, string> {
  const output: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "STOP") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (statSync(path).isFile()) output[path.slice(root.length + 1).split("\\").join("/")] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(root);
  return output;
}

function writeStarter(workspace: string, starter: Record<string, string>): void {
  for (const [path, content] of Object.entries(starter)) {
    const absolute = resolveInside(workspace, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
}

function changedFiles(before: Record<string, string>, after: Record<string, string>): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => before[name] !== after[name]).sort();
}

function taskConfig(handle: DbHandle): Config {
  const base = loadConfig(handle.paths);
  return {
    ...base,
    providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
    defaults: { provider: "fixture", model: "fixture-model" },
  };
}

export async function runTask(
  handle: DbHandle,
  suiteDir: string,
  task: EvalTask,
  options: { runId: string; repeat: number; profile: HarnessProfile; resultsRoot: string; model: string; provider: string; workspaceRoot?: string | undefined },
): Promise<TaskResult> {
  const workspace = mkdtempSync(join(options.workspaceRoot ?? tmpdir(), `atelier-eval-${task.id}-`));
  const artifactDir = join(options.resultsRoot, options.runId, `${task.id}-${options.repeat}`);
  mkdirSync(artifactDir, { recursive: true });
  const before = (() => {
    writeStarter(workspace, task.starter ?? {});
    return fingerprint(workspace);
  })();
  const started = performance.now();
  const prompt = task.promptFile === undefined ? task.prompt : readFileSync(join(suiteDir, task.promptFile), "utf8");
  const secrets = loadSecrets(handle.paths);
  const session = createSession(handle, `eval:${task.id}:${options.repeat}`);
  const run = createRun(handle, session.id, null, null, workspace);
  const permissionMode = task.permissionMode === "plan" || options.profile.permissions === "plan-readonly" ? "plan" : "build";
  handle.db.prepare("UPDATE runs SET profile_id = ? WHERE id = ?").run(permissionMode, run.id);
  run.profile_id = permissionMode;
  let status: TaskResult["status"] = "scripted";
  let answer = "";
  let fixture: FixtureProviderAdapter | null = null;
  let failedSteps = 0;
  let toolCalls = 0;
  let qualityGrade: QualityGrade | null = null;
  if (task.mode === "quality") {
    const request: ChatRequest = { model: options.model, messages: [{ role: "user", content: prompt }], tools: [] };
    if (task.provider === "configured" || options.provider === "configured") {
      const config = loadConfig(handle.paths);
      const providerId = config.defaults.provider ?? config.providers[0]?.id;
      if (providerId === undefined) throw new AtelierError("EVAL_PROVIDER", "No provider configured.", task.id, "Configure a provider in Settings.");
      const provider = config.providers.find((entry) => entry.id === providerId);
      const model = config.defaults.model ?? provider?.defaultModel;
      if (model === undefined) throw new AtelierError("EVAL_MODEL", "No default model configured.", providerId, "Set a default model for the provider.");
      const result = await collectProvider(handle, config, secrets, providerId, { ...request, model }, AbortSignal.timeout(task.budgets?.wallMs ?? 120_000));
      answer = result.text;
      status = result.events.some((event) => event.type === "error") ? "blocked" : "finished";
    } else {
      if (task.fixture === undefined) throw new AtelierError("EVAL_FIXTURE", "Quality task has no fixture.", task.id, "Add a fixture path or provider=configured.");
      fixture = new FixtureProviderAdapter(loadFixture(join(suiteDir, task.fixture)));
      fixture.usage.promptTokens += Math.ceil(prompt.length / 4);
      const result = await collectProvider(handle, taskConfig(handle), secrets, "fixture", request, AbortSignal.timeout(task.budgets?.wallMs ?? 30_000), { adapter: fixture });
      answer = result.text;
      status = result.events.some((event) => event.type === "error") ? "blocked" : "finished";
    }
    qualityGrade = gradeQuality(answer, task.qualityChecks ?? []);
  } else if (task.mode === "agent") {
    if (task.provider === "configured" || options.provider === "configured") {
      const config = loadConfig(handle.paths);
      const providerId = config.defaults.provider ?? config.providers[0]?.id;
      if (providerId === undefined) throw new AtelierError("EVAL_PROVIDER", "No provider configured.", task.id, "Configure a provider in Settings.");
      const provider = config.providers.find((entry) => entry.id === providerId);
      const model = config.defaults.model ?? provider?.defaultModel;
      if (model === undefined) throw new AtelierError("EVAL_MODEL", "No default model configured.", providerId, "Set a default model for the provider.");
      const result = await runAgent(handle, config, secrets, run, providerId, model, AbortSignal.timeout(task.budgets?.wallMs ?? 120_000), { profile: options.profile, approve: async () => true });
      status = result.status;
      answer = result.text;
    } else {
      if (task.fixture === undefined) throw new AtelierError("EVAL_FIXTURE", "Agent task has no fixture.", task.id, "Add a fixture path or provider=configured.");
      fixture = new FixtureProviderAdapter(loadFixture(join(suiteDir, task.fixture)));
      const config = taskConfig(handle);
      const result = await runAgent(handle, config, secrets, run, "fixture", options.model, AbortSignal.timeout(task.budgets?.wallMs ?? 30_000), {
        profile: options.profile,
        adapter: fixture,
        approve: async () => true,
      });
      status = result.status;
      answer = result.text;
    }
  } else if (task.mode === "scripted") {
    if (task.script === undefined) throw new AtelierError("EVAL_SCRIPT", "Scripted task has no script.", task.id, "Add a script array.");
    for (const [index, step] of task.script.entries()) {
      const outcome = await executeTool(handle, { ...run, profile_id: permissionMode }, permissionMode, { id: `eval-${task.id}-${index}`, name: step.tool, input: step.input });
      toolCalls += 1;
      if (!outcome.ok) failedSteps += 1;
    }
  }
  const after = fingerprint(workspace);
  const changed = changedFiles(before, after);
  const findings: Array<{ code: string; message: string }> = [];

  const commands = [...(task.checks ?? []).map((check) => check.command), ...(task.acceptance?.mustPass ?? [])];
  for (const command of new Set(commands)) {
    const check = await execInWorkspace(workspace, command, ".", task.checks?.find((entry) => entry.command === command)?.timeoutMs ?? 10_000);
    if (check.exitCode !== 0) findings.push({ code: "CHECK_FAILED", message: `${command}: exit ${check.exitCode}\n${check.output.slice(-1200)}` });
  }
  for (const path of task.acceptance?.mustExist ?? []) if (!existsSync(join(workspace, path))) findings.push({ code: "MISSING_FILE", message: `expected ${path}` });
  for (const path of task.acceptance?.mustNotExist ?? []) if (existsSync(join(workspace, path))) findings.push({ code: "FORBIDDEN_FILE", message: `expected ${path} absent` });
  for (const [path, text] of Object.entries(task.acceptance?.mustContain ?? {})) {
    if (!existsSync(join(workspace, path))) findings.push({ code: "MISSING_FILE", message: `cannot check ${path}` });
    else if (!readFileSync(join(workspace, path), "utf8").includes(text)) findings.push({ code: "CONTENT", message: `${path} lacks ${JSON.stringify(text)}` });
  }
  for (const path of task.protected ?? []) if (changed.includes(path)) findings.push({ code: "PROTECTED_CHANGED", message: `protected path changed: ${path}` });
  if (task.acceptance?.maxChangedFiles !== undefined && changed.length > task.acceptance.maxChangedFiles) findings.push({ code: "TOO_MANY_FILES", message: `${changed.length} files changed; max ${task.acceptance.maxChangedFiles}` });
  for (const forbidden of task.acceptance?.forbiddenStrings ?? []) {
    for (const path of changed) {
      if (existsSync(join(workspace, path)) && readFileSync(join(workspace, path), "utf8").includes(forbidden)) findings.push({ code: "FORBIDDEN_STRING", message: `${path} contains ${JSON.stringify(forbidden)}` });
    }
    if (answer.includes(forbidden)) findings.push({ code: "FORBIDDEN_STRING", message: `answer contains ${JSON.stringify(forbidden)}` });
  }
  if (task.acceptance?.answerIncludes !== undefined && !answer.includes(task.acceptance.answerIncludes)) findings.push({ code: "ANSWER", message: `answer lacks ${JSON.stringify(task.acceptance.answerIncludes)}` });
  if (task.mode === "quality") {
    if ((task.qualityChecks ?? []).length === 0) findings.push({ code: "QUALITY_EMPTY", message: "quality task has no checks" });
    for (const failure of qualityGrade?.failures ?? []) findings.push({ code: "QUALITY_CHECK", message: failure });
  }
  if (task.acceptance?.expectStatus !== undefined && status !== task.acceptance.expectStatus && task.mode === "agent") findings.push({ code: "STATUS", message: `expected ${task.acceptance.expectStatus}, got ${status}` });

  const audit = auditRun(handle, run.id);
  for (const finding of audit.findings.filter((entry) => entry.level === "L1")) findings.push({ code: `AUDIT_${finding.code}`, message: finding.message });
  const integrity = findings.some((finding) => ["PROTECTED_CHANGED", "FORBIDDEN_STRING", "FORBIDDEN_FILE"].includes(finding.code)) ? "violated" : "clean";
  const ok = findings.length === 0;
  const tracedSteps = listRunSteps(handle, run.id).length;
  const steps = task.mode === "quality" ? 1 : tracedSteps;
  const metrics: TaskMetrics = {
    steps,
    toolCalls: toolCalls + listRunSteps(handle, run.id).filter((step) => step.kind === "tool").length,
    promptTokens: fixture?.usage.promptTokens ?? 0,  // aikit:allow-secret[high-entropy-value] -- token usage counter, not a credential
    completionTokens: fixture?.usage.completionTokens ?? 0,  // aikit:allow-secret[high-entropy-value] -- token usage counter, not a credential
    costUsd: 0,
    wallMs: Math.round(performance.now() - started),
    rr: task.mode === "quality" ? 1 : failedSteps === 0 ? 1 : Math.max(0, 1 - failedSteps / Math.max(1, steps)),
    csr: ok ? 1 : 0,
    es: task.mode === "quality" ? 1 : steps === 0 ? 0 : 1 / steps,
    score: task.mode === "quality" ? qualityGrade?.score ?? 0 : ok ? 1 : 0,
  };
  const result: TaskResult = { taskId: task.id, suite: task.suite, split: task.split, mode: task.mode, repeat: options.repeat, ok, status, metrics, findings, integrity, traceRef: null, diffRef: null };

  const trace = listEvents(handle, session.id).map((event) => JSON.stringify({ type: event.type, seq: event.seq, data: JSON.parse(event.data) })).join("\n");
  const traceRef = join(artifactDir, "trace.jsonl");
  writeFileSync(traceRef, `${trace}\n`, "utf8");
  const changedRef = join(artifactDir, "changed.json");
  writeFileSync(changedRef, `${JSON.stringify({ changed, before, after }, null, 2)}\n`, "utf8");
  const providerRef = join(artifactDir, "provider.jsonl");
  writeFileSync(providerRef, `${(fixture?.requests ?? []).map((request: ChatRequest) => JSON.stringify(request)).join("\n")}\n`, "utf8");
  writeFileSync(join(artifactDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  result.traceRef = traceRef;
  result.diffRef = changedRef;
  saveEvalResult(handle, options.runId, result);
  rmSync(workspace, { recursive: true, force: true });
  return result;
}

export async function runEval(handle: DbHandle, options: RunOptions): Promise<EvalRunResult> {
  const tasks = loadTasks(options.suiteDir);
  const selected = tasks.filter((task) => task.split === options.split && (options.taskIds === undefined || options.taskIds.includes(task.id)));
  if (selected.length === 0) throw new AtelierError("EVAL_EMPTY", `No ${options.split} tasks.`, options.suiteDir, "Add tasks for this split.");
  const profile = typeof options.profile === "string" ? profileFor(options.profile) : options.profile ?? FULL_PROFILE;
  const repeat = options.repeat ?? 1;
  const model = options.model ?? "fixture-model";
  const provider = options.provider ?? "fixture";
  const runId = `eval_${randomUUID()}`;
  const createdAt = Date.now();
  const results: TaskResult[] = [];
  for (const task of selected) {
    for (let index = 0; index < repeat; index += 1) {
      results.push(await runTask(handle, options.suiteDir, task, { runId, repeat: index, profile, resultsRoot: options.resultsRoot, model, provider, workspaceRoot: options.workspaceRoot }));
    }
  }
  const passed = results.filter((result) => result.ok).length;
  const taskPass = new Map<string, boolean>();
  for (const result of results) taskPass.set(result.taskId, (taskPass.get(result.taskId) ?? false) || result.ok);
  const walls = results.map((result) => result.metrics.wallMs);
  const metrics: RunMetrics = {
    tasks: taskPass.size,
    passed: [...taskPass.values()].filter(Boolean).length,
    mean: results.length === 0 ? 0 : passed / results.length,
    r08: results.length === 0 ? 0 : results.filter((result) => result.metrics.score >= 0.8).length / results.length,
    r1: results.length === 0 ? 0 : results.filter((result) => result.metrics.score >= 1).length / results.length,
    passAtK: taskPass.size === 0 ? 0 : [...taskPass.values()].filter(Boolean).length / taskPass.size,
    rr: results.length === 0 ? 0 : results.reduce((total, result) => total + result.metrics.rr, 0) / results.length,
    csr: results.length === 0 ? 0 : results.reduce((total, result) => total + result.metrics.csr, 0) / results.length,
    es: results.length === 0 ? 0 : results.reduce((total, result) => total + result.metrics.es, 0) / results.length,
    promptTokens: results.reduce((total, result) => total + result.metrics.promptTokens, 0),
    completionTokens: results.reduce((total, result) => total + result.metrics.completionTokens, 0),
    costUsd: results.reduce((total, result) => total + result.metrics.costUsd, 0),
    p50Ms: percentile(walls, 0.5),
    p95Ms: percentile(walls, 0.95),
  };
  const integrity = results.some((result) => result.integrity === "violated") ? "violated" : "clean";
  const run: EvalRunResult = {
    runId,
    suite: selected[0]?.suite ?? "unknown",
    suiteHash: suiteHash(selected),
    harnessVersion: harnessVersion(profile),
    profile,
    split: options.split,
    model,
    provider,
    repeat,
    metrics,
    results,
    ok: results.every((result) => result.ok),
    integrity,
    createdAt,
    finishedAt: Date.now(),
  };
  saveEvalRun(handle, run, { node: process.version, platform: process.platform, cwd: process.cwd() });
  return run;
}

export function summarizeWall(values: number[]): { mean: number; p50: number; p95: number } {
  return summarize(values);
}
