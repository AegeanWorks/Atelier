import type { StreamEvent } from "../providers/types.js";

export type Split = "dev" | "test";
export type TaskMode = "agent" | "scripted" | "quality";

export interface HarnessProfile {
  id: string;
  promptVersion: string;
  maxSteps: number;
  toolNames: string[];
  contextMessages: number;
  /**
   * Compaction budget in tokens. An explicit number keeps a fixture or an eval rung
   * deterministic; `undefined` derives it from the model's real context window, so a
   * live run is never capped at a constant unrelated to the model it is talking to.
   */
  contextTokens?: number | undefined;
  doomLoopLimit: number;
  compaction: "none" | "summary";
  permissions: "build-workspace" | "plan-readonly";
  finishPolicy: "text" | "evidence-required";
}

export interface EvalCheck {
  command: string;
  timeoutMs?: number | undefined;
}

export interface QualityCase {
  args: unknown[];
  expect: unknown;
}

export type QualityCheck =
  | { type: "exact"; value: string }
  | { type: "includes"; value: string }
  | { type: "regex"; pattern: string }
  | { type: "number"; value: number }
  | { type: "jsTests"; entry: string; cases: QualityCase[] };

export interface EvalAcceptance {
  maxChangedFiles?: number | undefined;
  mustPass?: string[] | undefined;
  mustExist?: string[] | undefined;
  mustNotExist?: string[] | undefined;
  mustContain?: Record<string, string> | undefined;
  forbiddenStrings?: string[] | undefined;
  answerIncludes?: string | undefined;
  expectStatus?: "finished" | "blocked" | undefined;
}

export interface EvalTask {
  id: string;
  suite: string;
  split: Split;
  mode: TaskMode;
  provider?: "fixture" | "configured" | undefined;
  permissionMode?: "plan" | "build" | undefined;
  prompt: string;
  promptFile?: string | undefined;
  maxTokens?: number | undefined;
  qualityChecks?: QualityCheck[] | undefined;
  starter?: Record<string, string> | undefined;
  script?: Array<{ tool: string; input: Record<string, unknown> }> | undefined;
  fixture?: string | undefined;
  checks?: EvalCheck[] | undefined;
  protected?: string[] | undefined;
  acceptance?: EvalAcceptance | undefined;
  budgets?: { maxSteps?: number | undefined; maxTokens?: number | undefined; wallMs?: number | undefined } | undefined;
  tags?: string[] | undefined;
  source?: { dataset: string; id: string; license: string } | undefined;
  perturbations?: string[] | undefined;
}

export interface FixtureResponse {
  events: StreamEvent[];
  error?: { code?: string; message: string } | undefined;
}

export interface FixtureSpec {
  provider: string;
  models: Array<{ id: string; name?: string }>;
  responses: FixtureResponse[];
}

export interface TaskMetrics {
  steps: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  wallMs: number;
  rr: number;
  csr: number;
  es: number;
  score: number;
}

export interface TaskResult {
  taskId: string;
  suite: string;
  split: Split;
  mode: TaskMode;
  repeat: number;
  ok: boolean;
  status: "finished" | "blocked" | "scripted";
  metrics: TaskMetrics;
  findings: Array<{ code: string; message: string }>;
  integrity: "clean" | "violated";
  traceRef: string | null;
  diffRef: string | null;
}

export interface RunMetrics {
  tasks: number;
  passed: number;
  mean: number;
  r08: number;
  r1: number;
  passAtK: number;
  rr: number;
  csr: number;
  es: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  p50Ms: number;
  p95Ms: number;
}

export interface EvalRunResult {
  runId: string;
  suite: string;
  suiteHash: string;
  harnessVersion: string;
  profile: HarnessProfile;
  split: Split;
  model: string;
  provider: string;
  repeat: number;
  metrics: RunMetrics;
  results: TaskResult[];
  ok: boolean;
  integrity: "clean" | "violated";
  createdAt: number;
  finishedAt: number;
}
