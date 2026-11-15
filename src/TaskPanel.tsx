import { useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type { AuditReport, Run, RunDetail } from "./types";

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} ${error.fix}`;
  return error instanceof Error ? error.message : String(error);
}

function stamp(value: number | null): string {
  return value === null ? "—" : new Date(value).toLocaleTimeString();
}

function statusClass(status: string): string {
  if (status === "finished" || status === "done") return "status-ok";
  if (status === "blocked" || status === "failed" || status === "error") return "status-bad";
  return "status-warn";
}

export default function TaskPanel({ sessionId, refreshTick }: { sessionId: string | null; refreshTick: number }): React.JSX.Element {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [audit, setAudit] = useState<AuditReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);

  async function loadRuns(): Promise<void> {
    if (sessionId === null) {
      setRuns([]);
      setSelectedId(null);
      return;
    }
    const data = await api<{ runs: Run[] }>(`/api/runs?session=${encodeURIComponent(sessionId)}`);
    setRuns(data.runs);
    setSelectedId((current) => (current !== null && data.runs.some((run) => run.id === current) ? current : data.runs[0]?.id ?? null));
    setError(null);
  }

  useEffect(() => {
    void loadRuns().catch((caught) => setError(messageOf(caught)));
  }, [sessionId, refreshTick, tick]);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      setAudit(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [runDetail, report] = await Promise.all([
          api<RunDetail>(`/api/runs/${encodeURIComponent(selectedId)}`),
          api<AuditReport>(`/api/audit/${encodeURIComponent(selectedId)}`),
        ]);
        if (!cancelled) {
          setDetail(runDetail);
          setAudit(report);
        }
      } catch (caught) {
        if (!cancelled) setError(messageOf(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, refreshTick, tick]);

  const selected = runs.find((run) => run.id === selectedId) ?? detail?.run ?? null;

  async function act(path: string, body?: unknown): Promise<void> {
    setBusy(true);
    try {
      await api(path, body === undefined ? { method: "POST" } : { method: "POST", body: JSON.stringify(body) });
      await loadRuns();
      setTick((value) => value + 1);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  function refresh(): void {
    setTick((value) => value + 1);
  }

  return (
    <div className="task-panel" data-testid="task-panel">
      <div className="panel-card">
        <div className="file-head">
          <h2>Runs</h2>
          <button className="small-button" type="button" onClick={refresh} data-testid="task-refresh">Refresh</button>
        </div>
        {sessionId === null ? (
          <p className="provider-meta">Select a conversation to inspect its runs.</p>
        ) : runs.length === 0 ? (
          <p className="provider-meta" data-testid="task-empty">No runs yet. Send a message or run a plan.</p>
        ) : (
          <ul className="provider-list" data-testid="run-list">
            {runs.map((run) => (
              <li className="provider-row" key={run.id}>
                <button
                  className={selectedId === run.id ? "file-item active" : "file-item"}
                  type="button"
                  onClick={() => setSelectedId(run.id)}
                  data-testid="run-item"
                >
                  {run.profile_id ?? "run"} · {run.id.slice(0, 12)}
                </button>
                <span className={statusClass(run.status)}>{run.status}</span>
                <span className="provider-meta">{stamp(run.created)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected !== null ? (
        <div className="panel-card" data-testid="run-detail">
          <div className="file-head">
            <h2>Run {selected.id.slice(0, 14)}</h2>
            <span className="provider-meta" data-testid="run-status">{selected.status}</span>
          </div>
          <ul className="panel-list">
            <li><span>profile</span><span>{selected.profile_id ?? "—"}</span></li>
            <li><span>workspace</span><span>{selected.workspace ?? "—"}</span></li>
            <li><span>started</span><span>{stamp(selected.started_at)}</span></li>
            <li><span>finished</span><span>{stamp(selected.finished_at)}</span></li>
            {selected.blocked_reason !== null ? <li><span>blocked</span><span data-testid="run-blocked-reason">{selected.blocked_reason}</span></li> : null}
            {selected.error !== null ? <li><span>error</span><span>{selected.error}</span></li> : null}
          </ul>
          <div className="file-create">
            {selected.status === "blocked" ? (
              <button className="small-button" type="button" disabled={busy} onClick={() => void act(`/api/runs/${selected.id}/resume`, { mode: "retry" })} data-testid="run-retry">
                Retry
              </button>
            ) : null}
            <button
              className="small-button"
              type="button"
              disabled={busy}
              onClick={() => void act(`/api/runs/${selected.id}/resume`, { mode: "fork", forkId: `fork-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })}
              data-testid="run-fork"
            >
              Fork
            </button>
            {selected.status === "running" ? (
              <button className="small-button danger" type="button" disabled={busy} onClick={() => void act(`/api/sessions/${selected.session_id}/stop`)} data-testid="run-stop">
                Stop
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {detail !== null && detail.steps.length > 0 ? (
        <div className="panel-card">
          <h2>Steps</h2>
          <ul className="provider-list" data-testid="run-steps">
            {detail.steps.map((step) => (
              <li className="provider-row" key={step.id} data-testid="run-step">
                <span>{step.seq}. {step.kind}</span>
                <span className={statusClass(step.status)}>{step.status}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {audit !== null ? (
        <div className="panel-card" data-testid="run-audit">
          <h2>Audit</h2>
          <p className={audit.clean ? "status-ok" : "status-bad"}>{audit.clean ? "clean" : `${audit.findings.length} finding(s)`}</p>
          <ul className="provider-list">
            {audit.findings.map((finding) => (
              <li className="provider-row" key={`${finding.level}-${finding.code}`} data-testid="run-audit-finding">
                <span>{finding.level} {finding.code}</span>
                <span className="provider-meta">{finding.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error !== null ? <div className="banner-error" role="alert" data-testid="task-error">{error}</div> : null}
    </div>
  );
}
