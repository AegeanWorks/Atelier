import { randomUUID } from "node:crypto";
import { AtelierError } from "./config.js";
import { runAgent } from "./agent.js";
import { FULL_PROFILE } from "./eval/harness.js";
import { appendMessage, type DbHandle } from "./db.js";
import { catalogFor } from "./providers/catalog.js";
import { createPlan } from "./plans.js";
import { loadConfig, loadSecrets } from "./state.js";
import {
  acquireLease,
  appendSessionEvent,
  claimRunForResume,
  createRun,
  getRun,
  heartbeatLease,
  insertResumeRequest,
  markRun,
  releaseLease,
  type RunRow,
} from "./runs.js";

const activeRuns = new Map<string, AbortController>();
const RUN_TIMEOUT_MS = 120_000;
const LEASE_TTL_MS = 5000;

export interface ExecuteOptions {
  /** `explicitAsk` is true when a permission rule said to ask: no automatic approver may say yes to that. */
  approve?: (call: { id: string; name: string; input: unknown }, resource: string, action: string, explicitAsk: boolean) => boolean | Promise<boolean>;
  adapter?: import("./providers/types.js").ProviderAdapter;
  /** Caps the model turns of this run below the profile's default. */
  maxSteps?: number;
  /** Stops the run once its priced spend reaches this many US dollars. */
  maxBudgetUsd?: number;
  /** Runs this one model instead of the configured default, without changing the configuration. */
  model?: string;
}

const inflight = new Set<Promise<void>>();

/** Resolves when every run started in this process has finished unwinding, so a caller may close the database. */
export async function whenRunsSettled(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}

export function executeRun(handle: DbHandle, runId: string, options: ExecuteOptions = {}): Promise<void> {
  const running = runToCompletion(handle, runId, options);
  inflight.add(running);
  const forget = (): void => void inflight.delete(running);
  running.then(forget, forget);
  return running;
}

async function runToCompletion(handle: DbHandle, runId: string, options: ExecuteOptions): Promise<void> {
  const run = getRun(handle, runId);
  if (run === null || run.status === "finished" || run.status === "error") return;
  const owner = `${process.pid}:${randomUUID()}`;
  if (!acquireLease(handle, run.id, owner, LEASE_TTL_MS)) {
    markRun(handle, run.id, "blocked", { blockedReason: "lease_busy" });
    appendSessionEvent(handle, run.session_id, "run.blocked", { runId: run.id, reason: "lease_busy" });
    return;
  }
  const heartbeat = setInterval(() => heartbeatLease(handle, run.id, owner, LEASE_TTL_MS), 1000);
  heartbeat.unref();
  const controller = new AbortController();
  activeRuns.set(run.id, controller);
  const timeout = setTimeout(() => controller.abort(new Error("timeout")), RUN_TIMEOUT_MS);
  try {
    const config = loadConfig(handle.paths);
    const secrets = loadSecrets(handle.paths);
    const providerId = config.defaults.provider ?? config.providers[0]?.id ?? null;
    if (providerId === null) {
      markRun(handle, run.id, "blocked", { blockedReason: "no_provider" });
      appendSessionEvent(handle, run.session_id, "run.blocked", { runId: run.id, reason: "no_provider" });
      return;
    }
    const provider = config.providers.find((entry) => entry.id === providerId);
    if (provider === undefined) {
      markRun(handle, run.id, "blocked", { blockedReason: "provider_missing" });
      appendSessionEvent(handle, run.session_id, "run.blocked", { runId: run.id, reason: "provider_missing" });
      return;
    }
    // A per-run override wins over the configured default, but only for this run: nothing on
    // disk changes, so the next run is back on the default model.
    const model = options.model ?? config.defaults.model ?? provider.defaultModel ?? catalogFor(provider)[0]?.id;
    if (model === undefined) {
      markRun(handle, run.id, "blocked", { blockedReason: "no_model" });
      appendSessionEvent(handle, run.session_id, "run.blocked", { runId: run.id, reason: "no_model" });
      return;
    }
    appendSessionEvent(handle, run.session_id, "run.started", { runId: run.id, providerId, model, mode: run.profile_id ?? "build" });
    const outcome = await runAgent(handle, config, secrets, run, providerId, model, controller.signal, {
      ...(options.approve === undefined ? {} : { approve: options.approve }),
      ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
      ...(options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: options.maxBudgetUsd }),
      ...(options.maxSteps === undefined ? {} : { profile: { ...FULL_PROFILE, maxSteps: options.maxSteps } }),
    });
    if (outcome.status === "finished") {
      const message = appendMessage(handle, run.session_id, "assistant", outcome.text, null);
      if (run.profile_id === "plan") {
        createPlan(handle, { sessionId: run.session_id, body: outcome.text, status: "draft", sourceRunId: run.id });
      }
      markRun(handle, run.id, "finished", { finished: true });
      appendSessionEvent(handle, run.session_id, "run.finished", {
        runId: run.id,
        status: "ok",
        messageId: message.id,
        text: outcome.text,
        requestHash: outcome.requestHash,
        providerId: outcome.providerId,
      });
      return;
    }
    // A stop request already marked the run blocked; keep that reason instead of reporting the
    // generic agent_blocked the loop returns when its signal is aborted.
    const stopped = controller.signal.aborted && controller.signal.reason instanceof Error && controller.signal.reason.message === "stopped";
    if (stopped) {
      markRun(handle, run.id, "blocked", { blockedReason: "stopped", error: "stopped" });
      return;
    }
    markRun(handle, run.id, "blocked", { blockedReason: "agent_blocked", error: outcome.reason });
    appendSessionEvent(handle, run.session_id, "run.blocked", { runId: run.id, reason: outcome.reason ?? "agent blocked", requestHash: outcome.requestHash });
  } catch (error) {
    const reason = error instanceof AtelierError ? error.message : error instanceof Error ? error.message : String(error);
    markRun(handle, run.id, "blocked", { blockedReason: "exception", error: reason });
    appendSessionEvent(handle, run.session_id, "run.blocked", { runId: run.id, reason });
  } finally {
    activeRuns.delete(run.id);
    clearTimeout(timeout);
    clearInterval(heartbeat);
    releaseLease(handle, run.id, owner);
  }
}

