import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHome } from "../../server/config";
import { openDatabase } from "../../server/db";
import { FixtureProviderAdapter } from "../../server/eval/fixtures";
import { listHeadlessSessions, runHeadless } from "../../server/headless";
import { mkdirSync, writeFileSync } from "node:fs";
import { listRuns } from "../../server/runs";
import { loadConfig, saveConfig } from "../../server/state";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function homeWithFixture(): string {
  const home = tempDir("atelier-headless-home-");
  const paths = ensureHome(home);
  const config = loadConfig(paths);
  saveConfig(paths, {
    ...config,
    providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
    defaults: { provider: "fixture", model: "fixture-model" },
  });
  return home;
}

function answer(text: string): FixtureProviderAdapter {
  return new FixtureProviderAdapter({
    provider: "fixture",
    models: [{ id: "fixture-model" }],
    responses: [{ events: [{ type: "text-delta", text }, { type: "finish", reason: "stop" }] }],
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("headless runs", () => {
  it("runs a read-only plan and returns the answer", async () => {
    const home = homeWithFixture();
    const workspace = tempDir("atelier-headless-ws-");
    const result = await runHeadless({ homeDir: home, workspace, prompt: "summarise the repo", adapter: answer("The repo is small.") });
    expect(result.status).toBe("finished");
    expect(result.text).toBe("The repo is small.");
    expect(result.mode).toBe("plan");
    expect(result.sessionId.startsWith("ses_")).toBe(true);
    const db = openDatabase(ensureHome(home));
    try {
      expect(listRuns(db, result.sessionId)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("continues an existing conversation when given a session id", async () => {
    const home = homeWithFixture();
    const workspace = tempDir("atelier-headless-ws-");
    const first = await runHeadless({ homeDir: home, workspace, prompt: "first", adapter: answer("one") });
    const second = await runHeadless({ homeDir: home, workspace, prompt: "second", sessionId: first.sessionId, adapter: answer("two") });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.text).toBe("two");
  });

  it("blocks a build write when nothing can approve it", async () => {
    const home = homeWithFixture();
    const workspace = tempDir("atelier-headless-ws-");
    const adapter = new FixtureProviderAdapter({
      provider: "fixture",
      models: [{ id: "fixture-model" }],
      responses: [
        { events: [{ type: "tool-call", id: "w1", name: "write_file", input: { path: "out.txt", content: "done" } }, { type: "finish", reason: "tool_calls" }] },
        { events: [{ type: "text-delta", text: "finished" }, { type: "finish", reason: "stop" }] },
      ],
    });
    const result = await runHeadless({ homeDir: home, workspace, prompt: "write out.txt", mode: "build", adapter });
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("headless runs have no approver");
    expect(existsSync(join(workspace, "out.txt"))).toBe(false);
  });

  it("applies the write when auto-approval is explicit", async () => {
    const home = homeWithFixture();
    const workspace = tempDir("atelier-headless-ws-");
    const adapter = new FixtureProviderAdapter({
      provider: "fixture",
      models: [{ id: "fixture-model" }],
      responses: [
        { events: [{ type: "tool-call", id: "w1", name: "write_file", input: { path: "out.txt", content: "done" } }, { type: "finish", reason: "tool_calls" }] },
        { events: [{ type: "text-delta", text: "finished" }, { type: "finish", reason: "stop" }] },
      ],
    });
    const result = await runHeadless({ homeDir: home, workspace, prompt: "write out.txt", mode: "build", autoApprove: true, adapter });
    expect(result.status).toBe("finished");
    expect(result.tools).toBe(1);
    expect(readFileSync(join(workspace, "out.txt"), "utf8")).toBe("done");
  });

  it("rejects an empty prompt and an unknown session", async () => {
    const home = homeWithFixture();
    await expect(runHeadless({ homeDir: home, prompt: "   " })).rejects.toThrow(/prompt is required/);
    await expect(runHeadless({ homeDir: home, prompt: "hi", sessionId: "ses_missing", adapter: answer("x") })).rejects.toThrow(/Session not found/);
  });

  it("continues the most recent conversation with continueLatest", async () => {
    const home = homeWithFixture();
    const workspace = tempDir("atelier-headless-ws-");
    const first = await runHeadless({ homeDir: home, workspace, prompt: "first question", adapter: answer("one") });
    const second = await runHeadless({ homeDir: home, workspace, prompt: "follow up", continueLatest: true, adapter: answer("two") });
    expect(second.sessionId).toBe(first.sessionId);
    expect(listHeadlessSessions(home)).toHaveLength(1);
  });

  it("refuses continueLatest when there is nothing to continue", async () => {
    const home = homeWithFixture();
    await expect(runHeadless({ homeDir: home, prompt: "hi", continueLatest: true, adapter: answer("x") })).rejects.toMatchObject({ code: "HEADLESS_SESSION" });
  });

  it("lists sessions newest first with id, title and updated", async () => {
    const home = homeWithFixture();
    const a = await runHeadless({ homeDir: home, prompt: "older topic", adapter: answer("a") });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = await runHeadless({ homeDir: home, prompt: "newer topic", adapter: answer("b") });
    const listed = listHeadlessSessions(home);
    expect(listed.map((session) => session.id)).toEqual([b.sessionId, a.sessionId]);
    expect(listed[0]).toMatchObject({ title: "newer topic" });
  });

  it("attaches @mentioned workspace files to a headless prompt", async () => {
    const home = homeWithFixture();
    const workspace = tempDir("atelier-headless-ws-");
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "a.ts"), "export const marker = 42;\n");
    const result = await runHeadless({ homeDir: home, workspace, prompt: "explain @src/a.ts", adapter: answer("ok") });
    const db = openDatabase(ensureHome(home));
    try {
      const row = db.db.prepare("SELECT text FROM messages WHERE session_id = ? AND role = 'user'").get(result.sessionId) as { text: string };
      expect(row.text).toContain("export const marker = 42;");
    } finally {
      db.close();
    }
  });

  it("stops at --max-turns with a blocked run that names the cap", async () => {
    const home = homeWithFixture();
    const workspace = tempDir("atelier-headless-ws-");
    const call = (id: string, path: string) => ({ events: [{ type: "tool-call" as const, id, name: "read_file", input: { path } }, { type: "finish" as const, reason: "tool_calls" as const }] });
    const adapter = new FixtureProviderAdapter({
      provider: "fixture",
      models: [{ id: "fixture-model" }],
      responses: [call("r1", "a.txt"), call("r2", "b.txt"), call("r3", "c.txt"), { events: [{ type: "text-delta", text: "late" }, { type: "finish", reason: "stop" }] }],
    });
    const result = await runHeadless({ homeDir: home, workspace, prompt: "read things", maxTurns: 2, adapter });
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("step cap reached");
  });

  it("reports each session event once, in order, while the run works", async () => {
    const home = homeWithFixture();
    const workspace = tempDir("atelier-headless-ws-");
    const seen: Array<{ seq: number; type: string; data: unknown }> = [];
    const result = await runHeadless({ homeDir: home, workspace, prompt: "summarise", adapter: answer("done"), onEvent: (event) => void seen.push(event) });
    expect(result.status).toBe("finished");
    const types = seen.map((event) => event.type);
    expect(types).toContain("run.started");
    expect(types[types.length - 1]).toBe("run.finished");
    expect(seen.map((event) => event.seq)).toEqual([...seen.map((event) => event.seq)].sort((a, b) => a - b));
    expect(new Set(seen.map((event) => event.seq)).size).toBe(seen.length);
    expect(seen.every((event) => typeof event.data === "object" && event.data !== null)).toBe(true);
  });
});
