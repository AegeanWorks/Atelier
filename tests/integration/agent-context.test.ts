import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgent } from "../../server/agent";
import { ensureHome } from "../../server/config";
import { appendMessage, createSession, openDatabase, recoverOnBoot } from "../../server/db";
import { FixtureProviderAdapter } from "../../server/eval/fixtures";
import { createRun, getRun } from "../../server/runs";
import { loadConfig, loadSecrets, saveConfig } from "../../server/state";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("agent context", () => {
  it("sends a system prompt with AGENTS.md and keeps tool calls paired with results", async () => {
    const workspace = tempDir("atelier-context-ws-");
    writeFileSync(join(workspace, "AGENTS.md"), "Always run the tests.\n");
    writeFileSync(join(workspace, "notes.txt"), "1: hello\n");
    const paths = ensureHome(tempDir("atelier-context-home-"));
    const config = loadConfig(paths);
    saveConfig(paths, {
      ...config,
      providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
      defaults: { provider: "fixture", model: "fixture-model" },
    });
    const db = openDatabase(paths);
    try {
      recoverOnBoot(db);
      const session = createSession(db, "Context");
      appendMessage(db, session.id, "user", "read notes.txt", null);
      const run = createRun(db, session.id, null, null, workspace);
      const adapter = new FixtureProviderAdapter({
        provider: "fixture",
        models: [{ id: "fixture-model" }],
        responses: [
          { events: [{ type: "tool-call", id: "call_1", name: "read_file", input: { path: "notes.txt" } }, { type: "finish", reason: "tool_calls" }] },
          { events: [{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }] },
        ],
      });
      const updated = getRun(db, run.id);
      if (updated === null) throw new Error("run missing");
      const outcome = await runAgent(db, loadConfig(paths), loadSecrets(paths), updated, "fixture", "fixture-model", new AbortController().signal, { adapter });
      expect(outcome.status).toBe("finished");
      const first = adapter.requests[0]?.messages ?? [];
      expect(first[0]?.role).toBe("system");
      expect(first[0]?.content).toContain("<AGENTS.md>");
      expect(first[0]?.content).toContain("Always run the tests.");
      const second = adapter.requests[1]?.messages ?? [];
      const assistant = second.find((message) => message.role === "assistant" && (message.toolCalls ?? []).length > 0);
      expect(assistant?.toolCalls?.[0]).toMatchObject({ id: "call_1", name: "read_file" });
      const tool = second.find((message) => message.role === "tool");
      expect(tool).toMatchObject({ toolCallId: "call_1", name: "read_file" });
    } finally {
      db.close();
    }
  });
});
