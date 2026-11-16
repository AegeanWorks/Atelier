import { AtelierError, ensureHome, resolveHome } from "./config.js";
import { attachMentionedFiles } from "./attachments.js";
import { attachImages, saveImageFile } from "./images.js";
import { isProtectedConfigPath } from "./rules.js";
import { createSession, deleteSession, getSession, listEvents, listSessions, listMessages, openDatabase, recoverOnBoot } from "./db.js";
import { executeRun } from "./runner.js";
import { createRun, getRun, listRunSteps, type RunRow } from "./runs.js";
import { appendMessage } from "./db.js";
import type { ProviderAdapter } from "./providers/types.js";

export type HeadlessMode = "plan" | "build";

export interface HeadlessOptions {
  prompt: string;
  workspace?: string;
  homeDir?: string;
  mode?: HeadlessMode;
  sessionId?: string | null;
  continueLatest?: boolean;
  images?: string[];
  autoApprove?: boolean;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Run this model for one run instead of the configured default; the config is not changed. */
  model?: string;
  /** One-shot run: hand back the answer without leaving a resumable conversation behind. */
  noSession?: boolean;
  /** Called once per session event of this run, in order, while the run works and once more when it ends. */
  onEvent?: (event: { seq: number; type: string; data: unknown }) => void;
  adapter?: ProviderAdapter;
}

export interface HeadlessResult {
  status: "finished" | "blocked";
  text: string;
  runId: string;
  sessionId: string;
  mode: HeadlessMode;
  reason?: string;
  steps: number;
  tools: number;
  usage: { promptTokens: number; completionTokens: number } | null;
}

function lastUsage(handle: ReturnType<typeof openDatabase>, sessionId: string, runId: string): { promptTokens: number; completionTokens: number } | null {
  const rows = listEvents(handle, sessionId).filter((event) => event.type === "llm.usage");
  let prompt = 0;
  let completion = 0;
  let seen = false;
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data) as { runId?: string; promptTokens?: number; completionTokens?: number };
      if (data.runId !== runId) continue;
      prompt += typeof data.promptTokens === "number" ? data.promptTokens : 0;
      completion += typeof data.completionTokens === "number" ? data.completionTokens : 0;
      seen = true;
    } catch {
      continue;
    }
  }
  return seen ? { promptTokens: prompt, completionTokens: completion } : null;
}

export interface SessionSummary {
  id: string;
  title: string;
  updated: number;
}

/** Active conversations, newest first, for `atelier sessions`. */
export function listHeadlessSessions(homeDir?: string): SessionSummary[] {
  const handle = openDatabase(ensureHome(homeDir ?? resolveHome()));
  try {
    return listSessions(handle)
      .map((session) => ({ id: session.id, title: session.title, updated: session.updated }))
      .sort((a, b) => b.updated - a.updated);
  } finally {
    handle.close();
  }
}

