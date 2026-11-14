import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHome } from "../../server/config";
import { appendMessage, createSession, getSession, listMessages, listSessions, openDatabase, type DbHandle } from "../../server/db";
import { forkSession } from "../../server/fork";

const dirs: string[] = [];
const handles: DbHandle[] = [];

function setup(): DbHandle {
  const home = mkdtempSync(join(tmpdir(), "atelier-fork-"));
  dirs.push(home);
  const handle = openDatabase(ensureHome(home));
  handles.push(handle);
  return handle;
}
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function conversation(handle: DbHandle) {
  const source = createSession(handle, "Fix the parser");
  const a = appendMessage(handle, source.id, "user", "first", "c1");
  const b = appendMessage(handle, source.id, "assistant", "second", null);
  const c = appendMessage(handle, source.id, "user", "third", "c2");
  return { source, a, b, c };
}

describe("forkSession", () => {
  it("copies the whole conversation into a new one and leaves the source untouched", () => {
    const handle = setup();
    const { source } = conversation(handle);
    const fork = forkSession(handle, source.id);
    expect(fork.id).not.toBe(source.id);
    expect(fork.title).toBe("Fork: Fix the parser");
    const copied = listMessages(handle, fork.id);
    expect(copied.map((m) => [m.role, m.text])).toEqual([["user", "first"], ["assistant", "second"], ["user", "third"]]);
    expect(copied.every((m) => m.client_id === null)).toBe(true);
    expect(listMessages(handle, source.id)).toHaveLength(3);
    expect(getSession(handle, source.id)?.title).toBe("Fix the parser");
    expect(listSessions(handle)).toHaveLength(2);
  });

  it("forks up to and including a chosen message", () => {
    const handle = setup();
    const { source, b } = conversation(handle);
    const fork = forkSession(handle, source.id, b.id);
    expect(listMessages(handle, fork.id).map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("keeps attachment markers so a forked image or file still resolves", () => {
    const handle = setup();
    const source = createSession(handle, "Pic");
    const text = 'look\n\n<attached_image id="0123456789abcdef.png"/>';
    appendMessage(handle, source.id, "user", text, null);
    expect(listMessages(handle, forkSession(handle, source.id).id)[0]?.text).toBe(text);
  });

  it("rejects an unknown session, an unknown message, a message from another conversation and an empty one", () => {
    const handle = setup();
    const { source } = conversation(handle);
    const other = createSession(handle, "Other");
    const foreign = appendMessage(handle, other.id, "user", "x", null);
    expect(() => forkSession(handle, "ses_nope")).toThrowError(/not found/i);
    expect(() => forkSession(handle, source.id, "msg_nope")).toThrowError(/not found/i);
    expect(() => forkSession(handle, source.id, foreign.id)).toThrowError(/not found/i);
    expect(() => forkSession(handle, createSession(handle, "Empty").id)).toThrowError(/nothing to fork/i);
    expect(listSessions(handle)).toHaveLength(3);
  });
});
