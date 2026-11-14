import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { AtelierError, ensureHome } from "./config.js";

export interface LockInfo {
  pid: number;
  startedAt: number;
  port: number;
}

export interface LockHandle {
  path: string;
  info: LockInfo;
  release: () => void;
  heartbeat: () => void;
}

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
  port?: number;
  heartbeatMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readInfo(path: string): LockInfo | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { pid?: unknown }).pid === "number" &&
      typeof (parsed as { startedAt?: unknown }).startedAt === "number" &&
      typeof (parsed as { port?: unknown }).port === "number"
    ) {
      return parsed as LockInfo;
    }
    return null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function isStale(path: string, staleMs: number): boolean {
  try {
    const age = Date.now() - statSync(path).mtimeMs;
    if (age > staleMs) return true;
    const info = readInfo(path);
    return info !== null && !isAlive(info.pid);
  } catch {
    return true;
  }
}

export async function acquireLock(home: string, options: LockOptions = {}): Promise<LockHandle> {
  const paths = ensureHome(home);
  const timeoutMs = options.timeoutMs ?? 3000;
  const staleMs = options.staleMs ?? 30000;
  const heartbeatMs = options.heartbeatMs ?? 1000;
  const port = options.port ?? 0;
  const deadline = Date.now() + timeoutMs;
  const info: LockInfo = { pid: process.pid, startedAt: Date.now(), port };

  for (;;) {
    try {
      const fd = openSync(paths.lock, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(info));
      } finally {
        closeSync(fd);
      }
      const heartbeat = (): void => {
        try {
          const now = new Date();
          utimesSync(paths.lock, now, now);
        } catch {
          // The lock may have been released or replaced; the owner will notice on release.
        }
      };
      const timer = setInterval(heartbeat, heartbeatMs);
      timer.unref();
      return {
        path: paths.lock,
        info,
        heartbeat,
        release: () => {
          clearInterval(timer);
          const current = readInfo(paths.lock);
          if (current?.pid === process.pid) {
            try {
              unlinkSync(paths.lock);
            } catch {
              // Already gone; release is idempotent.
            }
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (isStale(paths.lock, staleMs)) {
        try {
          renameSync(paths.lock, `${paths.lock}.stale-${Date.now()}`);
        } catch {
          // Another process won the takeover; retry the create.
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new AtelierError(
          "LOCK_BUSY",
          `Another atelier server holds ${paths.lock}.`,
          "Only one writer may open the state database at a time.",
          "Stop the other atelier process, or wait for its lock to go stale.",
        );
      }
      await delay(50);
    }
  }
}
