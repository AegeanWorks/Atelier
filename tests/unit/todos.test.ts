import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtelierError, ensureHome } from "../../server/config";
import { createSession, openDatabase } from "../../server/db";
import { MAX_TODO_TEXT, MAX_TODOS, latestTodos, normalizeTodos, saveTodos, todoSummary } from "../../server/todos";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("todo list", () => {
  it("normalizes a list and defaults ids and statuses", () => {
    expect(normalizeTodos([{ text: "Read the code" }, { text: "Fix it", status: "completed" }])).toEqual([
      { id: "todo-1", text: "Read the code", status: "pending" },
      { id: "todo-2", text: "Fix it", status: "completed" },
    ]);
  });

  it("rejects malformed lists with actionable errors", () => {
    expect(() => normalizeTodos("nope")).toThrow(/array/);
    expect(() => normalizeTodos([{ text: "  " }])).toThrow(/no text/);
    expect(() => normalizeTodos([{ text: "a", status: "done" }])).toThrow(/unknown status/);
    expect(() => normalizeTodos([{ text: "a".repeat(MAX_TODO_TEXT + 1) }])).toThrow(/too long/);
    expect(() => normalizeTodos([{ id: "x", text: "a" }, { id: "x", text: "b" }])).toThrow(/duplicated/);
    expect(() => normalizeTodos(Array.from({ length: MAX_TODOS + 1 }, (_value, index) => ({ text: `t${index}` })))).toThrow(/At most/);
  });

  it("allows at most one in-progress item", () => {
    expect(() => normalizeTodos([{ text: "a", status: "in_progress" }, { text: "b", status: "in_progress" }])).toThrow(
      AtelierError,
    );
    expect(normalizeTodos([{ text: "a", status: "in_progress" }, { text: "b", status: "pending" }])).toHaveLength(2);
  });

  it("persists the newest list and reports a summary", () => {
    const paths = ensureHome(tempDir("atelier-todos-home-"));
    const db = openDatabase(paths);
    try {
      const session = createSession(db, "Todos");
      expect(latestTodos(db, session.id)).toEqual({ todos: [], updatedAt: null });
      saveTodos(db, session.id, "run_1", normalizeTodos([{ text: "first" }, { text: "second" }]));
      saveTodos(db, session.id, "run_1", normalizeTodos([{ text: "first", status: "completed" }, { text: "second", status: "in_progress" }]));
      const latest = latestTodos(db, session.id);
      expect(latest.todos.map((item) => item.status)).toEqual(["completed", "in_progress"]);
      expect(latest.updatedAt).toBeGreaterThan(0);
      expect(todoSummary(latest.todos)).toBe("1/2 complete; now: second");
      expect(todoSummary([])).toBe("todos cleared");
    } finally {
      db.close();
    }
  });
});
