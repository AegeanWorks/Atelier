import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgent } from "../../server/agent";
import { ensureHome } from "../../server/config";
import { appendMessage, createSession, openDatabase, recoverOnBoot } from "../../server/db";
import { createRun, getRun, listRunSteps } from "../../server/runs";
import { executeTool } from "../../server/tools";
import { loadConfig, loadSecrets, saveConfig, saveSecrets } from "../../server/state";

const tempDirs: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function scriptedProvider(): Promise<number> {
  let count = 0;
  const server = createServer((_request, response) => {
    count += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (count === 1) {
      response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"write_file","arguments":"{\\"path\\":\\"notes.txt\\",\\"content\\":\\"hello from tool\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
    } else {
      response.write('data: {"choices":[{"delta":{"content":"finished after tool"}}]}\n\n');
      response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n');
    }
    response.end("data: [DONE]\n\n");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

function configure(paths: ReturnType<typeof ensureHome>, port: number): void {
  const config = loadConfig(paths);
  saveConfig(paths, {
    ...config,
    providers: [{ id: "fake", name: "Fake", protocol: "openai-chat", baseUrl: `http://127.0.0.1:${port}/v1`, defaultModel: "test-model" }],
    defaults: { provider: "fake", model: "test-model" },
  });
  const secrets = loadSecrets(paths);
  secrets.keys.fake = "sk-tool-test";
  saveSecrets(paths, secrets);
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tools and agent loop", () => {
  it("writes atomically and deduplicates the effect", async () => {
    const workspace = tempDir("atelier-tools-ws-");
    const paths = ensureHome(tempDir("atelier-tools-home-"));
    const db = openDatabase(paths);
    try {
      const session = createSession(db, "Tools");
      const run = createRun(db, session.id, null, null, workspace);
      const call = { id: "call-1", name: "write_file", input: { path: "notes.txt", content: "one" } };
      const first = await executeTool(db, run, "build", call);
      expect(first.ok).toBe(true);
      expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("one");
      rmSync(join(workspace, "notes.txt"));
      const second = await executeTool(db, run, "build", call);
      expect(second.effectKey).toBe(first.effectKey);
      expect(existsSync(join(workspace, "notes.txt"))).toBe(false);
    } finally {
      db.close();
    }
  });

  it("denies mutations in plan mode and escapes outside the jail", async () => {
    const workspace = tempDir("atelier-tools-ws-");
    const paths = ensureHome(tempDir("atelier-tools-home-"));
    const db = openDatabase(paths);
    try {
      const session = createSession(db, "Plan");
      const run = createRun(db, session.id, null, null, workspace);
      expect(run.workspace).toBe(workspace);
      const denied = await executeTool(db, run, "plan", { id: "call-2", name: "write_file", input: { path: "blocked.txt", content: "no" } });
      expect(denied.ok).toBe(false);
      expect(denied.output).toContain("Permission denied");
      const escape = await executeTool(db, run, "build", { id: "call-3", name: "write_file", input: { path: "../escape.txt", content: "no" } });
      expect(escape.ok).toBe(false);
      expect(escape.output).toContain("outside the workspace");
    } finally {
      db.close();
    }
  });

  it("executes a provider tool call, then answers with the tool result in context", async () => {
    const workspace = tempDir("atelier-agent-ws-");
    const paths = ensureHome(tempDir("atelier-agent-home-"));
    const port = await scriptedProvider();
    configure(paths, port);
    const db = openDatabase(paths);
    try {
      recoverOnBoot(db);
      const session = createSession(db, "Agent");
      appendMessage(db, session.id, "user", "write notes.txt", null);
      const run = createRun(db, session.id, null, null, workspace);
      db.db.prepare("UPDATE runs SET profile_id = 'build' WHERE id = ?").run(run.id);
      const updated = getRun(db, run.id) ?? run;
      const config = loadConfig(paths);
      const secrets = loadSecrets(paths);
      const outcome = await runAgent(db, config, secrets, updated, "fake", "test-model", new AbortController().signal, { approve: async () => true });
      expect(outcome.status).toBe("finished");
      expect(outcome.text).toBe("finished after tool");
      expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("hello from tool");
      expect(listRunSteps(db, run.id).some((step) => step.kind === "tool" && step.status === "done")).toBe(true);
    } finally {
      db.close();
    }
  });
});
