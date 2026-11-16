import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "./api";

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} ${error.fix}`;
  return error instanceof Error ? error.message : String(error);
}

const STORAGE_KEY = "atelier.preview.url";
const DEFAULT_URL = "http://127.0.0.1:3000/";
const CANDIDATES = [
  "http://127.0.0.1:3000/",
  "http://127.0.0.1:5173/",
  "http://127.0.0.1:4173/",
  "http://127.0.0.1:8080/",
  "http://127.0.0.1:8000/",
];

interface PreviewSessionView {
  token: string;
  base: string;
  prefix: string;
}

function readUrl(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored !== null && stored.length > 0 ? stored : DEFAULT_URL;
  } catch {
    return DEFAULT_URL;
  }
}

function persistUrl(value: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // A blocked storage keeps the panel working for this session.
  }
}

async function probe(target: string): Promise<boolean> {
  try {
    const session = await api<PreviewSessionView>("/api/preview/session", {
      method: "POST",
      body: JSON.stringify({ url: target }),
    });
    const response = await fetch(session.prefix, { credentials: "same-origin", cache: "no-store" });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

export default function PreviewPanel(): React.JSX.Element {
  const [url, setUrl] = useState(readUrl);
  const [src, setSrc] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detecting, setDetecting] = useState(false);

  useEffect(() => {
    persistUrl(url);
  }, [url]);

  async function open(target: string): Promise<void> {
    const session = await api<PreviewSessionView>("/api/preview/session", {
      method: "POST",
      body: JSON.stringify({ url: target }),
    });
    setSrc(session.prefix);
    setNonce((value) => value + 1);
    setError(null);
  }

  async function load(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const trimmed = url.trim();
    if (trimmed.length === 0) return;
    setLoading(true);
    try {
      await open(trimmed);
      setNotice(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }

  async function reload(): Promise<void> {
    const trimmed = url.trim();
    if (trimmed.length === 0) return;
    setLoading(true);
    try {
      await open(trimmed);
      setNotice("Reloaded.");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }

  async function detect(): Promise<void> {
    setDetecting(true);
    setNotice(null);
    setError(null);
    try {
      for (const candidate of CANDIDATES) {
        if (!(await probe(candidate))) continue;
        setUrl(candidate);
        await open(candidate);
        setNotice(`Found a dev server at ${candidate}.`);
        return;
      }
      setError("No dev server answered on the usual loopback ports (3000, 5173, 4173, 8080, 8000). Start one, or paste its URL.");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setDetecting(false);
    }
  }

  function openInTab(): void {
    if (src === null) return;
    window.open(new URL(src, window.location.origin).href, "_blank", "noopener,noreferrer");
  }

  return (
    <div data-testid="preview-panel">
      <div className="panel-card">
        <h2>Preview</h2>
        <p>Load a loopback dev server through the sandboxed directory proxy. External hosts and redirects are refused.</p>
        <form className="preview-form" onSubmit={(event) => void load(event)}>
          <label className="sr-only" htmlFor="preview-url">Preview URL</label>
          <input
            id="preview-url"
            className="preview-input"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={DEFAULT_URL}
            data-testid="preview-url"
          />
          <button className="send-button" type="submit" disabled={loading} data-testid="preview-load">{loading ? "Loading…" : "Load"}</button>
        </form>
        <div className="file-create">
          <button className="small-button" type="button" onClick={() => void reload()} disabled={loading || src === null} data-testid="preview-reload">Reload</button>
          <button className="small-button" type="button" onClick={openInTab} disabled={src === null} data-testid="preview-tab">Open in new tab</button>
          <button className="small-button" type="button" onClick={() => void detect()} disabled={detecting} data-testid="preview-detect">{detecting ? "Detecting…" : "Detect"}</button>
          <button
            className="small-button danger"
            type="button"
            onClick={() => {
              setSrc(null);
              setNotice(null);
              setError(null);
            }}
            disabled={src === null}
            data-testid="preview-close"
          >
            Close
          </button>
        </div>
        {notice !== null ? <div className="banner-ok" role="status" data-testid="preview-notice">{notice}</div> : null}
        {error !== null ? <div className="banner-error" role="alert" data-testid="preview-error">{error}</div> : null}
      </div>
      {src === null ? (
        <div className="panel-card panel-gap preview-placeholder">
          <p className="provider-meta" data-testid="preview-empty">Enter a loopback URL and load it, or press Detect to find a running dev server.</p>
        </div>
      ) : (
        <iframe
          key={nonce}
          className="preview-frame"
          src={`${src}?r=${nonce}`}
          title="Preview"
          sandbox="allow-scripts allow-forms allow-same-origin"
          data-testid="preview-frame"
        />
      )}
    </div>
  );
}
