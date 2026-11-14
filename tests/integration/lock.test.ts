import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtelierError, ensureHome } from "../../server/config";
import { acquireLock } from "../../server/lock";

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "atelier-lock-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("single-instance lock", () => {
  it("acquires and releases idempotently", async () => {
    const home = tempHome();
    const lock = await acquireLock(home, { timeoutMs: 50 });
    expect(lock.info.pid).toBe(process.pid);
    lock.release();
    lock.release();
    const again = await acquireLock(home, { timeoutMs: 50 });
    again.release();
  });

  it("refuses a second live lock", async () => {
    const home = tempHome();
    const lock = await acquireLock(home, { timeoutMs: 50 });
    try {
      await expect(acquireLock(home, { timeoutMs: 80 })).rejects.toBeInstanceOf(AtelierError);
    } finally {
      lock.release();
    }
  });

  it("takes over a stale lock", async () => {
    const home = tempHome();
    const paths = ensureHome(home);
    writeFileSync(paths.lock, JSON.stringify({ pid: 999_999_999, startedAt: 0, port: 0 }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(paths.lock, old, old);
    const lock = await acquireLock(home, { timeoutMs: 50, staleMs: 1000 });
    expect(lock.info.pid).toBe(process.pid);
    lock.release();
  });
});
