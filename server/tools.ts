import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { AtelierError } from "./config.js";
import type { DbHandle } from "./db.js";
import { beginEffect, effectKey, finishEffect } from "./effects.js";
import { checkPermission, isInside, type Mode } from "./permissions.js";
import { checkpointPath } from "./checkpoints.js";
import { hashRequest } from "./providers/http.js";
import { appendSessionEvent, type RunRow } from "./runs.js";
import { formatHits, matchGlob, searchText, walkWorkspace } from "./search.js";
import { applyMultiEdit, applyTextEdit } from "./edits.js";
import type { ToolSchema } from "./providers/types.js";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolOutcome {
  ok: boolean;
  output: string;
  effectKey?: string | undefined;
}

interface ToolContext {
  workspace: string;
  mode: Mode;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  action: "read" | "edit" | "exec";
  readOnly: boolean;
  run: (args: Record<string, unknown>, context: ToolContext) => Promise<string> | string;
}

const MAX_OUTPUT = 50_000;

function clip(value: string): string {
  return value.length <= MAX_OUTPUT ? value : `${value.slice(0, MAX_OUTPUT)}\n… output clipped at ${MAX_OUTPUT} characters`;
}

function killProcessTree(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5_000 });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}

interface ShellResult {
  output: string;
  code: number | null;
  timedOut: boolean;
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const limit = 1_000_000;
    let output = "";
    const append = (chunk: Buffer | string): void => {
      if (output.length >= limit) return;
      output += chunk.toString().slice(0, limit - output.length);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);
    const finish = (code: number | null, extra = ""): void => {
      clearTimeout(timer);
      if (extra.length > 0) append(extra);
      resolve({ output, code, timedOut });
    };
    child.on("error", (error) => finish(null, `${error.message}\n`));
    child.on("close", (code) => finish(code));
  });
}

/** The real location of a path, even one that does not exist yet: the nearest existing ancestor, resolved through links. */
function realLocation(path: string): string {
  let existing = path;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync.native(existing), ...missing);
}

export function resolveInside(root: string, target: string): string {
  const path = isAbsolute(target) ? resolve(target) : resolve(root, target);
  if (!isInside(root, path)) throw new AtelierError("PATH_JAIL", "Path escapes the workspace.", target, "Use a repository-relative path.");
  // A symlink or junction inside the workspace can point outside it, so the lexical check above is not enough.
  let escapes = false;
  try {
    escapes = !isInside(realpathSync.native(root), realLocation(path));
  } catch {
    escapes = true;
  }
  if (escapes) throw new AtelierError("PATH_JAIL", "Path escapes the workspace.", target, "A link inside the workspace leads outside it; use a path that stays inside.");
  const rel = relative(root, path).split(/[\\/]/);
  if (rel.includes(".git")) throw new AtelierError("PATH_JAIL", "Path targets .git internals.", target, "Do not read or write .git.");
  return path;
}

export function hashFile(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

export function atomicWrite(path: string, content: string, mode = 0o644): void {
  const temp = `${path}.tmp_${process.pid}_${Date.now()}`;
  let fd: number | null = null;
  try {
    fd = openSync(temp, "w", mode);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        renameSync(temp, path);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!["EPERM", "EBUSY", "EACCES"].includes(code ?? "") || attempt === 4) throw error;
      }
    }
    try {
      const dirFd = openSync(dirname(path), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Directory fsync is unavailable on Windows.
    }
  } finally {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      // Rename consumed the temp file.
    }
  }
}

