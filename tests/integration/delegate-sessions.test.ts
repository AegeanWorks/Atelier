import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import { createAuth } from "../../server/auth";
import { ensureHome } from "../../server/config";
import { appendMessage, createSession, getSession, listSessions, openDatabase, recoverOnBoot, type DbHandle } from "../../server/db";
import { listHeadlessSessions } from "../../server/headless";
import { createRun } from "../../server/runs";

const dirs: string[] = [];
const handles: DbHandle[] = [];

function setup(): { handle: DbHandle; home: string } {
  const home = mkdtempSync(join(tmpdir(), "atelier-delegates-"));
  dirs.push(home);
  const handle = openDatabase(ensureHome(home));
  handles.push(handle);
  return { handle, home };
}
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A conversation with a run, and the helper conversation a delegate call creates for it. */
function withDelegate(handle: DbHandle) {
  const parent = createSession(handle, "Real conversation");
  appendMessage(handle, parent.id, "user", "please look around", null);
  const parentRun = createRun(handle, parent.id);
  const delegate = createSession(handle, "delegate:look around the repo");
  appendMessage(handle, delegate.id, "user", "look around the repo for needle-in-brief", null);
  createRun(handle, delegate.id, parentRun.id);
  return { parent, delegate };
}

describe("delegate conversations stay out of the way", () => {
  it("are not listed as conversations, active or archived", () => {
    const { handle } = setup();
    const { parent, delegate } = withDelegate(handle);
    expect(listSessions(handle).map((session) => session.id)).toEqual([parent.id]);
    handle.db.prepare("UPDATE sessions SET archived = 1 WHERE id = ?").run(delegate.id);
    expect(listSessions(handle, { archived: true })).toEqual([]);
  });

  it("can still be opened by id, so a run's audit trail and the Task panel keep working", () => {
    const { handle } = setup();
    const { delegate } = withDelegate(handle);
    expect(getSession(handle, delegate.id)?.title).toBe("delegate:look around the repo");
  });

  it("never become the conversation that --continue or `atelier sessions` picks", () => {
    const { handle, home } = setup();
    const { parent, delegate } = withDelegate(handle);
    handle.db.prepare("UPDATE sessions SET updated = ? WHERE id = ?").run(Date.now() + 60_000, delegate.id);
    expect(listHeadlessSessions(home).map((session) => session.id)).toEqual([parent.id]);
  });

  it("do not appear in search, by title or by message text", async () => {
    const { handle, home } = setup();
    const { parent } = withDelegate(handle);
    appendMessage(handle, parent.id, "assistant", "found the file", null);
    const paths = ensureHome(home);
    const auth = createAuth(paths);
    const app = createApp({ paths, db: handle, auth, recovery: recoverOnBoot(handle), version: "0.1.0", startedAt: Date.now(), workspace: home });
    const headers = { authorization: `Bearer ${auth.token}` };
    const byTitle = (await (await app.request("/api/search?q=delegate", { headers })).json()) as { sessions: unknown[]; messages: unknown[] };
    expect(byTitle.sessions).toEqual([]);
    const byMessage = (await (await app.request("/api/search?q=needle-in-brief", { headers })).json()) as { sessions: unknown[]; messages: unknown[] };
    expect(byMessage.messages).toEqual([]);
    const real = (await (await app.request("/api/search?q=found", { headers })).json()) as { messages: Array<{ session_id: string }> };
    expect(real.messages.map((message) => message.session_id)).toEqual([parent.id]);
  });

  it("leave an ordinary conversation with several runs, a retry or a fork, fully visible", () => {
    const { handle } = setup();
    const session = createSession(handle, "Busy");
    const first = createRun(handle, session.id);
    createRun(handle, session.id, null, "fork_1");
    createRun(handle, session.id, null, null);
    expect(first.parent_run_id).toBeNull();
    expect(listSessions(handle).map((entry) => entry.id)).toEqual([session.id]);
  });
});
