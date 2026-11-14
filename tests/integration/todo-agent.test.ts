import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgent } from "../../server/agent";
import { ensureHome } from "../../server/config";
import { appendMessage, createSession, listEvents, openDatabase, recoverOnBoot } from "../../server/db";
import { FixtureProviderAdapter } from "../../server/eval/fixtures";
import { createRun, getRun } from "../../server/runs";
import { loadConfig, loadSecrets, saveConfig } from "../../server/state";
import { latestTodos } from "../../server/todos";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("todo_write inside the agent loop", () => {
  it("publishes the list as a durable event and returns a summary", async () => {
    const workspace = tempDir("atelier-todo-agent-ws-");
    const paths = ensureHome(tempDir("atelier-todo-agent-home-"));
    const config = loadConfig(paths);
    saveConfig(paths, {
      ...config,
      providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
      defaults: { provider: "fixture", model: "fixture-model" },
    });
    const db = openDatabase(paths);
    try {
      recoverOnBoot(db);
      const session = createSession(db, "Todos");
      appendMessage(db, session.id, "user", "do three things", null);
      const run = createRun(db, session.id, null, null, workspace);
      const adapter = new FixtureProviderAdapter({
        provider: "fixture",
        models: [{ id: "fixture-model" }],
        responses: [
          {
            events: [
              {
                type: "tool-call",
                id: "todo_1",
                name: "todo_write",
                input: { todos: [{ text: "Read", status: "in_progress" }, { text: "Edit" }, { text: "Verify" }] },
              },
              { type: "finish", reason: "tool_calls" },
            ],
          },
          { events: [{ type: "text-delta", text: "listed" }, { type: "finish", reason: "stop" }] },
        ],
      });
      const updated = getRun(db, run.id);
      if (updated === null) throw new Error("run missing");
      const outcome = await runAgent(db, loadConfig(paths), loadSecrets(paths), updated, "fixture", "fixture-model", new AbortController().signal, { adapter });
      expect(outcome.status).toBe("finished");
      const stored = latestTodos(db, session.id);
      expect(stored.todos.map((item) => item.text)).toEqual(["Read", "Edit", "Verify"]);
      expect(stored.todos[0]?.status).toBe("in_progress");
      const event = listEvents(db, session.id).find((entry) => entry.type === "todo.updated");
      expect(event).toBeDefined();
      const result = listEvents(db, session.id).find((entry) => entry.type === "tool.result" && JSON.parse(entry.data).name === "todo_write");
      expect(result).toBeDefined();
      expect(JSON.parse(result?.data ?? "{}").output).toContain("0/3 complete; now: Read");
      expect(adapter.requests).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
