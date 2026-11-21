export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

function countDone(items: TodoItem[]): number {
  return items.filter((item) => item.status === "completed").length;
}

interface Props {
  todos: TodoItem[];
  onDismiss?: () => void;
}

function TodoMark({ status }: { status: TodoStatus }): React.JSX.Element {
  const common = {
    width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (status === "completed") return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
  if (status === "in_progress") return <svg {...common}><path d="m8 5 11 7-11 7Z" /></svg>;
  return <svg {...common}><circle cx="12" cy="12" r="8" /></svg>;
}

export default function TodoStrip({ todos, onDismiss }: Props): React.JSX.Element | null {
  if (todos.length === 0) return null;
  const done = countDone(todos);
  const allDone = done === todos.length;
  return (
    <section className="todo-strip" aria-label="Task list" data-testid="todo-strip" data-done={allDone}>
      <div className="todo-head">
        <span className="todo-title">Task list</span>
        <span className="todo-count" data-testid="todo-count">{done}/{todos.length}</span>
        <span className="todo-bar" aria-hidden="true">
          <i style={{ width: `${Math.round((done / todos.length) * 100)}%` }} />
        </span>
        {onDismiss === undefined ? null : (
          <button className="todo-dismiss" type="button" aria-label="Dismiss task list" onClick={onDismiss} data-testid="todo-dismiss">
            ×
          </button>
        )}
      </div>
      <ol className="todo-list" data-testid="todo-list">
        {todos.map((item) => (
          <li key={item.id} className="todo-item" data-status={item.status} data-testid="todo-item">
            <span className="todo-mark">
              <TodoMark status={item.status} />
              <span className="sr-only">{item.status === "completed" ? "✓" : item.status === "in_progress" ? "▸" : "○"}</span>
            </span>
            <span className="todo-text">{item.text}</span>
            <span className="sr-only">{item.status.replace("_", " ")}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
