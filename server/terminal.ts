import { spawn, type ChildProcess } from "node:child_process";
import { AtelierError } from "./config.js";
import { resolveInside } from "./tools.js";

const active = new Set<ChildProcess>();
const MAX_OUTPUT = 200_000;

export interface ExecResult {
  output: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export function execInWorkspace(root: string, command: string, cwd = ".", timeoutMs = 30_000, env: NodeJS.ProcessEnv = process.env): Promise<ExecResult> {
  const directory = resolveInside(root, cwd);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd: directory, shell: true, stdio: ["ignore", "pipe", "pipe"], env });
    active.add(child);
    let output = "";
    let settled = false;
    let timedOut = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      active.delete(child);
      clearTimeout(timer);
      resolve({ output: output.slice(0, MAX_OUTPUT), exitCode, durationMs: Date.now() - started, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      active.delete(child);
      clearTimeout(timer);
      reject(new AtelierError("TERMINAL_FAILED", "Terminal command could not start.", error.message, "Check the command and retry."));
    });
    child.on("exit", (code) => finish(code));
  });
}

function terminate(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

export function stopTerminals(): number {
  let count = 0;
  for (const child of active) {
    terminate(child);
    count += 1;
  }
  active.clear();
  return count;
}
