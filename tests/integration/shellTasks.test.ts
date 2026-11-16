/**
 * Background shell tasks: the agent starts a long command, keeps working, and reads the output
 * later. These tests drive the registry directly, because the point is that a task outlives the
 * call that started it rather than that the model chooses the tool.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { killAllTasks, killTask, listTasks, readTaskOutput, startBackgroundTask } from "../../server/shellTasks";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  killAllTasks();
  // A killed child can hold its working directory for a moment on Windows, so retry the cleanup
  // instead of failing the test on a lock that resolves itself.
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Poll until the task leaves "running", because a child process exits asynchronously. */
async function settled(id: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = listTasks().find((entry) => entry.id === id);
    if (task === undefined || task.status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`task ${id} did not settle within ${timeoutMs} ms`);
}

function start(command: string): string {
  const workspace = tempDir("atelier-bg-ws-");
  const logDir = tempDir("atelier-bg-log-");
  return startBackgroundTask(command, { workspace, logDir, env: process.env, timeoutMs: 30_000 }).id;
}

describe("background shell tasks", () => {
  it("starts a task, records its output and reports the exit code", async () => {
    const id = start(process.platform === "win32" ? "echo hello-bg" : "echo hello-bg");
    await settled(id);
    const result = readTaskOutput(id);
    expect(result.output).toContain("hello-bg");
    expect(result.status).toBe("finished");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("[finished]");
  });

  it("reports a failing command as failed without failing the caller", async () => {
    const id = start("exit 3");
    await settled(id);
    const result = readTaskOutput(id);
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
  });

  it("reads from an offset and says whether more remains", async () => {
    // The reply is a header line, the log window, then a status line. The header echoes the
    // command, so only the middle can answer whether the offset really moved.
    const id = start("echo 0123456789abcdefghij");
    await settled(id);
    const body = (text: string): string => text.split("\n").slice(1, -1).join("\n");
    const whole = readTaskOutput(id, 0, 200);
    expect(body(whole.output)).toContain("0123456789abcdefghij");
    // The log is "0123456789abcdefghij\n", so offset 10 lands on "abcdefghij".
    const tail = readTaskOutput(id, 10, 200);
    expect(body(tail.output)).toContain("abcdefghij");
    expect(body(tail.output)).not.toContain("0123456789");
  });

  it("lists what this run started, newest first", async () => {
    const first = start(process.platform === "win32" ? "echo one" : "echo one");
    const second = start(process.platform === "win32" ? "echo two" : "echo two");
    await settled(first);
    await settled(second);
    const ids = listTasks().map((task) => task.id);
    expect(ids).toContain(first);
    expect(ids).toContain(second);
    expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));
  });

  it("kills a running task and its process tree", async () => {
    // A command that would run long, so the kill is what ends it rather than its own exit.
    const id = start(process.platform === "win32" ? "ping -n 30 127.0.0.1" : "sleep 30");
    const killed = killTask(id);
    expect(killed.status).toBe("killed");
    await settled(id);
    expect(listTasks().find((task) => task.id === id)?.status).toBe("killed");
    // Killing an unknown id is an error, not a silent success.
    expect(() => killTask("task_missing")).toThrow(/No background task/);
  });

  it("refuses an empty command", () => {
    expect(() => start("   ")).toThrow(/command is required/i);
  });
});
