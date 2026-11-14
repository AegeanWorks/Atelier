import { existsSync } from "node:fs";
import type { DbHandle } from "./db.js";
import { listRunSteps } from "./runs.js";

export interface AuditFinding {
  level: "L1" | "L2" | "L3";
  code: string;
  message: string;
}

export interface AuditReport {
  runId: string;
  clean: boolean;
  findings: AuditFinding[];
}

export function auditRun(handle: DbHandle, runId: string): AuditReport {
  const findings: AuditFinding[] = [];
  const run = handle.db.prepare("SELECT id, workspace FROM runs WHERE id = ?").get(runId) as { id: string; workspace: string | null } | undefined;
  if (run === undefined) return { runId, clean: false, findings: [{ level: "L1", code: "RUN_MISSING", message: "run does not exist" }] };
  const events = handle.db
    .prepare("SELECT type, data FROM events WHERE session_id = (SELECT session_id FROM runs WHERE id = ?) ORDER BY seq ASC")
    .all(runId) as Array<{ type: string; data: string }>;
  const decisions = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "access.decision") continue;
    const data = JSON.parse(event.data) as { callId?: string; decision?: string };
    if (typeof data.callId === "string" && typeof data.decision === "string") decisions.set(data.callId, data.decision);
  }
  for (const event of events) {
    if (event.type !== "tool.result") continue;
    const data = JSON.parse(event.data) as { callId?: string; ok?: boolean };
    if (typeof data.callId !== "string") continue;
    const decision = decisions.get(data.callId);
    if (decision === undefined) findings.push({ level: "L1", code: "MISSING_DECISION", message: `tool ${data.callId} ran without an access decision` });
    if (decision === "deny" && data.ok === true) findings.push({ level: "L1", code: "DENIED_RAN", message: `denied tool ${data.callId} reported success` });
  }
  const pending = handle.db.prepare("SELECT COUNT(*) AS n FROM effects WHERE run_id = ? AND status IN ('intent', 'unknown')").get(runId) as { n: number };
  if (pending.n > 0) findings.push({ level: "L2", code: "UNSETTLED_EFFECT", message: `${pending.n} effect(s) are not settled` });
  const failed = listRunSteps(handle, runId).filter((step) => step.status === "failed");
  if (failed.length > 0) findings.push({ level: "L2", code: "FAILED_STEP", message: `${failed.length} run step(s) failed` });
  if (!existsSync(run.workspace ?? "")) findings.push({ level: "L3", code: "WORKSPACE_MISSING", message: "workspace no longer exists" });
  return { runId, clean: findings.length === 0, findings };
}