const TOOLS: Record<string, ToolDefinition> = {

  read_file: {
    name: "read_file",
    description: "Read a line-numbered window from a file inside the workspace.",
    parameters: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 2000 } },
    },
    action: "read",
    readOnly: true,
    run(args, context) {
      const path = resolveInside(context.workspace, String(args.path));
      if (!existsSync(path)) throw new AtelierError("READ_MISSING", `File not found: ${String(args.path)}.`, "The path does not exist in the workspace.", "Use list_dir or glob to find the file.");
      const lines = readFileSync(path, "utf8").split(/\r?\n/);
      const offset = Math.max(1, Number(args.offset ?? 1));
      const limit = Math.min(2000, Math.max(1, Number(args.limit ?? 200)));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      return clip(slice.map((line, index) => `${offset + index}: ${line}`).join("\n"));
    },
  },
  list_dir: {
    name: "list_dir",
    description: "List files and directories at a workspace-relative path.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    action: "read",
    readOnly: true,
    run(args, context) {
      const path = resolveInside(context.workspace, String(args.path ?? "."));
      const entries = readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.name !== "node_modules" && entry.name !== ".git")
        .map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}${entry.isDirectory() ? "/" : ""}`)
        .sort()
        .slice(0, 500);
      return clip(entries.join("\n"));
    },
  },
  glob: {
    name: "glob",
    description: "Find workspace files by a glob pattern such as src/**/*.ts.",
    parameters: { type: "object", required: ["pattern"], properties: { pattern: { type: "string" } } },
    action: "read",
    readOnly: true,
    run(args, context) {
      const matches = matchGlob(walkWorkspace(context.workspace), String(args.pattern));
      return clip(matches.join("\n"));
    },
  },
  ripgrep: {
    name: "ripgrep",
    description: "Search workspace text with ripgrep when available, otherwise with a built-in search; capped at 100 hits.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        path: { type: "string" },
        include: { type: "string", description: "Optional glob such as src/**/*.ts" },
        ignoreCase: { type: "boolean" },
        fixed: { type: "boolean", description: "Treat the query as literal text" },
      },
    },
    action: "read",
    readOnly: true,
    run(args, context) {
      const include = typeof args.include === "string" && args.include.length > 0 ? args.include : undefined;
      const result = spawnSync(
        "rg",
        [
          "-n",
          "--max-count",
          "100",
          ...(args.ignoreCase === true ? ["-i"] : []),
          ...(args.fixed === true ? ["-F"] : []),
          ...(include === undefined ? [] : ["-g", include]),
          String(args.query),
          resolveInside(context.workspace, String(args.path ?? ".")),
        ],
        { cwd: context.workspace, encoding: "utf8", timeout: 10_000, maxBuffer: 1_000_000 },
      );
      if (result.error === undefined && result.status === 0) return clip(result.stdout);
      if (result.error === undefined && result.status === 1) return "";
      if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AtelierError("RG_FAILED", "ripgrep failed.", result.error.message, "Narrow the query.");
      }
      try {
        const search = searchText(context.workspace, {
          query: String(args.query),
          ...(typeof args.path === "string" ? { path: args.path } : {}),
          ...(include === undefined ? {} : { include }),
          ignoreCase: args.ignoreCase === true,
          fixed: args.fixed === true,
          maxHits: 100,
        });
        if (search.hits.length === 0) return "";
        const suffix = search.truncated ? `\n… capped at ${search.hits.length} hits` : "";
        return clip(`${formatHits(search.hits)}${suffix}`);
      } catch (error) {
        throw new AtelierError(
          "SEARCH_FAILED",
          "The search pattern is invalid.",
          error instanceof Error ? error.message : String(error),
          "Provide a valid regular expression, or set fixed=true for literal text.",
        );
      }
    },
  },
  write_file: {
    name: "write_file",
    description: "Write a complete file atomically inside the workspace.",
    parameters: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } },
    action: "edit",
    readOnly: false,
    run(args, context) {
      const path = resolveInside(context.workspace, String(args.path));
      atomicWrite(path, String(args.content));
      return `wrote ${String(args.path)} (${Buffer.byteLength(String(args.content), "utf8")} bytes)`;
    },
  },
  edit_file: {
    name: "edit_file",
    description: "Replace one exact string in a file and write atomically; set replaceAll to replace every occurrence.",
    parameters: {
      type: "object",
      required: ["path", "oldString", "newString"],
      properties: {
        path: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
        replaceAll: { type: "boolean" },
      },
    },
    action: "edit",
    readOnly: false,
    run(args, context) {
      const path = resolveInside(context.workspace, String(args.path));
      const text = readFileSync(path, "utf8");
      const applied = applyTextEdit(text, {
        oldString: String(args.oldString),
        newString: String(args.newString),
        replaceAll: args.replaceAll === true,
      });
      atomicWrite(path, applied.text);
      return `edited ${String(args.path)} (${applied.replacements} replacement(s))`;
    },
  },
  multi_edit: {
    name: "multi_edit",
    description: "Apply several exact-string edits to one file as one atomic write, all or nothing.",
    parameters: {
      type: "object",
      required: ["path", "edits"],
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            required: ["oldString", "newString"],
            properties: {
              oldString: { type: "string" },
              newString: { type: "string" },
              replaceAll: { type: "boolean" },
            },
          },
        },
      },
    },
    action: "edit",
    readOnly: false,
    run(args, context) {
      const path = resolveInside(context.workspace, String(args.path));
      const edits = Array.isArray(args.edits) ? (args.edits as unknown[]) : [];
      const applied = applyMultiEdit(
        readFileSync(path, "utf8"),
        edits.map((raw) => {
          const edit = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
          return { oldString: String(edit.oldString ?? ""), newString: String(edit.newString ?? ""), replaceAll: edit.replaceAll === true };
        }),
      );
      atomicWrite(path, applied.text);
      return `edited ${String(args.path)} (${applied.replacements} replacement(s) across ${edits.length} edit(s))`;
    },
  },
  bash: {
    name: "bash",
    description: "Run a shell command in the workspace with a timeout and output cap.",
    parameters: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000, description: "Wall-clock limit; default 30000" },
      },
    },
    action: "exec",
    readOnly: false,
    async run(args, context) {
      const timeoutMs = Math.min(600_000, Math.max(1_000, Number(args.timeoutMs ?? 30_000)));
      const result = await runShell(String(args.command), context.workspace, timeoutMs);
      if (result.timedOut) return clip(`timed out after ${timeoutMs} ms\n${result.output}`);
      return clip(`exit ${result.code ?? "signal"}\n${result.output}`);
    },
  },
  delegate: {
    name: "delegate",
    description: "Delegate a bounded read-only brief to a nested agent and return its answer.",
    parameters: { type: "object", required: ["brief"], properties: { brief: { type: "string" }, background: { type: "boolean" } } },
    action: "read",
    readOnly: true,
    run() {
      throw new AtelierError("DELEGATE_CONTEXT", "delegate must run inside the agent loop.", "The tool needs the run's provider context.", "Call it through the agent loop.");
    },
  },
  todo_write: {
    name: "todo_write",
    description:
      "Replace the visible task list for this conversation. Send the whole list each time; use it for work with three or more steps, mark exactly one item in_progress, and mark items completed as you finish them.",
    parameters: {
      type: "object",
      required: ["todos"],
      properties: {
        todos: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            required: ["text", "status"],
            properties: {
              id: { type: "string" },
              text: { type: "string", maxLength: 200 },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
          },
        },
      },
    },
    action: "read",
    readOnly: true,
    run() {
      throw new AtelierError("TODO_CONTEXT", "todo_write must run inside the agent loop.", "The tool needs the session to publish the list.", "Call it through the agent loop.");
    },
  },
  wait: {
    name: "wait",
    description: "Wait a bounded number of milliseconds before continuing.",
    parameters: { type: "object", properties: { ms: { type: "integer", minimum: 1, maximum: 5000 }, reason: { type: "string" } } },
    action: "read",
    readOnly: true,
    async run(args) {
      const ms = Math.min(5000, Math.max(1, Number(args.ms ?? 100)));
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `waited ${ms}ms${typeof args.reason === "string" ? `: ${args.reason}` : ""}`;
    },
  },
  git_status: {
    name: "git_status",
    description: "Show git status for the workspace.",
    parameters: { type: "object", properties: {} },
    action: "read",
    readOnly: true,
    run(_args, context) {
      const result = spawnSync("git", ["-C", context.workspace, "status", "--short", "--branch"], { encoding: "utf8", timeout: 10_000 });
      if (result.status !== 0) throw new AtelierError("GIT_STATUS", "git status failed.", result.stderr ?? "", "Check that the workspace is a git repository.");
      return clip(result.stdout);
    },
  },
  git_diff: {
    name: "git_diff",
    description: "Show a capped git diff for the workspace.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    action: "read",
    readOnly: true,
    run(args, context) {
      const command = ["-C", context.workspace, "diff", "-U3"];
      if (typeof args.path === "string") command.push("--", args.path);
      const result = spawnSync("git", command, { encoding: "utf8", timeout: 10_000 });
      if (result.status !== 0) throw new AtelierError("GIT_DIFF", "git diff failed.", result.stderr ?? "", "Check the workspace.");
      return clip(result.stdout);
    },
  },
};

export function toolSchemas(names?: string[]): ToolSchema[] {
  const all = Object.values(TOOLS).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  if (names === undefined) return all;
  const allowed = new Set(names);
  return all.filter((tool) => allowed.has(tool.name));
}

export function toolAction(name: string): "read" | "edit" | "exec" | null {
  return TOOLS[name]?.action ?? null;
}

export async function executeTool(
  handle: DbHandle,
  run: RunRow,
  mode: Mode,
  call: ToolCall,
): Promise<ToolOutcome> {
  const tool = TOOLS[call.name];
  if (tool === undefined) return { ok: false, output: `Unknown tool '${call.name}'.` };
  const input = typeof call.input === "object" && call.input !== null ? (call.input as Record<string, unknown>) : {};
  const resource = tool.action === "exec" ? String(input.command ?? "") : String(input.path ?? ".");
  const permission = checkPermission(run.workspace ?? process.cwd(), mode, tool.action, resource);
  appendSessionEvent(handle, run.session_id, "access.decision", {
    runId: run.id,
    callId: call.id,
    tool: call.name,
    action: tool.action,
    resource,
    decision: permission.decision,
    reason: permission.reason,
  });
  if (permission.decision === "deny") return { ok: false, output: `Permission denied: ${permission.reason}` };

  if (tool.readOnly) {
    try {
      return { ok: true, output: await tool.run(input, { workspace: run.workspace ?? process.cwd(), mode }) };
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) };
    }
  }

  const path = tool.action === "edit" ? resolveInside(run.workspace ?? process.cwd(), String(input.path)) : null;
  const preHash = path === null ? null : hashFile(path);
  const key = effectKey(run.id, call.id, call.name, input, preHash);
  const existing = beginEffect(handle, { effectKey: key, runId: run.id, tool: call.name, argsHash: hashRequest(input), preHash });
  if (existing.status === "applied" && existing.result !== null) return { ok: true, output: existing.result, effectKey: key };
  if (path !== null) {
    try {
      const checkpoint = checkpointPath(run.workspace ?? process.cwd(), String(input.path), call.name, handle.paths.home);
      if (checkpoint !== null) appendSessionEvent(handle, run.session_id, "checkpoint.created", { runId: run.id, callId: call.id, tool: call.name, commit: checkpoint.commit, path: checkpoint.path });
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) };
    }
  }
  try {
    const output = await tool.run(input, { workspace: run.workspace ?? process.cwd(), mode });
    finishEffect(handle, key, "applied", output, path === null ? null : hashFile(path));
    return { ok: true, output, effectKey: key };
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error);
    finishEffect(handle, key, "failed", output, path === null ? null : hashFile(path));
    return { ok: false, output, effectKey: key };
  }
}
