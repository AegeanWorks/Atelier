import { randomUUID } from "node:crypto";
import { AtelierError } from "./config.js";
import type { DbHandle } from "./db.js";
import { appendSessionEvent, type RunRow } from "./runs.js";

export type ApprovalDecision = "approved" | "denied" | "expired";
export type ApprovalVerdict = "allow" | "deny";

export interface ApprovalRow {
  id: string;
  run_id: string;
  session_id: string;
  call_id: string;
  tool: string;
  action: string;
  resource: string;
  reason: string;
  preview: string | null;
  status: ApprovalDecision | "pending";
  decision_reason: string | null;
  created: number;
  resolved: number | null;
}

const APPROVAL_TIMEOUT_MS = 60_000;
const POLL_MS = 100;

function readRow(handle: DbHandle, id: string): ApprovalRow | null {
  return (handle.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined) ?? null;
}

export function listApprovals(handle: DbHandle, filter: { runId?: string; sessionId?: string; pendingOnly?: boolean }): ApprovalRow[] {
  const clauses: string[] = [];
  const args: string[] = [];
  if (filter.runId !== undefined) {
    clauses.push("run_id = ?");
    args.push(filter.runId);
  }
  if (filter.sessionId !== undefined) {
    clauses.push("session_id = ?");
    args.push(filter.sessionId);
  }
  if (filter.pendingOnly === true) clauses.push("status = 'pending'");
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  return handle.db.prepare(`SELECT * FROM approvals${where} ORDER BY created DESC LIMIT 50`).all(...args) as ApprovalRow[];
}

export function resolveApproval(handle: DbHandle, id: string, decision: ApprovalVerdict, reason: string, expectedRunId?: string): ApprovalRow {
  const current = readRow(handle, id);
  if (current === null) throw new AtelierError("APPROVAL_NOT_FOUND", "Approval not found.", id, "Refresh the run.");
  if (expectedRunId !== undefined && current.run_id !== expectedRunId) throw new AtelierError("APPROVAL_NOT_FOUND", "Approval does not belong to this run.", id, "Refresh the run.");
  const status: ApprovalDecision = decision === "allow" ? "approved" : "denied";
  const resolved = Date.now();
  const transaction = handle.db.transaction(() => {
    handle.db.prepare("UPDATE approvals SET status = ?, decision_reason = ?, resolved = ? WHERE id = ? AND status = 'pending'").run(status, reason, resolved, id);
    appendSessionEvent(handle, current.session_id, "approval.resolved", {
      approvalId: id,
      runId: current.run_id,
      decision: status,
      reason,
    });
  });
  transaction();
  return readRow(handle, id) ?? current;
}

export async function requestApproval(
  handle: DbHandle,
  run: RunRow,
  call: { id: string; name: string },
  action: string,
  resource: string,
  reason: string,
  signal: AbortSignal,
  timeoutMs = APPROVAL_TIMEOUT_MS,
  preview: string | null = null,
): Promise<{ verdict: ApprovalVerdict; approvalId: string; reason: string }> {
  const id = `approval_${randomUUID()}`;
  const created = Date.now();
  handle.db
    .prepare("INSERT INTO approvals (id, run_id, session_id, call_id, tool, action, resource, reason, preview, status, decision_reason, created, resolved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)")
    .run(id, run.id, run.session_id, call.id, call.name, action, resource, reason, preview ?? null, created);
  appendSessionEvent(handle, run.session_id, "approval.request", {
    approvalId: id,
    runId: run.id,
    callId: call.id,
    tool: call.name,
    action,
    resource,
    reason,
    preview,
  });
  const deadline = created + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) break;
    const row = readRow(handle, id);
    if (row !== null && row.status !== "pending") {
      return { verdict: row.status === "approved" ? "allow" : "deny", approvalId: id, reason: row.decision_reason ?? row.status };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const status: ApprovalDecision = "expired";
  const why = signal.aborted ? "run stopped while awaiting approval" : "approval timed out";
  handle.db.prepare("UPDATE approvals SET status = ?, decision_reason = ?, resolved = ? WHERE id = ? AND status = 'pending'").run(status, why, Date.now(), id);
  appendSessionEvent(handle, run.session_id, "approval.resolved", { approvalId: id, runId: run.id, decision: status, reason: why });
  return { verdict: "deny", approvalId: id, reason: why };
}
