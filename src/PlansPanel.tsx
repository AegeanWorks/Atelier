import { useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type { Plan, PlanRevision, PlanStatus } from "./types";

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} ${error.fix}`;
  return error instanceof Error ? error.message : String(error);
}

const STATUS_LABEL: Record<PlanStatus, string> = {
  draft: "draft",
  active: "active",
  done: "done",
  archived: "archived",
};

export default function PlansPanel({ sessionId, refreshTick }: { sessionId: string | null; refreshTick: number }): React.JSX.Element {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [revisions, setRevisions] = useState<PlanRevision[]>([]);
  const [revisionPreview, setRevisionPreview] = useState<PlanRevision | null>(null);
  const [revisionTick, setRevisionTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    if (sessionId === null) {
      setPlans([]);
      setSelectedId(null);
      return;
    }
    setRefreshing(true);
    try {
      const data = await api<{ plans: Plan[] }>(`/api/plans?session=${encodeURIComponent(sessionId)}`);
      setPlans(data.plans);
      setSelectedId((current) => (current !== null && data.plans.some((plan) => plan.id === current) ? current : data.plans[0]?.id ?? null));
      setError(null);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void refresh().catch((caught) => setError(messageOf(caught)));
  }, [sessionId, refreshTick]);

  useEffect(() => {
    setConfirmingDelete(false);
  }, [selectedId, editing]);

  useEffect(() => {
    if (selectedId === null) {
      setRevisions([]);
      setRevisionPreview(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const data = await api<{ revisions: PlanRevision[] }>(`/api/plans/${encodeURIComponent(selectedId)}/revisions`);
        if (cancelled) return;
        setRevisions(data.revisions);
        setRevisionPreview((current) => data.revisions.find((revision) => revision.id === current?.id) ?? data.revisions[0] ?? null);
      } catch (caught) {
        if (!cancelled) setError(messageOf(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, refreshTick, revisionTick]);

  const selected = plans.find((plan) => plan.id === selectedId) ?? null;

  async function create(): Promise<void> {
    if (sessionId === null || body.trim().length === 0) return;
    setCreating(true);
    try {
      await api<{ plan: Plan }>("/api/plans", {
        method: "POST",
        body: JSON.stringify({ sessionId, title: title.trim() || undefined, body }),
      });
      setTitle("");
      setBody("");
      await refresh();
      setRevisionTick((tick) => tick + 1);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setCreating(false);
    }
  }

  async function save(): Promise<void> {
    if (selected === null || editBody.trim().length === 0) return;
    try {
      await api<{ plan: Plan }>(`/api/plans/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: editTitle.trim() || undefined, body: editBody }),
      });
      setEditing(false);
      await refresh();
      setRevisionTick((tick) => tick + 1);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function setStatus(status: PlanStatus): Promise<void> {
    if (selected === null) return;
    try {
      await api<{ plan: Plan }>(`/api/plans/${selected.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      await refresh();
      setRevisionTick((tick) => tick + 1);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function remove(): Promise<void> {
    if (selected === null) return;
    try {
      await api<{ ok: boolean }>(`/api/plans/${selected.id}`, { method: "DELETE" });
      await refresh();
      setRevisionTick((tick) => tick + 1);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function restoreRevision(revision: PlanRevision): Promise<void> {
    if (selected === null) return;
    try {
      await api<{ plan: Plan }>(`/api/plans/${selected.id}/revisions/${revision.id}/restore`, { method: "POST" });
      await refresh();
      setRevisionTick((tick) => tick + 1);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  return (
    <div className="plans-panel" data-testid="plans-panel">
      <div className="panel-card">
        <div className="file-head">
          <h2>Plans</h2>
          <button className="small-button" type="button" onClick={() => void refresh().catch((caught) => setError(messageOf(caught)))} disabled={refreshing} data-testid="plans-refresh">
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {sessionId === null ? (
          <p className="provider-meta">Select a conversation to manage its plans.</p>
        ) : plans.length === 0 ? (
          <p className="provider-meta" data-testid="plans-empty">No plans yet. A plan-mode run saves one automatically, or create one below.</p>
        ) : (
          <ul className="provider-list" data-testid="plan-list">
            {plans.map((plan) => (
              <li className="provider-row" key={plan.id}>
                <button
                  className={selectedId === plan.id ? "file-item active" : "file-item"}
                  type="button"
                  onClick={() => {
                    setSelectedId(plan.id);
                    setEditing(false);
                  }}
                  data-testid="plan-item"
                >
                  {plan.title}
                </button>
                <span className="provider-meta" data-testid="plan-status">{STATUS_LABEL[plan.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {sessionId !== null ? (
        <div className="panel-card">
          <h2>New plan</h2>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Plan title (optional)"
            aria-label="Plan title"
            data-testid="plan-title-input"
          />
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="What should happen, step by step?"
            aria-label="Plan body"
            data-testid="plan-body-input"
            rows={5}
          />
          <button className="small-button" type="button" onClick={() => void create()} disabled={creating || body.trim().length === 0} data-testid="plan-create">
            {creating ? "Creating…" : "Create plan"}
          </button>
        </div>
      ) : null}

      {selected !== null ? (
        <div className="panel-card" data-testid="plan-detail">
          <div className="file-head">
            {editing ? (
              <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} aria-label="Plan title" data-testid="plan-title-edit" />
            ) : (
              <h2>{selected.title}</h2>
            )}
            <span className="provider-meta">{STATUS_LABEL[selected.status]}</span>
          </div>
          {editing ? (
            <>
              <textarea value={editBody} onChange={(event) => setEditBody(event.target.value)} aria-label="Plan body" data-testid="plan-body-edit" rows={8} />
              <div className="file-create">
                <button className="small-button" type="button" onClick={() => void save()} data-testid="plan-save">Save</button>
                <button className="small-button" type="button" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              <pre className="plan-body" data-testid="plan-body">{selected.body}</pre>
              <div className="file-create">
                <button
                  className="small-button"
                  type="button"
                  onClick={() => {
                    setEditing(true);
                    setEditTitle(selected.title);
                    setEditBody(selected.body);
                  }}
                  data-testid="plan-edit"
                >
                  Edit
                </button>
                <button className="small-button" type="button" onClick={() => void setStatus("active")} data-testid="plan-activate">Activate</button>
                <button className="small-button" type="button" onClick={() => void setStatus("done")} data-testid="plan-done">Mark done</button>
                <button className="small-button" type="button" onClick={() => void setStatus("archived")} data-testid="plan-archive">Archive</button>
                <button
                  className="small-button danger"
                  type="button"
                  onClick={() => {
                    if (confirmingDelete) {
                      void remove();
                      setConfirmingDelete(false);
                    } else {
                      setConfirmingDelete(true);
                    }
                  }}
                  data-testid={confirmingDelete ? "plan-delete-confirm" : "plan-delete"}
                >
                  {confirmingDelete ? "Delete?" : "Delete"}
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {selected !== null && revisions.length > 0 ? (
        <div className="panel-card" data-testid="plan-history">
          <h2>History</h2>
          <ul className="provider-list">
            {revisions.map((revision) => (
              <li className="provider-row" key={revision.id}>
                <button className="file-item" type="button" onClick={() => setRevisionPreview(revision)} data-testid="plan-revision">
                  {new Date(revision.created).toLocaleString()} · {STATUS_LABEL[revision.status]}
                </button>
              </li>
            ))}
          </ul>
          {revisionPreview !== null ? (
            <>
              <pre className="plan-body" data-testid="plan-revision-body">{revisionPreview.body}</pre>
              <div className="file-create">
                <button className="small-button" type="button" onClick={() => void restoreRevision(revisionPreview)} data-testid="plan-revision-restore">
                  Restore this version
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {error !== null ? <div className="banner-error" role="alert" data-testid="plans-error">{error}</div> : null}
    </div>
  );
}
