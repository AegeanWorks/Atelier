export interface ActivityItem {
  id: string;
  tool: string;
  detail: string;
  ok: boolean;
  at: number;
}

const TOOL_LABELS: Record<string, string> = {
  read_file: "Read",
  list_dir: "Listed",
  glob: "Found files",
  ripgrep: "Searched",
  write_file: "Wrote",
  edit_file: "Edited",
  multi_edit: "Edited",
  bash: "Ran",
  git_status: "Checked git status",
  git_diff: "Read git diff",
  delegate: "Delegated",
  wait: "Waited",
};

export function toolLabel(name: string): string {
  if (TOOL_LABELS[name] !== undefined) return TOOL_LABELS[name] as string;
  if (name.startsWith("mcp__")) return `Called ${name.replace(/^mcp__/, "").replace(/__/g, " · ")}`;
  return name;
}

function shorten(value: string, limit = 90): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length <= limit ? single : `${single.slice(0, limit)}…`;
}

export function appendActivity(current: ActivityItem[], item: ActivityItem, limit = 40): ActivityItem[] {
  const next = [...current, item];
  return next.length <= limit ? next : next.slice(next.length - limit);
}

interface Props {
  items: ActivityItem[];
  running: boolean;
  onDismiss: () => void;
  onOpenTask: () => void;
}

export default function ActivityFeed({ items, running, onDismiss, onOpenTask }: Props): React.JSX.Element | null {
  if (items.length === 0 && !running) return null;
  const visible = items.slice(-6);
  return (
    <section className="activity-feed" aria-label="Agent activity" data-testid="activity-feed">
      <div className="activity-head">
        <span className="activity-title">
          {running ? (
            <span className="working-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          ) : (
            <span aria-hidden="true">✓</span>
          )}
          {running ? "Working" : "Last run"}
        </span>
        <span className="activity-count">{items.length} step{items.length === 1 ? "" : "s"}</span>
        <span className="activity-spacer" />
        <button className="activity-link" type="button" onClick={onOpenTask} data-testid="activity-open-task">
          Details
        </button>
        {running ? null : (
          <button className="activity-link" type="button" onClick={onDismiss} aria-label="Dismiss activity" data-testid="activity-dismiss">
            ×
          </button>
        )}
      </div>
      {visible.length === 0 ? (
        <p className="activity-empty">Waiting for the first tool call…</p>
      ) : (
        <ol className="activity-list" data-testid="activity-list">
          {visible.map((item) => (
            <li key={item.id} className="activity-item" data-ok={item.ok} data-testid="activity-item">
              <span className="activity-tool">{toolLabel(item.tool)}</span>
              {item.detail.length > 0 ? <code className="activity-detail">{shorten(item.detail)}</code> : null}
              <span className="activity-state" aria-label={item.ok ? "succeeded" : "failed"}>{item.ok ? "ok" : "failed"}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