export function startSessionRun(
  handle: DbHandle,
  sessionId: string,
  prompt: string,
  clientId: string | null,
  workspace: string = process.cwd(),
  mode: "plan" | "build" = "build",
): { run: RunRow; message: ReturnType<typeof appendMessage> } {
  const active = handle.db
    .prepare("SELECT id FROM runs WHERE session_id = ? AND status = 'running' LIMIT 1")
    .get(sessionId) as { id: string } | undefined;
  if (active !== undefined) {
    throw new AtelierError(
      "RUN_ACTIVE",
      "This conversation already has a running run.",
      `${active.id} is still running.`,
      "Stop the run or wait for it to finish, then send again.",
    );
  }
  const message = appendMessage(handle, sessionId, "user", prompt, clientId);
  const run = createRun(handle, sessionId, null, null, workspace);
  handle.db.prepare("UPDATE runs SET profile_id = ?, workspace = ? WHERE id = ?").run(mode, workspace, run.id);
  const updated = getRun(handle, run.id) ?? run;
  void executeRun(handle, run.id);
  return { run: updated, message };
}

export function resumeRun(
  handle: DbHandle,
  runId: string,
  mode: "retry" | "fork",
  forkId: string | null,
): { run: RunRow; mode: "retry" | "fork" } {
  const original = getRun(handle, runId);
  if (original === null) throw new AtelierError("RUN_NOT_FOUND", "Run not found.", runId, "Refresh the recovery panel.");
  if (mode === "retry") {
    if (!claimRunForResume(handle, runId)) {
      throw new AtelierError("RESUME_CONFLICT", "This run is not blocked.", `${runId} is ${original.status}.`, "Refresh the recovery panel.");
    }
    insertResumeRequest(handle, runId, "retry", null);
    appendSessionEvent(handle, original.session_id, "run.resumed", { runId, mode: "retry" });
    void executeRun(handle, runId);
    return { run: getRun(handle, runId) ?? original, mode };
  }
  if (forkId === null || forkId.trim().length === 0) {
    throw new AtelierError("RESUME_FORK", "Fork needs a forkId.", "The fork discriminator was empty.", "Send a unique forkId.");
  }
  insertResumeRequest(handle, runId, "fork", forkId);
  const fork = createRun(handle, original.session_id, runId, forkId, original.workspace ?? process.cwd());
  handle.db.prepare("UPDATE runs SET profile_id = ? WHERE id = ?").run(original.profile_id ?? "build", fork.id);
  appendSessionEvent(handle, original.session_id, "run.forked", { runId: fork.id, parentRunId: runId, forkId });
  void executeRun(handle, fork.id);
  return { run: getRun(handle, fork.id) ?? fork, mode };
}

export function stopSessionRun(handle: DbHandle, sessionId: string): RunRow | null {
  const running = handle.db
    .prepare("SELECT id FROM runs WHERE session_id = ? AND status = 'running' ORDER BY created DESC LIMIT 1")
    .get(sessionId) as { id: string } | undefined;
  if (running === undefined) return null;
  activeRuns.get(running.id)?.abort(new Error("stopped"));
  markRun(handle, running.id, "blocked", { blockedReason: "stopped" });
  appendSessionEvent(handle, sessionId, "run.blocked", { runId: running.id, reason: "stopped" });
  return getRun(handle, running.id);
}
