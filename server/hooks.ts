import type { DbHandle } from "./db.js";
import { appendSessionEvent } from "./runs.js";
import { execInWorkspace } from "./terminal.js";
import type { Config } from "./state.js";

export type Hook = Config["hooks"][number];
export type HookEvent = Hook["event"];

export interface HookCall {
  tool: string;
  input: unknown;
  runId: string;
  sessionId: string;
  outcome?: { ok: boolean; output: string };
}

export interface HookResult {
  hookId: string;
  event: HookEvent;
  exitCode: number | null;
  timedOut: boolean;
  blocked: boolean;
  output: string;
}

export interface HookRun {
  blocked: boolean;
  reason: string;
  hookId: string | null;
  results: HookResult[];
}

const ENV_LIMIT = 8_000;
const OUTPUT_LIMIT = 1_000;

function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

function matches(hook: Hook, tool: string): boolean {
  try {
    return new RegExp(hook.match).test(tool);
  } catch {
    return false;
  }
}

/**
 * Run the configured hooks for one event, in order, against one tool call.
 * Exit code 2 from a pre_tool hook vetoes the call and its output becomes the reason; any other
 * non-zero exit, a timeout or a failure to start is reported but never blocks. post_tool hooks never block.
 */
export async function runHooks(workspace: string, hooks: Hook[], event: HookEvent, call: HookCall): Promise<HookRun> {
  const run: HookRun = { blocked: false, reason: "", hookId: null, results: [] };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ATELIER_HOOK_EVENT: event,
    ATELIER_TOOL: call.tool,
    ATELIER_TOOL_INPUT: bounded(JSON.stringify(call.input ?? null), ENV_LIMIT),
    ATELIER_RUN_ID: call.runId,
    ATELIER_SESSION_ID: call.sessionId,
  };
  if (call.outcome !== undefined) {
    env.ATELIER_TOOL_OK = String(call.outcome.ok);
    env.ATELIER_TOOL_OUTPUT = bounded(call.outcome.output, ENV_LIMIT);
  }
  for (const hook of hooks) {
    if (hook.event !== event || !matches(hook, call.tool)) continue;
    let exitCode: number | null = null;
    let timedOut = false;
    let output = "";
    try {
      const result = await execInWorkspace(workspace, hook.command, ".", hook.timeoutMs, env);
      exitCode = result.exitCode;
      timedOut = result.timedOut;
      output = result.output.trim();
    } catch (error) {
      output = error instanceof Error ? error.message : String(error);
    }
    const blocked = event === "pre_tool" && exitCode === 2;
    run.results.push({ hookId: hook.id, event, exitCode, timedOut, blocked, output: bounded(output, OUTPUT_LIMIT) });
    if (blocked) {
      run.blocked = true;
      run.hookId = hook.id;
      run.reason = bounded(output, OUTPUT_LIMIT).length > 0 ? bounded(output, OUTPUT_LIMIT) : "the hook vetoed this call";
      break;
    }
  }
  return run;
}

/** Persist each hook result as a session event so a veto or a failing hook is visible in the audit trail. */
export function recordHookResults(handle: DbHandle, call: HookCall & { callId: string }, results: HookResult[]): void {
  for (const result of results) {
    appendSessionEvent(handle, call.sessionId, "hook.result", { runId: call.runId, callId: call.callId, tool: call.tool, ...result });
  }
}
