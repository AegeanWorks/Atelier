/**
 * A run that keeps failing must stop. Harness counts consecutive failed results and ends the
 * run; atelier only stopped an identical call repeated, so a model could retry with slightly
 * different arguments and burn every step and dollar on calls that all fail.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHome } from "../../server/config";
import { createSession, listEvents, openDatabase, type DbHandle } from "../../server/db";
import { FixtureProviderAdapter } from "../../server/eval/fixtures";
import type { FixtureResponse } from "../../server/eval/types";
import { executeRun, stopSessionRun, whenRunsSettled } from "../../server/runner";
import { createRun, getRun } from "../../server/runs";
import { loadConfig, saveConfig } from "../../server/state";

const dirs: string[] = [];
const handles: DbHandle[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function setup(): { handle: DbHandle; workspace: string } {
  const home = tempDir("atelier-streak-home-");
  const workspace = tempDir("atelier-streak-ws-");
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

function call(id: string, name: string, input: Record<string, unknown> = {}): FixtureResponse {
  return { events: [{ type: "tool-call", id, name, input }, { type: "finish", reason: "tool_calls" }] };
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

describe("a run whose tool calls keep failing", () => {
  it("blocks after three different failed calls instead of spending the step budget", async () => {
    const { handle, workspace } = setup();
    const session = createSession(handle, "streak test");
    const run = createRun(handle, session.id, null, null, workspace);
    const adapter = new FixtureProviderAdapter({
      provider: "fixture",
      models: [{ id: "fixture-model" }],
      responses: [
        call("f1", "nope_one"),
        call("f2", "nope_two"),
        call("f3", "nope_three"),
        call("f4", "nope_four"),
        { events: [{ type: "text-delta", text: "should not get here" }, { type: "finish", reason: "stop" }] },
      ],
    });
    await executeRun(handle, run.id, { adapter, approve: () => true });
    const finished = getRun(handle, run.id);
    expect(finished?.status).toBe("blocked");
    expect(`${finished?.blocked_reason ?? ""} ${finished?.error ?? ""}`).toMatch(/consecutive/);
    const results = listEvents(handle, session.id).filter((event) => event.type === "tool.result");
    expect(results.length).toBe(3);
    expect(results.every((event) => JSON.parse(event.data).ok === false)).toBe(true);
  }, 30_000);

  it("lets a success reset the count, so a failure can be diagnosed and retried", async () => {
    const { handle, workspace } = setup();
    writeFileSync(join(workspace, "notes.txt"), "the answer is 42\n", "utf-8");
    const session = createSession(handle, "streak reset test");
    const run = createRun(handle, session.id, null, null, workspace);
    const adapter = new FixtureProviderAdapter({
      provider: "fixture",
      models: [{ id: "fixture-model" }],
      responses: [
        call("f1", "nope_one"),
        call("ok1", "read_file", { path: "notes.txt" }),
        call("f2", "nope_two"),
        { events: [{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }] },
      ],
    });
    await executeRun(handle, run.id, { adapter, approve: () => true });
    expect(getRun(handle, run.id)?.status).toBe("finished");
    const results = listEvents(handle, session.id).filter((event) => event.type === "tool.result");
    expect(results.map((event) => JSON.parse(event.data).ok)).toEqual([false, true, false]);
  }, 30_000);
});
