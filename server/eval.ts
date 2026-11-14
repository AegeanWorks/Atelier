import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DbHandle } from "./db.js";
import { createSession } from "./db.js";
import { createRun } from "./runs.js";
import { executeTool, resolveInside } from "./tools.js";

export interface EvalStep {
  tool: string;
  input: Record<string, unknown>;
}

export interface EvalTask {
  id: string;
  suite: string;
  mode: "plan" | "build";
  starter?: Record<string, string>;
  script: EvalStep[];
  allowFailure?: boolean;
  acceptance: {
    mustExist?: string[];
    mustNotExist?: string[];
    mustContain?: Record<string, string>;
  };
}

export interface EvalFinding {
  code: string;
  message: string;
}

export interface EvalResult {
  taskId: string;
  suite: string;
  ok: boolean;
  steps: number;
  failedSteps: number;
  rr: number;
  csr: number;
  es: number;
  integrity: "clean" | "violated";
  findings: EvalFinding[];
}

function writeStarter(workspace: string, starter: Record<string, string>): void {
  for (const [path, content] of Object.entries(starter)) {
    const absolute = resolveInside(workspace, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
}

function acceptance(task: EvalTask, workspace: string): EvalFinding[] {
  const findings: EvalFinding[] = [];
  for (const path of task.acceptance.mustExist ?? []) {
    if (!existsSync(join(workspace, path))) findings.push({ code: "MISSING_FILE", message: `expected ${path} to exist` });
  }
  for (const path of task.acceptance.mustNotExist ?? []) {
    if (existsSync(join(workspace, path))) findings.push({ code: "FORBIDDEN_FILE", message: `expected ${path} to be absent` });
  }
  for (const [path, text] of Object.entries(task.acceptance.mustContain ?? {})) {
    if (!existsSync(join(workspace, path))) {
      findings.push({ code: "MISSING_FILE", message: `cannot check ${path}; it is absent` });
      continue;
    }
    if (!readFileSync(join(workspace, path), "utf8").includes(text)) findings.push({ code: "CONTENT", message: `${path} does not contain ${JSON.stringify(text)}` });
  }
  return findings;
}

export async function runEvalTask(handle: DbHandle, workspace: string, task: EvalTask): Promise<EvalResult> {
  mkdirSync(workspace, { recursive: true });
  writeStarter(workspace, task.starter ?? {});
  const session = createSession(handle, `eval:${task.id}`);
  const run = createRun(handle, session.id, null, null, workspace);
  handle.db.prepare("UPDATE runs SET profile_id = ? WHERE id = ?").run(task.mode, run.id);
  let steps = 0;
  let failedSteps = 0;
  for (const [index, step] of task.script.entries()) {
    const outcome = await executeTool(handle, { ...run, profile_id: task.mode }, task.mode, {
      id: `eval-${task.id}-${index}`,
      name: step.tool,
      input: step.input,
    });
    steps += 1;
    if (!outcome.ok) failedSteps += 1;
  }
  const findings = acceptance(task, workspace);
  const ok = findings.length === 0;
  const rr = failedSteps === 0 || task.allowFailure === true ? 1 : Math.max(0, 1 - failedSteps / Math.max(1, steps));
  return {
    taskId: task.id,
    suite: task.suite,
    ok,
    steps,
    failedSteps,
    rr,
    csr: ok ? 1 : 0,
    es: steps === 0 ? 0 : 1 / steps,
    integrity: findings.length === 0 ? "clean" : "violated",
    findings,
  };
}

export function loadSuite(path: string): EvalTask[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("eval suite must be an array");
  return parsed as EvalTask[];
}
