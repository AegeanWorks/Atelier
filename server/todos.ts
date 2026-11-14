import { AtelierError } from "./config.js";
import type { DbHandle } from "./db.js";
import { appendSessionEvent } from "./runs.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

export const MAX_TODOS = 20;
export const MAX_TODO_TEXT = 200;

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

export function normalizeTodos(input: unknown): TodoItem[] {
  if (!Array.isArray(input)) {
    throw new AtelierError("TODO_INVALID", "todos must be an array.", "The tool received a non-array value.", "Send { todos: [{ text, status }] }.");
  }
  if (input.length > MAX_TODOS) {
    throw new AtelierError(
      "TODO_TOO_MANY",
      `At most ${MAX_TODOS} todos are allowed.`,
      `${input.length} were sent.`,
      "Merge related steps into one todo.",
    );
  }
  const items: TodoItem[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of input.entries()) {
    const entry = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const text = String(entry.text ?? "").trim();
    if (text.length === 0) {
      throw new AtelierError("TODO_INVALID", `Todo ${index + 1} has no text.`, "An empty todo cannot be shown.", "Give every todo a short description.");
    }
    if (text.length > MAX_TODO_TEXT) {
      throw new AtelierError("TODO_INVALID", `Todo ${index + 1} is too long.`, `${text.length} characters exceeds ${MAX_TODO_TEXT}.`, "Shorten the todo text.");
    }
    const status = String(entry.status ?? "pending") as TodoStatus;
    if (!STATUSES.includes(status)) {
      throw new AtelierError("TODO_INVALID", `Todo ${index + 1} has an unknown status.`, `'${status}' is not pending, in_progress or completed.`, "Use one of the three statuses.");
    }
    const id = typeof entry.id === "string" && entry.id.trim().length > 0 ? entry.id.trim().slice(0, 60) : `todo-${index + 1}`;
    if (seen.has(id)) {
      throw new AtelierError("TODO_INVALID", `Todo id '${id}' is duplicated.`, "Ids must be unique inside one update.", "Use distinct ids.");
    }
    seen.add(id);
    items.push({ id, text, status });
  }
  if (items.filter((item) => item.status === "in_progress").length > 1) {
    throw new AtelierError("TODO_INVALID", "Only one todo can be in_progress.", "The list marks several tasks as the current one.", "Keep exactly one in_progress item, or none.");
  }
  return items;
}

export function saveTodos(handle: DbHandle, sessionId: string, runId: string | null, items: TodoItem[]): void {
  appendSessionEvent(handle, sessionId, "todo.updated", { runId, todos: items, updatedAt: Date.now() });
}

interface EventRow {
  data: string;
  created: number;
}

export function latestTodos(handle: DbHandle, sessionId: string): { todos: TodoItem[]; updatedAt: number | null } {
  const row = handle.db
    .prepare("SELECT data, created FROM events WHERE session_id = ? AND type = 'todo.updated' ORDER BY seq DESC LIMIT 1")
    .get(sessionId) as EventRow | undefined;
  if (row === undefined) return { todos: [], updatedAt: null };
  try {
    const parsed = JSON.parse(row.data) as { todos?: unknown };
    if (!Array.isArray(parsed.todos)) return { todos: [], updatedAt: null };
    const todos = normalizeTodos(parsed.todos);
    return { todos, updatedAt: row.created };
  } catch {
    return { todos: [], updatedAt: null };
  }
}

export function todoSummary(items: TodoItem[]): string {
  if (items.length === 0) return "todos cleared";
  const done = items.filter((item) => item.status === "completed").length;
  const current = items.find((item) => item.status === "in_progress");
  return `${done}/${items.length} complete${current === undefined ? "" : `; now: ${current.text}`}`;
}
