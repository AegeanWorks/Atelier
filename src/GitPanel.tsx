import { useEffect, useState } from "react";
import { api, ApiError } from "./api";

interface GitChange {
  status: string;
  index: string;
  worktree: string;
  path: string;
}

interface GitStatus {
  branch: string;
  changes: GitChange[];
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} ${error.fix}`;
  return error instanceof Error ? error.message : String(error);
}

function isStaged(change: GitChange): boolean {
  return change.index !== " " && change.index !== "?";
}

function hasWorktreeChange(change: GitChange): boolean {
  return change.worktree !== " ";
}

function codeLetter(column: string): string {
  return column === " " ? "·" : column;
}

export default function GitPanel(): React.JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [diff, setDiff] = useState("");
  const [diffStaged, setDiffStaged] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    const data = await api<GitStatus>("/api/git/status");
    setStatus(data);
  }

  useEffect(() => {
    void refresh().catch((caught) => setError(messageOf(caught)));
  }, []);

  const changes = status?.changes ?? [];
  const stagedCount = changes.filter(isStaged).length;
  const worktreeCount = changes.filter(hasWorktreeChange).length;

  async function showDiff(change: GitChange): Promise<void> {
    const staged = isStaged(change) && !hasWorktreeChange(change);
    try {
      const data = await api<{ diff: string }>(
        `/api/git/diff?path=${encodeURIComponent(change.path)}${staged ? "&staged=1" : ""}`,
      );
      setSelected(change.path);
      setDiff(data.diff);
      setDiffStaged(staged);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function stage(path: string): Promise<void> {
    try {
      const data = await api<{ status: GitStatus }>("/api/git/stage", { method: "POST", body: JSON.stringify({ path }) });
      setStatus(data.status);
      setNotice(`Staged ${path}.`);
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function unstage(path: string): Promise<void> {
    try {
      const data = await api<{ status: GitStatus }>("/api/git/unstage", { method: "POST", body: JSON.stringify({ path }) });
      setStatus(data.status);
      setNotice(`Unstaged ${path}.`);
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function stageAll(): Promise<void> {
    const pending = changes.filter(hasWorktreeChange).map((change) => change.path);
    if (pending.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const path of pending) {
        await api("/api/git/stage", { method: "POST", body: JSON.stringify({ path }) });
      }
      await refresh();
      setNotice(`Staged ${pending.length} file${pending.length === 1 ? "" : "s"}.`);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function commit(): Promise<void> {
    setBusy(true);
    try {
      const data = await api<{ output: string; status: GitStatus }>("/api/git/commit", { method: "POST", body: JSON.stringify({ message }) });
      setStatus(data.status);
      setMessage("");
      setDiff("");
      setSelected(null);
      setNotice(data.output.trim().split(/\r?\n/)[0] ?? "Committed.");
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="git-panel" data-testid="git-panel">
      <div className="panel-card">
        <div className="file-head">
          <h2>Git · {status?.branch ?? "unknown"}</h2>
          <button className="small-button" type="button" onClick={() => void refresh()} data-testid="git-refresh">Refresh</button>
          <button className="small-button" type="button" onClick={() => void stageAll()} disabled={busy || worktreeCount === 0} data-testid="git-stage-all">
            Stage all
          </button>
        </div>
        <p className="git-legend">index · worktree · {stagedCount} staged of {changes.length} change(s)</p>
        {status === null || changes.length === 0 ? <p>No working-tree changes.</p> : null}
        <ul className="file-tree" data-testid="git-status">
          {changes.map((change) => (
            <li key={change.path} className="git-change">
              <button type="button" className="file-item" onClick={() => void showDiff(change)} data-testid="git-file">
                <span className="git-code" title="index / worktree">
                  {codeLetter(change.index)}{codeLetter(change.worktree)}
                </span> {change.path}
              </button>
              <button
                className="small-button"
                type="button"
                onClick={() => void stage(change.path)}
                disabled={!hasWorktreeChange(change)}
                data-testid="git-stage"
              >
                Stage
              </button>
              <button
                className="small-button"
                type="button"
                onClick={() => void unstage(change.path)}
                disabled={!isStaged(change)}
                data-testid="git-unstage"
              >
                Unstage
              </button>
            </li>
          ))}
        </ul>
      </div>

      {selected !== null ? (
        <div className="panel-card">
          <h2>Diff · {selected}{diffStaged ? " · staged" : ""}</h2>
          <pre className="diff-view" data-testid="git-diff">{diff || "No diff."}</pre>
        </div>
      ) : null}

      <form
        className="panel-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && message.trim().length > 0 && stagedCount > 0) {
            void commit();
          }
        }}
      >
        <h2>Commit</h2>
        <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="type(scope): message" aria-label="Commit message" data-testid="git-commit-message" />
        <button
          className="small-button"
          type="submit"
          disabled={busy || message.trim().length === 0 || stagedCount === 0}
          data-testid="git-commit"
        >
          Commit staged
        </button>
        {stagedCount === 0 ? <small data-testid="git-staged-hint">Stage at least one file to commit.</small> : null}
      </form>

      {notice !== null ? <div className="banner-ok" role="status" data-testid="git-notice">{notice}</div> : null}
      {error !== null ? <div className="banner-error" role="alert" data-testid="git-error">{error}</div> : null}
    </div>
  );
}
