import { useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type { UsageSummary } from "./types";

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} ${error.fix}`;
  return error instanceof Error ? error.message : String(error);
}

function money(value: number): string {
  return `$${value.toFixed(6)}`;
}

export default function UsagePanel({ sessionId }: { sessionId: string | null }): React.JSX.Element {
  const [session, setSession] = useState<UsageSummary | null>(null);
  const [global, setGlobal] = useState<UsageSummary | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setRefreshing(true);
    try {
      const [sessionUsage, globalUsage] = await Promise.all([
        sessionId === null ? Promise.resolve(null) : api<UsageSummary>(`/api/usage?session=${encodeURIComponent(sessionId)}`),
        api<UsageSummary>("/api/usage"),
      ]);
      setSession(sessionUsage);
      setGlobal(globalUsage);
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void refresh().catch((caught) => setError(messageOf(caught)));
  }, [sessionId]);

  return (
    <div className="usage-panel" data-testid="usage-panel">
      <div className="panel-card">
        <div className="file-head">
          <h2>This conversation</h2>
          <button className="small-button" type="button" onClick={() => void refresh()} disabled={refreshing} data-testid="usage-refresh">{refreshing ? "Refreshing…" : "Refresh"}</button>
        </div>
        {sessionId === null ? (
          <p className="provider-meta">Select a conversation to see its usage.</p>
        ) : session === null ? (
          <p className="provider-meta">Loading…</p>
        ) : (
          <ul className="panel-list">
            <li><span>requests</span><span data-testid="usage-session-requests">{session.requests}</span></li>
            <li><span>memo replays</span><span data-testid="usage-session-replays">{session.replays}</span></li>
            <li><span>prompt tokens</span><span data-testid="usage-session-prompt">{session.promptTokens}</span></li>
            <li><span>completion tokens</span><span data-testid="usage-session-completion">{session.completionTokens}</span></li>
            <li><span>cost (estimated)</span><span data-testid="usage-session-cost">{money(session.costUsd)}</span></li>
            {(session.delegated?.requests ?? 0) > 0 ? <li><span>of which sub-agents</span><span data-testid="usage-session-delegated">{session.delegated?.requests} requests · {money(session.delegated?.costUsd ?? 0)}</span></li> : null}
            {session.unpricedRequests > 0 ? <li><span>unpriced requests</span><span data-testid="usage-session-unpriced">{session.unpricedRequests}</span></li> : null}
          </ul>
        )}
      </div>

      <div className="panel-card">
        <h2>All conversations</h2>
        <ul className="panel-list">
          <li><span>requests</span><span data-testid="usage-global-requests">{global?.requests ?? 0}</span></li>
          <li><span>memo replays</span><span data-testid="usage-global-replays">{global?.replays ?? 0}</span></li>
          <li><span>prompt tokens</span><span data-testid="usage-global-prompt">{global?.promptTokens ?? 0}</span></li>
          <li><span>completion tokens</span><span data-testid="usage-global-completion">{global?.completionTokens ?? 0}</span></li>
          <li><span>cost (estimated)</span><span data-testid="usage-global-cost">{money(global?.costUsd ?? 0)}</span></li>
        </ul>
        <ul className="provider-list" data-testid="usage-models">
          {(global?.byModel ?? []).length === 0 ? <li className="provider-row" data-testid="usage-empty"><span className="provider-meta">No provider usage recorded yet.</span></li> : null}
          {(global?.byModel ?? []).map((entry) => (
            <li className="provider-row" key={`${entry.providerId}/${entry.model}`} data-testid="usage-model">
              <span>{entry.model}</span>
              <span className="provider-meta">{entry.requests} req · {entry.promptTokens} in · {entry.completionTokens} out · {money(entry.costUsd)}</span>
            </li>
          ))}
        </ul>
      </div>

      {error !== null ? <div className="banner-error" role="alert" data-testid="usage-error">{error}</div> : null}
    </div>
  );
}
