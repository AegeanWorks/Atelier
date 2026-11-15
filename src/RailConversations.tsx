import { useEffect, useState, type KeyboardEvent } from "react";
import type { Session } from "./types";

export interface SearchHit {
  id: string;
  session_id: string;
  text: string;
}

interface RailConversationsProps {
  sessions: Session[];
  activeId: string | null;
  archived: boolean;
  onToggleArchived: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onArchive: (id: string, archived: boolean) => void;
  onSearch: (query: string) => Promise<SearchHit[]>;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
}

export default function RailConversations({
  sessions,
  activeId,
  archived,
  onToggleArchived,
  onSelect,
  onRename,
  onDelete,
  onPin,
  onArchive,
  onSearch,
}: RailConversationsProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const found = await onSearch(trimmed);
          if (!cancelled) setHits(found);
        } catch {
          if (!cancelled) setHits([]);
        }
      })();
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, onSearch]);

  const visible = trimmed.length === 0
    ? sessions
    : sessions.filter((session) => session.title.toLowerCase().includes(trimmed.toLowerCase()));

  function startRename(session: Session): void {
    setConfirmingId(null);
    setRenamingId(session.id);
    setRenameDraft(session.title);
  }

  function commitRename(session: Session): void {
    const next = renameDraft.trim();
    setRenamingId(null);
    if (next.length === 0 || next === session.title) return;
    onRename(session.id, next);
  }

  function onRenameKeyDown(event: KeyboardEvent<HTMLInputElement>, session: Session): void {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename(session);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setRenamingId(null);
    }
  }

  return (
    <>
      <div className="rail-search">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search conversations"
          aria-label="Search conversations"
          data-testid="session-search"
        />
        <button
          type="button"
          className="rail-toggle"
          aria-pressed={archived}
          onClick={onToggleArchived}
          data-testid="toggle-archived"
        >
          {archived ? "Back to active" : "Archived"}
        </button>
      </div>
      <div className="rail-section rail-list-section">
        {visible.length === 0 ? (
          <p className="rail-empty">
            {trimmed.length > 0
              ? `No conversation title matches "${trimmed}".`
              : archived
                ? "No archived conversations."
                : "No conversations yet. Start one and the durable event log begins."}
          </p>
        ) : (
          <ul className="conversation-list" data-testid="conversation-list">
            {visible.map((session) => (
              <li key={session.id} className="conversation-row">
                {renamingId === session.id ? (
                  <form
                    className="conversation-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      commitRename(session);
                    }}
                  >
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onKeyDown={(event) => onRenameKeyDown(event, session)}
                      onBlur={() => commitRename(session)}
                      aria-label={`Rename ${session.title}`}
                      data-testid="rename-input"
                    />
                    <button type="submit" className="small-button">Save</button>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      className="conversation-item"
                      aria-current={session.id === activeId ? "true" : "false"}
                      onClick={() => {
                        setConfirmingId(null);
                        onSelect(session.id);
                      }}
                      data-testid="conversation-item"
                    >
                      <span className="conversation-title">
                        {session.pinned === 1 ? <span className="pin-mark" aria-label="Pinned">★ </span> : null}
                        {session.title}
                      </span>
                      <span className="conversation-meta">{relativeTime(session.updated)}</span>
                    </button>
                    <div className="conversation-actions">
                      <button
                        type="button"
                        className="conversation-action"
                        aria-label={session.pinned === 1 ? `Unpin ${session.title}` : `Pin ${session.title}`}
                        data-testid={session.pinned === 1 ? "conversation-unpin" : "conversation-pin"}
                        onClick={() => onPin(session.id, session.pinned !== 1)}
                      >
                        {session.pinned === 1 ? "★" : "☆"}
                      </button>
                      <button
                        type="button"
                        className="conversation-action"
                        aria-label={archived ? `Unarchive ${session.title}` : `Archive ${session.title}`}
                        data-testid={archived ? "conversation-unarchive" : "conversation-archive"}
                        onClick={() => onArchive(session.id, !archived)}
                      >
                        {archived ? "↩" : "▣"}
                      </button>
                      <button
                        type="button"
                        className="conversation-action"
                        aria-label={`Rename ${session.title}`}
                        data-testid="conversation-rename"
                        onClick={() => startRename(session)}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="conversation-action destructive"
                        aria-label={confirmingId === session.id ? `Confirm delete ${session.title}` : `Delete ${session.title}`}
                        data-testid={confirmingId === session.id ? "conversation-delete-confirm" : "conversation-delete"}
                        onClick={() => {
                          if (confirmingId === session.id) {
                            setConfirmingId(null);
                            onDelete(session.id);
                          } else {
                            setConfirmingId(session.id);
                          }
                        }}
                      >
                        {confirmingId === session.id ? "delete?" : "×"}
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {hits.length > 0 ? (
          <div className="search-hits" data-testid="search-hits">
            <div className="rail-label">
              <span>Messages</span>
              <span>{hits.length}</span>
            </div>
            <ul>
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    className="search-hit"
                    onClick={() => {
                      setQuery("");
                      onSelect(hit.session_id);
                    }}
                    data-testid="search-hit"
                  >
                    {snippet(hit.text)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </>
  );
}
