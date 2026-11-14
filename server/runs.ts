import { randomUUID } from "node:crypto";
import { AtelierError } from "./config.js";
import type { DbHandle } from "./db.js";

export type RunStatus = "running" | "blocked" | "finished" | "error" | "resuming";

export interface RunRow {
  id: string;
  session_id: string;
  status: RunStatus;
  parent_run_id: string | null;
  fork_id: string | null;
  profile_id: string | null;
  blocked_reason: string | null;
  recovery_attempts: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  workspace: string | null;
  created: number;
  updated: number;
}

export interface RunStepRow {
  id: string;
  run_id: string;
  seq: number;
  kind: string;
  status: string;
  input_json: string | null;
  output_ref: string | null;
  created: number;
}

export interface LeaseRow {
  run_id: string;
  owner: string;
  expires_at: number;
  heartbeat_at: number;
}

const RUN_COLUMNS = "id, session_id, status, parent_run_id, fork_id, profile_id, blocked_reason, recovery_attempts, started_at, finished_at, error, workspace, created, updated";

export function appendSessionEvent(handle: DbHandle, sessionId: string, type: string, data: unknown): number {
  const next = handle.db
    .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id = ?")
    .get(sessionId) as { next: number };
  handle.db
    .prepare("INSERT INTO events (id, session_id, seq, type, data, created) VALUES (?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), sessionId, next.next, type, JSON.stringify(data), Date.now());
  return next.next;
}

export function createRun(handle: DbHandle, sessionId: string, parentRunId: string | null = null, forkId: string | null = null, workspace: string = process.cwd()): RunRow {
  const now = Date.now();
  const run: RunRow = {
    id: `run_${randomUUID()}`,
    session_id: sessionId,
    status: "running",
    parent_run_id: parentRunId,
    fork_id: forkId,
    profile_id: null,
    blocked_reason: null,
    recovery_attempts: 0,
    started_at: now,
    finished_at: null,
    error: null,
    workspace,
    created: now,
    updated: now,
  };
  handle.db
    .prepare("INSERT INTO runs (id, session_id, status, parent_run_id, fork_id, profile_id, blocked_reason, recovery_attempts, started_at, finished_at, error, workspace, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(run.id, run.session_id, run.status, run.parent_run_id, run.fork_id, run.profile_id, run.blocked_reason, run.recovery_attempts, run.started_at, run.finished_at, run.error, run.workspace, run.created, run.updated);
  return run;
}

export function getRun(handle: DbHandle, id: string): RunRow | null {
  const row = handle.db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
  return row ?? null;
}

export function listRuns(handle: DbHandle, sessionId: string | null = null): RunRow[] {
  if (sessionId === null) {
    return handle.db.prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY created DESC LIMIT 100`).all() as RunRow[];
  }
  return handle.db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE session_id = ? ORDER BY created DESC`).all(sessionId) as RunRow[];
}

export function markRun(
  handle: DbHandle,
  id: string,
  status: RunStatus,
  fields: { blockedReason?: string | null; error?: string | null; finished?: boolean } = {},
): void {
  const now = Date.now();
  handle.db
    .prepare("UPDATE runs SET status = ?, blocked_reason = ?, error = ?, finished_at = ?, updated = ? WHERE id = ?")
    .run(
      status,
      fields.blockedReason ?? null,
      fields.error ?? null,
      fields.finished === true ? now : null,
      now,
      id,
    );
}

export function claimRunForResume(handle: DbHandle, id: string): boolean {
  const transaction = handle.db.transaction(() => {
    handle.db.prepare("DELETE FROM leases WHERE run_id = ?").run(id);
    const result = handle.db
      .prepare("UPDATE runs SET status = 'running', blocked_reason = NULL, error = NULL, finished_at = NULL, recovery_attempts = recovery_attempts + 1, updated = ? WHERE id = ? AND status = 'blocked'")
      .run(Date.now(), id);
    return result.changes === 1;
  });
  return transaction();
}

export function appendRunStep(handle: DbHandle, runId: string, kind: string, status: string, input: unknown, outputRef: string | null): RunStepRow {
  const next = handle.db
    .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_steps WHERE run_id = ?")
    .get(runId) as { next: number };
  const step: RunStepRow = {
    id: `step_${randomUUID()}`,
    run_id: runId,
    seq: next.next,
    kind,
    status,
    input_json: input === null ? null : JSON.stringify(input),
    output_ref: outputRef,
    created: Date.now(),
  };
  handle.db
    .prepare("INSERT INTO run_steps (id, run_id, seq, kind, status, input_json, output_ref, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(step.id, step.run_id, step.seq, step.kind, step.status, step.input_json, step.output_ref, step.created);
  return step;
}

export function listRunSteps(handle: DbHandle, runId: string): RunStepRow[] {
  return handle.db.prepare("SELECT id, run_id, seq, kind, status, input_json, output_ref, created FROM run_steps WHERE run_id = ? ORDER BY seq ASC").all(runId) as RunStepRow[];
}

export function acquireLease(handle: DbHandle, runId: string, owner: string, ttlMs = 5000): boolean {
  const now = Date.now();
  const transaction = handle.db.transaction(() => {
    handle.db.prepare("DELETE FROM leases WHERE expires_at < ?").run(now);
    const current = handle.db.prepare("SELECT run_id, owner, expires_at, heartbeat_at FROM leases WHERE run_id = ?").get(runId) as LeaseRow | undefined;
    if (current !== undefined && current.owner !== owner && current.expires_at >= now) return false;
    handle.db
      .prepare("INSERT OR REPLACE INTO leases (run_id, owner, expires_at, heartbeat_at) VALUES (?, ?, ?, ?)")
      .run(runId, owner, now + ttlMs, now);
    handle.db.prepare("UPDATE runs SET lease_owner = ?, lease_expires_at = ?, updated = ? WHERE id = ?").run(owner, now + ttlMs, now, runId);
    return true;
  });
  return transaction();
}

export function heartbeatLease(handle: DbHandle, runId: string, owner: string, ttlMs = 5000): boolean {
  const now = Date.now();
  const result = handle.db
    .prepare("UPDATE leases SET expires_at = ?, heartbeat_at = ? WHERE run_id = ? AND owner = ?")
    .run(now + ttlMs, now, runId, owner);
  if (result.changes > 0) handle.db.prepare("UPDATE runs SET lease_expires_at = ? WHERE id = ?").run(now + ttlMs, runId);
  return result.changes > 0;
}

export function releaseLease(handle: DbHandle, runId: string, owner: string): void {
  handle.db.prepare("DELETE FROM leases WHERE run_id = ? AND owner = ?").run(runId, owner);
  handle.db.prepare("UPDATE runs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ?").run(runId);
}

export function createInterrupt(handle: DbHandle, runId: string, kind: string, payload: unknown): string {
  const id = `int_${randomUUID()}`;
  handle.db
    .prepare("INSERT INTO interrupts (id, run_id, kind, payload_json, status, created) VALUES (?, ?, ?, ?, 'pending', ?)")
    .run(id, runId, kind, JSON.stringify(payload), Date.now());
  return id;
}

export function consumeInterrupt(handle: DbHandle, id: string, by: string): boolean {
  const result = handle.db
    .prepare("UPDATE interrupts SET status = 'consumed', consumed_by = ?, consumed_at = ? WHERE id = ? AND status = 'pending'")
    .run(by, Date.now(), id);
  return result.changes === 1;
}

export function insertResumeRequest(handle: DbHandle, runId: string, mode: "retry" | "fork", forkId: string | null): string {
  const id = `res_${randomUUID()}`;
  try {
    handle.db
      .prepare("INSERT INTO resume_requests (id, run_id, mode, fork_id, status, created) VALUES (?, ?, ?, ?, 'accepted', ?)")
      .run(id, runId, mode, forkId, Date.now());
    return id;
  } catch (error) {
    if ((error as Error).message.includes("UNIQUE")) {
      throw new AtelierError("RESUME_CONFLICT", "This resume was already accepted.", `${mode}${forkId === null ? "" : ` fork ${forkId}`} for ${runId}.`, "Use a new forkId or open the existing branch.");
    }
    throw error;
  }
}

export function updateRunStep(handle: DbHandle, stepId: string, status: string, outputRef: string | null): void {
  handle.db.prepare("UPDATE run_steps SET status = ?, output_ref = ? WHERE id = ?").run(status, outputRef, stepId);
}
