import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHome } from "../../server/config";
import { createSession, openDatabase, type DbHandle } from "../../server/db";
import { appendSessionEvent, createRun } from "../../server/runs";
import { readUsage } from "../../server/usage";

const dirs: string[] = [];
const handles: DbHandle[] = [];

function setup(): DbHandle {
  const home = mkdtempSync(join(tmpdir(), "atelier-usage-delegate-"));
  dirs.push(home);
  const handle = openDatabase(ensureHome(home));
  handles.push(handle);
  return handle;
}
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function bill(handle: DbHandle, sessionId: string, promptTokens: number, costUsd: number): void {
  appendSessionEvent(handle, sessionId, "llm.usage", { providerId: "openai", model: "gpt-4.1", promptTokens, completionTokens: 1, costUsd, priced: true });
}

describe("usage with delegated sub-agents", () => {
  it("counts a delegate's spend in its parent conversation, but not the other way round", () => {
    const handle = setup();
    const parent = createSession(handle, "Parent");
    const parentRun = createRun(handle, parent.id);
    const delegate = createSession(handle, "delegate:look around");
    createRun(handle, delegate.id, parentRun.id);
    bill(handle, parent.id, 1000, 0.5);
    bill(handle, delegate.id, 200, 0.25);
    const total = readUsage(handle, parent.id);
    expect(total.requests).toBe(2);
    expect(total.costUsd).toBeCloseTo(0.75, 9);
    expect(total.delegated).toEqual({ requests: 1, costUsd: 0.25 });
    expect(total.last?.promptTokens).toBe(1000);
    const own = readUsage(handle, delegate.id);
    expect(own.requests).toBe(1);
    expect(own.delegated).toEqual({ requests: 0, costUsd: 0 });
  });

  it("does not pull in an unrelated conversation", () => {
    const handle = setup();
    const parent = createSession(handle, "Parent");
    createRun(handle, parent.id);
    const other = createSession(handle, "Other");
    createRun(handle, other.id);
    bill(handle, parent.id, 10, 0.1);
    bill(handle, other.id, 99, 9);
    expect(readUsage(handle, parent.id).requests).toBe(1);
  });

  it("counts a delegate once when it ran for several parent runs or nested deeper", () => {
    const handle = setup();
    const parent = createSession(handle, "Parent");
    const first = createRun(handle, parent.id);
    const second = createRun(handle, parent.id);
    const delegate = createSession(handle, "delegate:a");
    createRun(handle, delegate.id, first.id);
    createRun(handle, delegate.id, second.id);
    bill(handle, delegate.id, 50, 0.05);
    expect(readUsage(handle, parent.id).delegated.requests).toBe(1);
  });

  it("does not double count in the all-conversations view", () => {
    const handle = setup();
    const parent = createSession(handle, "Parent");
    const parentRun = createRun(handle, parent.id);
    const delegate = createSession(handle, "delegate:x");
    createRun(handle, delegate.id, parentRun.id);
    bill(handle, parent.id, 1000, 0.5);
    bill(handle, delegate.id, 200, 0.25);
    const everything = readUsage(handle, null);
    expect(everything.requests).toBe(2);
    expect(everything.costUsd).toBeCloseTo(0.75, 9);
    expect(everything.delegated).toEqual({ requests: 0, costUsd: 0 });
  });
});
