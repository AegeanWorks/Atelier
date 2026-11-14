import { useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type { CheckpointEntry } from "./types";

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} ${error.fix}`;
  return error instanceof Error ? error.message : String(error);
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export default function HistoryPanel({ refreshTick }: { refreshTick: number }): React.JSX.Element {
  const [entries, setEntries] = useState<CheckpointEntry[]>([]);
  const [selected, setSelected] = useState<CheckpointEntry | null>(null);
  const [dir, setDir] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    const data = await api<{ checkpoints: CheckpointEntry[] }>("/api/checkpoints");
    setEntries(data.checkpoints);
    setSelected((current) =>
      current !== null && data.checkpoints.some((entry) => entry.commit === current.commit && entry.path === current.path)
        ? current
        : data.checkpoints[0] ?? null,
    );
    setError(null);
  }

  useEffect(() => {
    void refresh().catch((caught) => setError(messageOf(caught)));
  }, [refreshTick]);

  useEffect(() => {
    if (selected !== null) setDir(parentOf(selected.path));
    setPending(false);
  }, [selected?.commit, selected?.path]);

  async function restoreFile(): Promise<void> {
    if (selected === null) return;
    setBusy(true);
    try {
      await api("/api/checkpoints/restore", { method: "POST", body: JSON.stringify({ commit: selected.commit, path: selected.path }) });
      setMessage(`Restored ${selected.path}.`);
      await refresh();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function restoreDir(): Promise<void> {
    setBusy(true);
    try {
      const result = await api<{ directory: string; restored: number; paths: string[] }>("/api/checkpoints/restore-directory", {
        method: "POST",
        body: JSON.stringify({ path: dir }),
      });
      setMessage(`Restored ${result.restored} file(s)${result.directory.length > 0 ? ` under ${result.directory}` : ""}.`);
      setPending(false);
      await refresh();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="history-panel" data-testid="history-panel">
      <div className="panel-card">
        <div className="file-head">
          <h2>Checkpoints</h2>
          <button className="small-button" type="button" onClick={() => void refresh()} data-testid="history-refresh">Refresh</button>
        </div>
        {entries.length === 0 ? (
          <p className="provider-meta" data-testid="history-empty">No checkpoints yet. Edits and deletes create them.</p>
        ) : (
          <ul className="provider-list" data-testid="checkpoint-list">
            {entries.map((entry) => (
              <li className="provider-row" key={`${entry.commit}:${entry.path}`}>
                <button className="file-item" type="button" onClick={() => { setSelected(entry); setMessage(null); }} data-testid="checkpoint-item">
                  {entry.path}
                </button>
                <span className="provider-meta">{entry.commit.slice(0, 8)}</span>
                <span className="provider-meta">{new Date(entry.createdAt).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected !== null ? (
        <div className="panel-card" data-testid="checkpoint-detail">
          <div className="file-head">
            <h2>{selected.path}</h2>
            <span className="provider-meta">{selected.commit.slice(0, 8)}</span>
          </div>
          <p className="provider-meta">{selected.message}</p>
          <p className="provider-meta">{new Date(selected.createdAt).toLocaleString()}</p>
          <div className="file-create">
            <button className="small-button" type="button" onClick={() => void restoreFile()} disabled={busy} data-testid="checkpoint-restore">Restore file</button>
          </div>
        </div>
      ) : null}

      <div className="panel-card">
        <h2>Restore directory</h2>
        <input
          value={dir}
          onChange={(event) => {
            setDir(event.target.value);
            setPending(false);
          }}
          placeholder="directory (empty = workspace root)"
          aria-label="Directory"
          data-testid="history-dir"
        />
        <p className="provider-meta">Restores the latest checkpoint of every file under this directory. Current files are checkpointed first.</p>
        {pending ? (
          <div className="file-create">
            <button className="small-button" type="button" onClick={() => void restoreDir()} disabled={busy} data-testid="history-confirm-dir">
              Confirm restore {dir.length > 0 ? dir : "workspace root"}
            </button>
            <button className="small-button" type="button" onClick={() => setPending(false)} data-testid="history-cancel-dir">Cancel</button>
          </div>
        ) : (
          <div className="file-create">
            <button className="small-button" type="button" onClick={() => setPending(true)} disabled={busy} data-testid="history-restore-dir">Restore directory</button>
          </div>
        )}
      </div>

      {message !== null ? <div className="banner-ok" role="status" data-testid="history-message">{message}</div> : null}
      {error !== null ? <div className="banner-error" role="alert" data-testid="history-error">{error}</div> : null}
    </div>
  );
}
