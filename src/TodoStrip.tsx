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
            <span className="todo-mark" aria-hidden="true">
              {item.status === "completed" ? "✓" : item.status === "in_progress" ? "▸" : "○"}
            </span>
            <span className="todo-text">{item.text}</span>
            <span className="sr-only">{item.status.replace("_", " ")}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
