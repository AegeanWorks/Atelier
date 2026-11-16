import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AtelierError } from "./config.js";

/**
 * Commands the agent started but does not wait for.
 *
 * A build, a watch, or a long test run should not block the loop: the agent starts it, is told
 * where its output goes, and reads that output later. Each task is a real child process with its
 * own log file, so the model never has to hold a handle to read a result.
 */

export type TaskStatus = "running" | "finished" | "failed" | "killed";

export interface BackgroundTask {
  id: string;
  command: string;
  cwd: string;
  logPath: string;
  startedAt: number;
  status: TaskStatus;
  exitCode: number | null;
  /** Why the task ended early, when it did. */
  note: string | null;
  /** Bytes written to the log so far, so the ceiling is a counter rather than a stat per chunk. */
  bytes: number;
  /** The log hit its ceiling and stopped growing. */
  truncated: boolean;
  child: ChildProcess;
}

/** How many finished tasks one run may keep listed before the oldest is forgotten. */
const MAX_TASKS = 40;
/** A task still running after this long is killed, so nothing outlives the process. */
const MAX_LIFETIME_MS = 30 * 60_000;
/**
 * How much of one command's output is kept. Measured: a chatty command wrote 2.9 MB in three
 * seconds, so without a ceiling a stray `yes` fills the state directory. Past this the log stops
 * growing and the task is marked truncated, rather than the whole disk filling.
 */
const MAX_LOG_BYTES = 1_000_000;

const TASKS = new Map<string, BackgroundTask>();

function isAlive(task: BackgroundTask): boolean {
  return task.status === "running" && task.exitCode === null;
}

/** Kill a task's whole process tree, the same way a timed-out foreground command is stopped. */
function killTree(task: BackgroundTask): void {
  const pid = task.child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Drop the oldest finished tasks so a long session cannot grow this map without bound. */
function trim(): void {
  if (TASKS.size <= MAX_TASKS) return;
  const finished = [...TASKS.values()].filter((task) => !isAlive(task)).sort((left, right) => left.startedAt - right.startedAt);
  for (const task of finished.slice(0, TASKS.size - MAX_TASKS)) TASKS.delete(task.id);
}

export interface StartOptions {
  workspace: string;
  /** Directory for one run's logs, inside the state home so it never pollutes the project. */
  logDir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export function startBackgroundTask(command: string, options: StartOptions): BackgroundTask {
  if (command.trim().length === 0) throw new AtelierError("TASK_COMMAND", "A background command is required.", "The command was empty.", "Pass the command to run.");
  mkdirSync(options.logDir, { recursive: true });
  const id = `task_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const logPath = join(options.logDir, `${id}.log`);
  // The log exists before the process starts, so reading it early is never an error.
  writeFileSync(logPath, "", "utf8");
  const child = spawn(command, {
    cwd: options.workspace,
    env: options.env,
    shell: true,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const task: BackgroundTask = {
    id,
    command,
    cwd: options.workspace,
    logPath,
    startedAt: Date.now(),
    status: "running",
    exitCode: null,
    note: null,
    bytes: 0,
    truncated: false,
    child,
  };
  const append = (chunk: Buffer | string): void => {
    // Past the ceiling the log stops growing; the task keeps running and says so when read, so a
    // runaway command cannot fill the state directory.
    if (task.truncated) return;
    const text = chunk.toString();
    if (task.bytes + Buffer.byteLength(text) > MAX_LOG_BYTES) {
      const room = Math.max(0, MAX_LOG_BYTES - task.bytes);
      if (room > 0) {
        try {
          writeFileSync(logPath, text.slice(0, room), { flag: "a" });
        } catch {
          // A log that cannot grow must not take the task down with it.
        }
        task.bytes += room;
      }
      task.truncated = true;
      return;
    }
    try {
      writeFileSync(logPath, text, { flag: "a" });
      task.bytes += Buffer.byteLength(text);
    } catch {
      // A log that cannot grow must not take the task down with it.
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", (error) => {
    task.status = "failed";
    task.note = error.message;
    append(`\n${error.message}\n`);
  });
  child.on("close", (code) => {
    task.exitCode = code;
    if (task.status === "killed") return;
    task.status = code === 0 ? "finished" : "failed";
  });
  const lifetime = setTimeout(() => {
    if (!isAlive(task)) return;
    task.status = "killed";
    task.note = `still running after ${Math.round(MAX_LIFETIME_MS / 60_000)} minutes`;
    killTree(task);
  }, options.timeoutMs);
  lifetime.unref();
  TASKS.set(id, task);
  trim();
  return task;
}

export interface TaskOutput {
  id: string;
  status: TaskStatus;
  exitCode: number | null;
  command: string;
  elapsedMs: number;
  output: string;
  truncated: boolean;
}

/** Read a task's log from `fromOffset`, bounded, so a chatty build cannot flood the context. */
export function readTaskOutput(id: string, fromOffset = 0, maxChars = 8_000): TaskOutput {
  const task = TASKS.get(id);
  if (task === undefined) throw new AtelierError("TASK_UNKNOWN", `No background task ${id}.`, "The task id is unknown to this run.", "Use shell_tasks to list the tasks this run started.");
  // Seek to the offset and read only the window. A measured 2.9 MB log cost a full 19 ms load
  // to answer a 200-character question, so this never reads more than it is about to return.
  const start = Math.max(0, fromOffset);
  let slice = "";
  let total = 0;
  if (existsSync(task.logPath)) {
    try {
      total = statSync(task.logPath).size;
      const length = Math.max(0, Math.min(maxChars, total - start));
      if (length > 0) {
        const handle = openSync(task.logPath, "r");
        try {
          const buffer = Buffer.alloc(length);
          const read = readSync(handle, buffer, 0, length, start);
          slice = buffer.subarray(0, read).toString("utf8");
        } finally {
          closeSync(handle);
        }
      }
    } catch {
      slice = "";
    }
  }
  const header = `${task.id} ${task.status} exit=${task.exitCode ?? "-"} ${task.command.slice(0, 80)}`;
  const suffix = task.status === "running" ? "\n[still running]" : "\n[finished]";
  const truncation = task.truncated ? `\n[log truncated at ${MAX_LOG_BYTES} bytes]` : "";
  return {
    id: task.id,
    status: task.status,
    exitCode: task.exitCode,
    command: task.command,
    elapsedMs: Date.now() - task.startedAt,
    output: `${header}\n${slice}${truncation}${suffix}`,
    truncated: total > start + maxChars || task.truncated,
  };
}

export function listTasks(): Array<{ id: string; status: TaskStatus; exitCode: number | null; command: string; elapsedMs: number }> {
  return [...TASKS.values()]
    .sort((left, right) => right.startedAt - left.startedAt)
    .map((task) => ({ id: task.id, status: task.status, exitCode: task.exitCode, command: task.command, elapsedMs: Date.now() - task.startedAt }));
}

export function killTask(id: string): { id: string; status: TaskStatus } {
  const task = TASKS.get(id);
  if (task === undefined) throw new AtelierError("TASK_UNKNOWN", `No background task ${id}.`, "The task id is unknown to this run.", "Use shell_tasks to list the tasks this run started.");
  if (isAlive(task)) {
    task.status = "killed";
    task.note = "stopped by the agent";
    killTree(task);
  }
  return { id: task.id, status: task.status };
}

/** Stop every task this process started, so nothing outlives the server. */
export function killAllTasks(): void {
  for (const task of TASKS.values()) {
    if (isAlive(task)) {
      task.status = "killed";
      task.note = "stopped when the server exited";
      killTree(task);
    }
  }
}
