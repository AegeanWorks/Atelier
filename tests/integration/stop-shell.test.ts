/**
 * Stopping a run must stop the command it started. The harness's loop polls its stop switch
 * while a child runs and kills it; atelier used to abort only the loop, so a 30 s command kept
 * running after the UI said stopped and the run stayed pending behind it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHome } from "../../server/config";
import { createSession, listEvents, openDatabase, type DbHandle } from "../../server/db";
import { FixtureProviderAdapter } from "../../server/eval/fixtures";
import { executeRun, stopSessionRun, whenRunsSettled } from "../../server/runner";
import { createRun, getRun } from "../../server/runs";
import { loadConfig, saveConfig } from "../../server/state";
import { executeTool } from "../../server/tools";

const dirs: string[] = [];
const handles: DbHandle[] = [];
const LONG = process.platform === "win32" ? "ping -n 30 127.0.0.1" : "sleep 30";

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function setup(): { handle: DbHandle; workspace: string } {
  const home = tempDir("atelier-stop-home-");
  const workspace = tempDir("atelier-stop-ws-");
  const paths = ensureHome(home);
  saveConfig(paths, {
    ...loadConfig(paths),
    providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
    defaults: { provider: "fixture", model: "fixture-model" },
  });
  const handle = openDatabase(paths);
  handles.push(handle);
  return { handle, workspace };
}

function shellRun(): FixtureProviderAdapter {
  return new FixtureProviderAdapter({
    provider: "fixture",
    models: [{ id: "fixture-model" }],
    responses: [
      { events: [{ type: "tool-call", id: "s1", name: "bash", input: { command: LONG, timeoutMs: 60_000 } }, { type: "finish", reason: "tool_calls" }] },
      { events: [{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }] },
    ],
  });
}

afterEach(async () => {
  for (const handle of handles) {
    const waiting = handle.db.prepare("SELECT DISTINCT session_id FROM runs WHERE status = 'running'").all() as Array<{ session_id: string }>;
    for (const row of waiting) stopSessionRun(handle, row.session_id);
  }
  await whenRunsSettled();
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("stopping an in-flight shell", () => {
  it("settles a stopped run in seconds instead of waiting for its command", async () => {
    const { handle, workspace } = setup();
    const session = createSession(handle, "stop test");
    const run = createRun(handle, session.id, null, null, workspace);
    const started = performance.now();
    const running = executeRun(handle, run.id, { adapter: shellRun(), approve: () => true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    stopSessionRun(handle, session.id);
    await running;
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(10_000);
    const finished = getRun(handle, run.id);
    expect(finished?.status).toBe("blocked");
    expect(`${finished?.blocked_reason ?? ""} ${finished?.error ?? ""}`).toMatch(/stopped/);
    const results = listEvents(handle, session.id).filter((event) => event.type === "tool.result");
    expect(results.length).toBe(1);
    expect(JSON.parse(results[0]?.data ?? "{}").output).toContain("stopped by stop request");
  }, 20_000);

  it("resolves a command whose signal is aborted, and still runs one that is not", async () => {
    const { handle, workspace } = setup();
    const session = createSession(handle, "tool test");
    const run = createRun(handle, session.id, null, null, workspace);
    const controller = new AbortController();
    const startedAt = performance.now();
    const stopped = executeTool(handle, run, "build", { id: "s1", name: "bash", input: { command: LONG, timeoutMs: 60_000 } }, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("stopped")), 300);
    const outcome = await stopped;
    expect(performance.now() - startedAt).toBeLessThan(10_000);
    expect(outcome.output).toContain("stopped by stop request");
    const normal = await executeTool(handle, run, "build", { id: "s2", name: "bash", input: { command: "echo still-works", timeoutMs: 5_000 } });
    expect(normal.output).toContain("still-works");
  }, 20_000);
});
