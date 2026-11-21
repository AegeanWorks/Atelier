import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";

interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
}

interface WorkspaceFile {
  path: string;
  content: string;
  hash: string;
  size: number;
}

function FileGlyph({ type }: { type: TreeEntry["type"] }): React.JSX.Element {
  const common = {
    width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  return type === "directory"
    ? <svg {...common}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
    : <svg {...common}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h4" /></svg>;
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} ${error.fix}`;
  return error instanceof Error ? error.message : String(error);
}

export interface OpenRequest {
  path: string;
  nonce: number;
}

export default function FilesPanel({ openRequest = null }: { openRequest?: OpenRequest | null } = {}): React.JSX.Element {
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [current, setCurrent] = useState<WorkspaceFile | null>(null);
  const [draft, setDraft] = useState("");
  const [newPath, setNewPath] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveRef = useRef<() => boolean>(() => false);

  const dirty = current !== null && draft !== current.content;

  async function refresh(): Promise<void> {
    const data = await api<{ entries: TreeEntry[] }>("/api/workspace/tree");
    setEntries(data.entries);
  }

  useEffect(() => {
    void refresh().catch((caught) => setError(messageOf(caught)));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      if (!saveRef.current()) return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function open(path: string): Promise<void> {
    try {
      const data = await api<WorkspaceFile>(`/api/workspace/file?path=${encodeURIComponent(path)}`);
      setCurrent(data);
      setDraft(data.content);
      setConfirmingDelete(false);
      setMessage(null);
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  useEffect(() => {
    if (openRequest !== null) void open(openRequest.path);
    // open() only reads state it sets; the nonce makes a repeated request for the same path reopen it
  }, [openRequest?.nonce]);

  async function save(): Promise<void> {
    if (current === null || draft === current.content) return;
    setSaving(true);
    try {
      const data = await api<WorkspaceFile>("/api/workspace/file", {
        method: "PUT",
        body: JSON.stringify({ path: current.path, content: draft, expectedHash: current.hash }),
      });
      setCurrent(data);
      setMessage(`Saved ${data.path}.`);
      setError(null);
      await refresh();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSaving(false);
    }
  }

  saveRef.current = () => {
    if (current === null || draft === current.content) return false;
    void save();
    return true;
  };

  async function create(): Promise<void> {
    if (newPath.trim().length === 0) return;
    try {
      const data = await api<WorkspaceFile>("/api/workspace/file", {
        method: "POST",
        body: JSON.stringify({ path: newPath.trim(), content: "" }),
      });
      setNewPath("");
      await refresh();
      await open(data.path);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function remove(): Promise<void> {
    if (current === null) return;
    try {
      await api("/api/workspace/file", { method: "DELETE", body: JSON.stringify({ path: current.path }) });
      setCurrent(null);
      setDraft("");
      setConfirmingDelete(false);
      await refresh();
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  return (
    <div className="files-panel" data-testid="files-panel">
      <div className="panel-card">
        <div className="file-head">
          <h2>Files</h2>
          <button className="small-button" type="button" onClick={() => void refresh()} data-testid="files-refresh">Refresh</button>
        </div>
        <div className="file-create">
          <input value={newPath} onChange={(event) => setNewPath(event.target.value)} placeholder="new/file.ts" aria-label="New file path" data-testid="new-file" />
          <button className="small-button" type="button" onClick={() => void create()} data-testid="create-file">Create</button>
        </div>
        <ul className="file-tree" data-testid="file-tree">
          {entries.length === 0 ? (
            <li className="file-empty" data-testid="files-empty">
              <span className="provider-meta">No files in workspace.</span>
            </li>
          ) : null}
          {entries.map((entry) => (
            <li key={entry.path} style={{ paddingLeft: `${entry.path.split("/").length * 8}px` }}>
              <button
                type="button"
                className={current?.path === entry.path ? "file-item active" : "file-item"}
                disabled={entry.type === "directory"}
                onClick={() => void open(entry.path)}
                data-testid="file-item"
              >
                <FileGlyph type={entry.type} />
                <span>{entry.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {current !== null ? (
        <div className="panel-card">
          <div className="file-head">
            <h2>{current.path}</h2>
            <button className="small-button" type="button" onClick={() => void save()} disabled={!dirty || saving} title="Save (Cmd/Ctrl+S)" data-testid="save-file">{saving ? "Saving…" : "Save"}</button>
            <button
              className="small-button danger"
              type="button"
              onClick={() => {
                if (confirmingDelete) {
                  void remove();
                } else {
                  setConfirmingDelete(true);
                }
              }}
              data-testid={confirmingDelete ? "delete-file-confirm" : "delete-file"}
            >
              {confirmingDelete ? "Delete?" : "Delete"}
            </button>
          </div>
          <textarea className="editor" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} aria-label={`Edit ${current.path}`} data-testid="editor" />
          <small>{current.size} bytes · {dirty ? "unsaved — Cmd/Ctrl+S to save" : "saved"}</small>
        </div>
      ) : (
        <div className="panel-card file-preview-placeholder"><p>Select a file to open it.</p></div>
      )}

      {message !== null ? <div className="banner-ok" role="status" data-testid="files-message">{message}</div> : null}
      {error !== null ? <div className="banner-error" role="alert" data-testid="files-error">{error}</div> : null}
    </div>
  );
}
