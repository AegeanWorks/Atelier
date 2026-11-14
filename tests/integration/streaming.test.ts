import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import { createAuth } from "../../server/auth";
import { ensureHome } from "../../server/config";
import { appendMessage, createSession, listMessages, openDatabase, recoverOnBoot, type DbHandle } from "../../server/db";
import { FixtureProviderAdapter } from "../../server/eval/fixtures";
import { publishLive, subscribeLive, type LiveEvent } from "../../server/liveStream";
import { executeRun } from "../../server/runner";
import { createRun } from "../../server/runs";
import { loadConfig, saveConfig } from "../../server/state";

const dirs: string[] = [];
const handles: DbHandle[] = [];

function setup(): { handle: DbHandle; home: string } {
  const home = mkdtempSync(join(tmpdir(), "atelier-streaming-"));
  dirs.push(home);
  const paths = ensureHome(home);
  saveConfig(paths, {
    ...loadConfig(paths),
    providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
    defaults: { provider: "fixture", model: "fixture-model" },
  });
  const handle = openDatabase(paths);
  handles.push(handle);
  return { handle, home };
}
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function chunks(...parts: string[]): FixtureProviderAdapter {
  return new FixtureProviderAdapter({
    provider: "fixture",
    models: [{ id: "fixture-model" }],
    responses: [{ events: [...parts.map((text) => ({ type: "text-delta" as const, text })), { type: "finish" as const, reason: "stop" }] }],
  });
}

async function runOnce(handle: DbHandle, adapter: FixtureProviderAdapter): Promise<{ sessionId: string; runId: string; live: LiveEvent[] }> {
  const session = createSession(handle, "Streaming");
  appendMessage(handle, session.id, "user", "say it", null);
  const run = createRun(handle, session.id, null, null, handle.paths.home);
  handle.db.prepare("UPDATE runs SET profile_id = 'plan' WHERE id = ?").run(run.id);
  const live: LiveEvent[] = [];
  const off = subscribeLive(session.id, (event) => live.push(event));
  try {
    await executeRun(handle, run.id, { adapter });
  } finally {
    off();
  }
  return { sessionId: session.id, runId: run.id, live };
}

describe("token streaming in a run", () => {
  it("publishes each text delta as the provider produces it, and they add up to the stored answer", async () => {
    const { handle } = setup();
    const { sessionId, runId, live } = await runOnce(handle, chunks("The ", "answer ", "is 42."));
    expect(live.map((event) => event.text)).toEqual(["The ", "answer ", "is 42."]);
    expect(live.every((event) => event.type === "text.delta" && event.runId === runId)).toBe(true);
    const stored = listMessages(handle, sessionId).find((message) => message.role === "assistant");
    expect(live.map((event) => event.text).join("")).toBe(stored?.text);
  });

  it("does not write the deltas to the durable event log", async () => {
    const { handle } = setup();
    const { sessionId } = await runOnce(handle, chunks("a", "b", "c"));
    const types = (handle.db.prepare("SELECT DISTINCT type FROM events WHERE session_id = ?").all(sessionId) as Array<{ type: string }>).map((row) => row.type);
    expect(types).not.toContain("text.delta");
    expect(types).toContain("run.finished");
  });
});

describe("token streaming on the wire", () => {
  it("forwards live deltas as text.delta server-sent events without an id, so reconnect positions stay with durable events", async () => {
    const { handle, home } = setup();
    const paths = ensureHome(home);
    const auth = createAuth(paths);
    const app = createApp({ paths, db: handle, auth, recovery: recoverOnBoot(handle), version: "0.1.0", startedAt: Date.now(), workspace: home });
    const session = createSession(handle, "Wire");
    const controller = new AbortController();
    const response = await app.request(`/api/sessions/${session.id}/events?after=0`, { headers: { authorization: `Bearer ${auth.token}` }, signal: controller.signal });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("no body");
    const decoder = new TextDecoder();
    let received = "";
    const readUntil = async (needle: string): Promise<void> => {
      const deadline = Date.now() + 3000;
      while (!received.includes(needle)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}; got ${received}`);
        const chunk = await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${needle}`)), 3000))]);
        if (chunk.done) throw new Error("stream ended");
        received += decoder.decode(chunk.value, { stream: true });
      }
    };
    try {
      await readUntil("session.created");
      publishLive(session.id, { type: "text.delta", runId: "run_wire", step: 0, text: "Hel" });
      publishLive(session.id, { type: "text.delta", runId: "run_wire", step: 0, text: "lo" });
      await readUntil('"text":"lo"');
      const frames = received.split("\n\n").filter((frame) => frame.includes("event: text.delta"));
      expect(frames).toHaveLength(2);
      expect(frames.every((frame) => !/^id:/m.test(frame))).toBe(true);
      expect(frames[0]).toContain('"text":"Hel"');
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  it("stops forwarding once the client disconnects", async () => {
    const { handle, home } = setup();
    const paths = ensureHome(home);
    const auth = createAuth(paths);
    const app = createApp({ paths, db: handle, auth, recovery: recoverOnBoot(handle), version: "0.1.0", startedAt: Date.now(), workspace: home });
    const session = createSession(handle, "Wire2");
    const controller = new AbortController();
    const response = await app.request(`/api/sessions/${session.id}/events?after=0`, { headers: { authorization: `Bearer ${auth.token}` }, signal: controller.signal });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("no body");
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 400));
    // publishing after the disconnect must not throw or accumulate
    expect(() => publishLive(session.id, { type: "text.delta", runId: "r", step: 0, text: "x" })).not.toThrow();
  });
});
