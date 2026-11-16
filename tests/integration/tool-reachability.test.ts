/**
 * A tool that exists in the registry but is not in the live profile's toolNames is invisible to
 * the model: the capability looks present and cannot be used, the same failure as a parameter
 * that is advertised and ignored. This pins both halves — every registered tool is exposed, and
 * the background-shell tools really work through the agent's own dispatch path.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHome } from "../../server/config";
import { createSession, openDatabase } from "../../server/db";
import { FULL_PROFILE } from "../../server/eval/harness";
import { createRun } from "../../server/runs";
import { executeTool, toolSchemas } from "../../server/tools";
import { killAllTasks } from "../../server/shellTasks";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  killAllTasks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("tool reachability", () => {
  it("exposes every registered tool to the live profile", () => {
    const registered = toolSchemas().map((tool) => tool.name);
    // `mcp` is not a tool a model calls: it stands for the dynamic mcp__<server>__<tool> names,
    // which the loop adds per configured server.
    const exposed = new Set(FULL_PROFILE.toolNames.filter((name) => name !== "mcp"));
    const missing = registered.filter((name) => !exposed.has(name));
    expect(missing).toEqual([]);
  });

  it("dispatches a background task through the agent's own tool path", async () => {
    const workspace = tempDir("atelier-reach-ws-");
    const db = openDatabase(ensureHome(tempDir("atelier-reach-home-")));
    try {
      const run = createRun(db, createSession(db, "reachability").id, null, null, workspace);

      const started = await executeTool(db, run, "build", { id: "c1", name: "bash", input: { command: "echo reachable", run_in_background: true } });
      expect(started.ok).toBe(true);
      const taskId = /started (task_[a-z0-9_]+)/.exec(started.output)?.[1] ?? "";
      expect(taskId).not.toBe("");

      const listed = await executeTool(db, run, "build", { id: "c2", name: "shell_tasks", input: {} });
      expect(listed.ok).toBe(true);
      expect(listed.output).toContain(taskId);

      // The child writes asynchronously, so wait for its output rather than assuming it landed.
      const deadline = Date.now() + 5_000;
      let text = "";
      while (Date.now() < deadline) {
        const output = await executeTool(db, run, "build", { id: "c3", name: "shell_output", input: { id: taskId } });
        text = output.output;
        if (text.includes("reachable")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(text).toContain("reachable");

      const killed = await executeTool(db, run, "build", { id: "c4", name: "kill_shell", input: { id: taskId } });
      expect(killed.ok).toBe(true);
    } finally {
      db.close();
    }
  });
});