export async function runHeadless(options: HeadlessOptions): Promise<HeadlessResult> {
  const prompt = options.prompt.trim();
  if (prompt.length === 0) {
    throw new AtelierError("HEADLESS_PROMPT", "A prompt is required.", "The run was invoked with an empty prompt.", 'Pass the prompt, for example `atelier run "fix the failing test"`.');
  }
  if (prompt.length > 100_000) {
    throw new AtelierError("HEADLESS_PROMPT", "The prompt is too long.", `${prompt.length} characters exceeds 100000.`, "Shorten the prompt or reference files instead.");
  }
  const workspace = options.workspace ?? process.cwd();
  const paths = ensureHome(options.homeDir ?? resolveHome());
  // Validate every image before anything is created, so a bad path leaves no empty conversation behind.
  const imageIds = (options.images ?? []).map((file) => saveImageFile(paths, workspace, file));
  const handle = openDatabase(paths);
  try {
    recoverOnBoot(handle);
    let sessionId = options.sessionId ?? null;
    if (sessionId === null && options.continueLatest === true) {
      const latest = [...listSessions(handle)].sort((a, b) => b.updated - a.updated)[0];
      if (latest === undefined) {
        throw new AtelierError("HEADLESS_SESSION", "No conversation to continue.", "The state directory has no active conversations.", "Run `atelier run \"<prompt>\"` once to start one, or drop --continue.");
      }
      sessionId = latest.id;
    }
    if (sessionId !== null) {
      const session = getSession(handle, sessionId);
      if (session === null) {
        throw new AtelierError("HEADLESS_SESSION", "Session not found.", sessionId, "List sessions with `atelier --check`, or omit --session to start a new one.");
      }
    } else {
      sessionId = createSession(handle, prompt.length > 60 ? `${prompt.slice(0, 57)}â€¦` : prompt).id;
    }
    appendMessage(handle, sessionId, "user", attachImages(paths, attachMentionedFiles(workspace, prompt), imageIds), null);
    const run = createRun(handle, sessionId, null, null, workspace);
    const mode = options.mode ?? "plan";
    handle.db.prepare("UPDATE runs SET profile_id = ?, workspace = ? WHERE id = ?").run(mode, workspace, run.id);
    const active = getRun(handle, run.id) ?? run;
    const autoApprove = options.autoApprove === true;
    let lastSeq = listEvents(handle, sessionId).reduce((max, event) => Math.max(max, event.seq), 0);
    const emitNew = (): void => {
      if (options.onEvent === undefined) return;
      for (const event of listEvents(handle, sessionId as string, lastSeq)) {
        lastSeq = event.seq;
        let data: unknown = {};
        try {
          data = JSON.parse(event.data);
        } catch {
          data = { raw: event.data };
        }
        options.onEvent({ seq: event.seq, type: event.type, data });
      }
    };
    const watcher = options.onEvent === undefined ? null : setInterval(emitNew, 50);
    try {
      await executeRun(handle, active.id, {
        ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
        ...(options.maxTurns === undefined ? {} : { maxSteps: options.maxTurns }),
        ...(options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: options.maxBudgetUsd }),
        ...(options.model === undefined ? {} : { model: options.model }),
        approve: (_call, resource, action, explicitAsk) => {
          // --yes approves what the run asks for, except edits of the agent's own configuration and calls a permission
          // rule said to ask about: those need a person.
          if (autoApprove) return !explicitAsk && !(action === "edit" && isProtectedConfigPath(resource));
          throw new AtelierError(
            "HEADLESS_APPROVAL",
            "A tool needed approval, but headless runs have no approver.",
            "Build mode pauses writes and commands for a human decision.",
            "Re-run with `--yes` to approve edits and commands for this run, or use `--mode plan` for a read-only run.",
          );
        },
      });
    } finally {
      if (watcher !== null) clearInterval(watcher);
      emitNew();
    }
    const finished = getRun(handle, active.id) ?? active;
    const steps = listRunSteps(handle, finished.id);
    const tools = steps.filter((step) => step.kind === "tool").length;
    const usage = lastUsage(handle, sessionId, finished.id);
    // --no-session: the answer is the whole point, so a throwaway conversation is not left
    // behind in the list a later `--continue` would pick up.
    if (options.noSession === true) deleteSession(handle, sessionId);
    if (finished.status === "finished") {
      const messages = listMessages(handle, sessionId);
      const last = [...messages].reverse().find((message) => message.role === "assistant");
      return {
        status: "finished",
        text: last?.text ?? "",
        runId: finished.id,
        sessionId,
        mode,
        steps: steps.length,
        tools,
        usage,
      };
    }
    return {
      status: "blocked",
      text: "",
      runId: finished.id,
      sessionId,
      mode,
      reason: finished.error ?? finished.blocked_reason ?? "run did not finish",
      steps: steps.length,
      tools,
      usage,
    };
  } finally {
    handle.close();
  }
}

export function headlessSummary(run: RunRow): string {
  return `${run.id} ${run.status}`;
}
