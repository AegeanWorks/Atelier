import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHome } from "../../server/config";
import { appendMessage, createSession, getSession, listMessages, listSessions, openDatabase, type DbHandle } from "../../server/db";
import type { ChatRequest, ProviderAdapter, StreamEvent } from "../../server/providers/types";
import { loadConfig, saveConfig } from "../../server/state";
import { compactSession } from "../../server/summarize";

const dirs: string[] = [];
const handles: DbHandle[] = [];

function setup(): DbHandle {
  const home = mkdtempSync(join(tmpdir(), "atelier-summarize-"));
  dirs.push(home);
  const paths = ensureHome(home);
  const config = loadConfig(paths);
  saveConfig(paths, {
    ...config,
    providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
    defaults: { provider: "fixture", model: "fixture-model" },
  });
  const handle = openDatabase(paths);
  handles.push(handle);
  return handle;
}

function adapter(events: StreamEvent[], seen: ChatRequest[] = []): ProviderAdapter {
  return {
    protocol: "openai-chat",
    async listModels() {
      return [];
    },
    async *stream(_context, request) {
      seen.push(request);
      yield* events;
    },
  };
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("compactSession", () => {
  it("starts a new conversation seeded with the summary and leaves the old one alone", async () => {
    const handle = setup();
    const old = createSession(handle, "Fix the parser");
    appendMessage(handle, old.id, "user", "the parser breaks on fences", null);
    appendMessage(handle, old.id, "assistant", "I found the bug in lex.ts", null);
    const result = await compactSession(handle, old.id, { adapter: adapter([{ type: "text-delta", text: "Goal: fix parser. Bug in lex.ts." }, { type: "finish", reason: "stop" }]) });
    expect(result.session.title).toBe("Compacted: Fix the parser");
    expect(result.session.id).not.toBe(old.id);
    const seeded = listMessages(handle, result.session.id);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.text).toContain("Goal: fix parser. Bug in lex.ts.");
    expect(seeded[0]?.text).toMatch(/summary of the earlier conversation/i);
    expect(listMessages(handle, old.id)).toHaveLength(2);
    expect(getSession(handle, old.id)?.title).toBe("Fix the parser");
    expect(listSessions(handle)).toHaveLength(2);
  });

  it("sends the transcript without attached file bodies", async () => {
    const handle = setup();
    const old = createSession(handle, "Attach");
    appendMessage(handle, old.id, "user", 'look @a.ts\n\n<attached_file path="a.ts">\nSECRET BODY\n</attached_file>', null);
    appendMessage(handle, old.id, "assistant", "fine", null);
    const seen: ChatRequest[] = [];
    await compactSession(handle, old.id, { adapter: adapter([{ type: "text-delta", text: "ok" }, { type: "finish", reason: "stop" }], seen) });
    const sent = seen[0]?.messages.map((message) => message.content).join("\n") ?? "";
    expect(sent).not.toContain("SECRET BODY");
    expect(sent).toContain("[attached: a.ts]");
  });

  it("keeps the newest part of a huge conversation within the size cap", async () => {
    const handle = setup();
    const old = createSession(handle, "Big");
    appendMessage(handle, old.id, "user", "OLDEST " + "x".repeat(20_000), null);
    appendMessage(handle, old.id, "assistant", "y".repeat(10_000) + " NEWEST", null);
    const seen: ChatRequest[] = [];
    await compactSession(handle, old.id, { adapter: adapter([{ type: "text-delta", text: "ok" }, { type: "finish", reason: "stop" }], seen) });
    const sent = seen[0]?.messages.map((message) => message.content).join("\n") ?? "";
    expect(sent.length).toBeLessThan(20_000);
    expect(sent).toContain("NEWEST");
    expect(sent).not.toContain("OLDEST");
  });

  it("refuses an empty conversation", async () => {
    const handle = setup();
    const empty = createSession(handle, "Empty");
    await expect(compactSession(handle, empty.id, { adapter: adapter([]) })).rejects.toMatchObject({ code: "COMPACT_EMPTY" });
  });

  it("creates nothing when the provider fails or answers with no text", async () => {
    const handle = setup();
    const old = createSession(handle, "Fail");
    appendMessage(handle, old.id, "user", "hello", null);
    await expect(compactSession(handle, old.id, { adapter: adapter([{ type: "error", message: "boom" }]) })).rejects.toMatchObject({ code: "COMPACT_FAILED" });
    await expect(compactSession(handle, old.id, { adapter: adapter([{ type: "finish", reason: "stop" }]) })).rejects.toMatchObject({ code: "COMPACT_FAILED" });
    expect(listSessions(handle)).toHaveLength(1);
  });

  it("refuses an unknown session", async () => {
    const handle = setup();
    await expect(compactSession(handle, "ses_nope", { adapter: adapter([]) })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
