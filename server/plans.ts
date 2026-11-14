import { randomUUID } from "node:crypto";
import { AtelierError } from "./config.js";
import type { DbHandle } from "./db.js";
import { appendSessionEvent } from "./runs.js";

export const PLAN_STATUSES = ["draft", "active", "done", "archived"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface PlanRow {
  id: string;
  session_id: string;
  title: string;
  body: string;
  status: PlanStatus;
  source_run_id: string | null;
  created: number;
  updated: number;
}

export interface PlanRevisionRow {
  id: string;
  plan_id: string;
  title: string;
  body: string;
  status: PlanStatus;
  created: number;
}

const PLAN_COLUMNS = "id, session_id, title, body, status, source_run_id, created, updated";
const REVISION_COLUMNS = "id, plan_id, title, body, status, created";
const TITLE_LIMIT = 80;

export function isPlanStatus(value: string): value is PlanStatus {
  return (PLAN_STATUSES as readonly string[]).includes(value);
}

export function planTitle(body: string): string {
  const line = body.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.length > 0) ?? "";
  const cleaned = line.replace(/^#{1,6}\s*/, "").replace(/^[-*]\s+/, "").trim();
  const title = cleaned.length === 0 ? "Plan" : cleaned;
  return title.length <= TITLE_LIMIT ? title : `${title.slice(0, TITLE_LIMIT - 3)}...`;
}

export function listPlans(handle: DbHandle, sessionId: string | null): PlanRow[] {
  if (sessionId === null) {
    return handle.db.prepare(`SELECT ${PLAN_COLUMNS} FROM plans ORDER BY updated DESC LIMIT 100`).all() as PlanRow[];
  }
  return handle.db.prepare(`SELECT ${PLAN_COLUMNS} FROM plans WHERE session_id = ? ORDER BY updated DESC`).all(sessionId) as PlanRow[];
}

export function getPlan(handle: DbHandle, id: string): PlanRow | null {
  return (handle.db.prepare(`SELECT ${PLAN_COLUMNS} FROM plans WHERE id = ?`).get(id) as PlanRow | undefined) ?? null;
}

export function createPlan(
  handle: DbHandle,
  input: { sessionId: string; title?: string | undefined; body: string; status?: PlanStatus | undefined; sourceRunId?: string | null | undefined },
): PlanRow {
  const now = Date.now();
  const plan: PlanRow = {
    id: `plan_${randomUUID()}`,
    session_id: input.sessionId,
    title: (input.title ?? "").trim() || planTitle(input.body),
    body: input.body,
    status: input.status ?? "draft",
    source_run_id: input.sourceRunId ?? null,
    created: now,
    updated: now,
  };
  const transaction = handle.db.transaction(() => {
    handle.db
      .prepare(`INSERT INTO plans (${PLAN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(plan.id, plan.session_id, plan.title, plan.body, plan.status, plan.source_run_id, plan.created, plan.updated);
    const revision = insertRevision(handle, plan, now);
    appendSessionEvent(handle, plan.session_id, "plan.created", {
      planId: plan.id,
      revisionId: revision.id,
      title: plan.title,
      status: plan.status,
      sourceRunId: plan.source_run_id,
    });
  });
  transaction();
  return plan;
}

export function updatePlan(
  handle: DbHandle,
  id: string,
  patch: { title?: string | undefined; body?: string | undefined; status?: PlanStatus | undefined },
): PlanRow {
  const current = getPlan(handle, id);
  if (current === null) throw new AtelierError("NOT_FOUND", "Plan not found.", id, "Refresh the plan list.");
  const body = patch.body ?? current.body;
  const title = (patch.title ?? current.title).trim() || planTitle(body);
  const status = patch.status ?? current.status;
  const updated = Date.now();
  const next: PlanRow = { ...current, title, body, status, updated };
  const transaction = handle.db.transaction(() => {
    handle.db.prepare("UPDATE plans SET title = ?, body = ?, status = ?, updated = ? WHERE id = ?").run(title, body, status, updated, id);
    const revision = insertRevision(handle, next, updated);
    appendSessionEvent(handle, current.session_id, "plan.updated", { planId: id, revisionId: revision.id, title, status });
  });
  transaction();
  return next;
}

function insertRevision(handle: DbHandle, plan: PlanRow, created: number): PlanRevisionRow {
  const revision: PlanRevisionRow = {
    id: `rev_${randomUUID()}`,
    plan_id: plan.id,
    title: plan.title,
    body: plan.body,
    status: plan.status,
    created,
  };
  handle.db
    .prepare(`INSERT INTO plan_revisions (${REVISION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(revision.id, revision.plan_id, revision.title, revision.body, revision.status, revision.created);
  return revision;
}

export function listPlanRevisions(handle: DbHandle, planId: string): PlanRevisionRow[] {
  return handle.db
    .prepare(`SELECT ${REVISION_COLUMNS} FROM plan_revisions WHERE plan_id = ? ORDER BY created DESC, rowid DESC LIMIT 50`)
    .all(planId) as PlanRevisionRow[];
}

export function getPlanRevision(handle: DbHandle, planId: string, revisionId: string): PlanRevisionRow | null {
  return (handle.db.prepare(`SELECT ${REVISION_COLUMNS} FROM plan_revisions WHERE plan_id = ? AND id = ?`).get(planId, revisionId) as PlanRevisionRow | undefined) ?? null;
}

export function restorePlanRevision(handle: DbHandle, planId: string, revisionId: string): PlanRow {
  const revision = getPlanRevision(handle, planId, revisionId);
  if (revision === null) throw new AtelierError("NOT_FOUND", "Plan revision not found.", revisionId, "Refresh the plan history.");
  return updatePlan(handle, planId, { title: revision.title, body: revision.body });
}

export function deletePlan(handle: DbHandle, id: string): void {
  const current = getPlan(handle, id);
  if (current === null) throw new AtelierError("NOT_FOUND", "Plan not found.", id, "Refresh the plan list.");
  const transaction = handle.db.transaction(() => {
    handle.db.prepare("DELETE FROM plans WHERE id = ?").run(id);
    appendSessionEvent(handle, current.session_id, "plan.deleted", { planId: id });
  });
  transaction();
}
