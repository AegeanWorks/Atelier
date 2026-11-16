import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtelierError, ensureHome } from "../../server/config";
import {
  appendMessage,
  createSession,
  listEvents,
  listMessages,
  listSessions,
  openDatabase,
  recoverOnBoot,
} from "../../server/db";

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "atelier-db-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("database", () => {
  it("opens WAL with explicit FULL synchronous and schema 10", () => {
    const paths = ensureHome(tempHome());
    const handle = openDatabase(paths);
    try {
      expect(handle.quickCheck()).toBe("ok");
      expect(handle.schemaVersion).toBe(10);
      expect(Number(handle.sqliteVersion.split(".")[0])).toBeGreaterThanOrEqual(3);
      expect(String(handle.db.pragma("journal_mode", { simple: true }))).toBe("wal");
      expect(String(handle.db.pragma("synchronous", { simple: true }))).toBe("2");
    } finally {
      handle.close();
    }
  });

  it("creates sessions and appends durable events", () => {
    const paths = ensureHome(tempHome());
    const handle = openDatabase(paths);
    try {
      const session = createSession(handle, "First");
      expect(listSessions(handle)).toHaveLength(1);
      const event = listEvents(handle, session.id)[0];
      expect(event?.type).toBe("session.created");
    } finally {
      handle.close();
    }
  });

  it("deduplicates a repeated clientId inside one session", () => {
    const paths = ensureHome(tempHome());
    const handle = openDatabase(paths);
    try {
      const session = createSession(handle, "Dedupe");
      const first = appendMessage(handle, session.id, "user", "hello", "client-1");
      const second = appendMessage(handle, session.id, "user", "hello", "client-1");
      expect(second.id).toBe(first.id);
      expect(listMessages(handle, session.id)).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it("keeps a fresh boot clean and rebuilds the projection only when messages exist", () => {
    const paths = ensureHome(tempHome());
    const handle = openDatabase(paths);
    try {
      const first = recoverOnBoot(handle);
      expect(first.result).toBe("clean");
      expect(first.actions).toEqual([]);
      const version = handle.db.prepare("SELECT value FROM meta WHERE key = 'projection_version'").get() as { value: string };
      expect(version.value).toBe("1");

      const session = createSession(handle, "Rebuild");
      appendMessage(handle, session.id, "assistant", "hello", null);
      handle.db.prepare("DELETE FROM meta WHERE key = 'projection_version'").run();
      const rebuilt = recoverOnBoot(handle);
      expect(rebuilt.result).toBe("recovered");
      expect(rebuilt.actions.some((action) => action.startsWith("projection rebuilt (1 message event(s))"))).toBe(true);

      const clean = recoverOnBoot(handle);
      expect(clean.result).toBe("clean");
      const count = handle.db.prepare("SELECT COUNT(*) AS n FROM recovery_log").get() as { n: number };
      expect(count.n).toBe(3);
    } finally {
      handle.close();
    }
  });

  it("refuses a newer schema without modifying it", () => {
    const paths = ensureHome(tempHome());
    const handle = openDatabase(paths);
    handle.close();
    const raw = new Database(paths.db);
    raw.pragma("user_version = 999");
    raw.close();
    expect(() => openDatabase(paths)).toThrow(AtelierError);
  });
});
