import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgent } from "../../server/agent";
import { compactMessages, estimateTokens } from "../../server/compaction";
import { ensureHome } from "../../server/config";
import { appendMessage, createSession, openDatabase, recoverOnBoot, type DbHandle } from "../../server/db";
import { FixtureProviderAdapter } from "../../server/eval/fixtures";
import { FULL_PROFILE } from "../../server/eval/harness";
import { listEvents } from "../../server/db";
import { createRun, getRun } from "../../server/runs";
import { loadConfig, loadSecrets, saveConfig } from "../../server/state";
import type { FixtureSpec } from "../../server/eval/types";

const dirs: string[] = [];
const handles: DbHandle[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function setup(fixtureSpec: FixtureSpec): Promise<{ handle: DbHandle; workspace: string; runId: string; sessionId: string; adapter: FixtureProviderAdapter }> {
  const paths = ensureHome(tempDir("atelier-compact-home-"));
  const config = loadConfig(paths);
  saveConfig(paths, {
    ...config,
    providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
    defaults: { provider: "fixture", model: "fixture-model" },
  });
  const handle = openDatabase(paths);
  handles.push(handle);
  recoverOnBoot(handle);
  const workspace = tempDir("atelier-compact-workspace-");
  const session = createSession(handle, "compaction test");
  const run = createRun(handle, session.id, null, null, workspace);
  handle.db.prepare("UPDATE runs SET profile_id = 'build' WHERE id = ?").run(run.id);
  return { handle, workspace, runId: run.id, sessionId: session.id, adapter: new FixtureProviderAdapter(fixtureSpec) };
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("compaction", () => {
  it("summarizes older messages and lowers the token count", () => {
    const messages = Array.from({ length: 60 }, (_value, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `message ${index} ${"x".repeat(2_000)}`,
    }));
    const before = messages.reduce((total, message) => total + estimateTokens(message.content), 0);
    const result = compactMessages(messages, 2_000);
    expect(result.stats.droppedMessages).toBeGreaterThan(0);
    expect(result.stats.afterTokens).toBeLessThan(before);
    expect(result.messages[0]?.content).toContain("[compacted earlier context]");
  });

  it("offloads a large tool result and sends only a preview", async () => {
    const { handle, workspace, runId, adapter } = await setup({
      provider: "fixture",
      models: [{ id: "fixture-model", name: "Fixture" }],
      responses: [
        { events: [{ type: "tool-call", id: "r1", name: "read_file", input: { path: "big.txt" } }, { type: "finish", reason: "tool_calls" }] },
        { events: [{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }] },
      ],
    });
    writeFileSync(join(workspace, "big.txt"), "x".repeat(20_000));
    const run = getRun(handle, runId);
    if (run === null) throw new Error("run missing");
    const outcome = await runAgent(handle, loadConfig(handle.paths), loadSecrets(handle.paths), run, "fixture", "fixture-model", new AbortController().signal, { adapter, approve: async () => true });
    expect(outcome.status).toBe("finished");
    const toolMessage = adapter.requests[1]?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("[full output:");
    expect(toolMessage?.content.length).toBeLessThan(1_500);
    const event = listEvents(handle, run.session_id).find((entry) => entry.type === "artifact.offloaded");
    expect(event).toBeDefined();
    const path = (JSON.parse(event?.data ?? "{}") as { path?: string }).path;
    expect(path !== undefined && existsSync(path)).toBe(true);
    expect(readFileSync(path ?? "", "utf8").length).toBeGreaterThan(20_000);
  });

  it("emits context.compacted when a run exceeds the token budget", async () => {
    const { handle, runId, sessionId, adapter } = await setup({
      provider: "fixture",
      models: [{ id: "fixture-model", name: "Fixture" }],
      responses: [{ events: [{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }] }],
    });
    const budget = FULL_PROFILE.contextTokens;
    const messages = Math.ceil((budget * 2) / 750) + 4;
    for (let index = 0; index < messages; index += 1) appendMessage(handle, sessionId, index % 2 === 0 ? "user" : "assistant", `message ${index} ${"y".repeat(3_000)}`, null);
    const run = getRun(handle, runId);
    if (run === null) throw new Error("run missing");
    const outcome = await runAgent(handle, loadConfig(handle.paths), loadSecrets(handle.paths), run, "fixture", "fixture-model", new AbortController().signal, { adapter });
    expect(outcome.status).toBe("finished");
    const sent = adapter.requests[0]?.messages ?? [];
    expect(sent[0]?.role).toBe("system");
    expect(sent.some((message) => message.content.includes("[compacted earlier context]"))).toBe(true);
    expect(listEvents(handle, sessionId).some((entry) => entry.type === "context.compacted")).toBe(true);
  });
});
