/**
 * Wave 0 of the engine-depth plan: a machine-runnable record of the gaps this
 * work exists to close, plus the behaviour that is already correct.
 *
 * Every `it.fails` here asserts the *desired* behaviour and currently fails
 * because the gap is real. That deliberately inverts the usual signal: while a
 * gap exists the suite is green, and the moment a wave fixes it the test starts
 * failing, which is the prompt to drop `.fails` and keep it as a regression
 * guard. `scripts/engine-gaps.mjs` prints the same facts for the baseline file.
 *
 * Nothing here is a model-quality claim: no provider is contacted.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendMessage, createSession, listMessages, openDatabase } from "../../server/db";
import { ensureHome } from "../../server/config";
import { createRun } from "../../server/runs";
import { executeTool } from "../../server/tools";
import { applyTextEdit } from "../../server/edits";
import { compactMessages } from "../../server/compaction";
import { isTransient, runAgent } from "../../server/agent";
import { FixtureProviderAdapter } from "../../server/eval/fixtures";
import { getRun } from "../../server/runs";
import { loadConfig, loadSecrets, saveConfig } from "../../server/state";
import { findModel, budgetForModel, UNKNOWN_CONTEXT_WINDOW, OUTPUT_RESERVE_TOKENS } from "../../server/providers/catalog";
import { FULL_PROFILE, profileFor } from "../../server/eval/harness";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("context budget", () => {
  it("no longer caps a live run at a fixed compaction constant", () => {
    // Wave 1: the live profile derives its budget from the model window instead.
    expect(FULL_PROFILE.contextTokens).toBeUndefined();
  });

  it("derives a budget far larger than the old 24k constant from a real window", () => {
    const provider = { id: "p", name: "P", protocol: "anthropic-messages" as const, baseUrl: "https://example.test/v1" };
    expect(findModel(provider, "claude-sonnet-4-5")?.contextWindow).toBe(200_000);
    const budget = budgetForModel(provider, "claude-sonnet-4-5");
    // The contradiction Wave 1 removes: the catalog knows 200k, and the budget now follows it.
    expect(budget).toBeGreaterThan(24_000);
    expect(budget).toBeLessThanOrEqual(200_000);
  });

  it("falls back to a conservative floor for a model no catalog describes", () => {
    const provider = { id: "p", name: "P", protocol: "openai-chat" as const, baseUrl: "https://example.test/v1" };
    expect(budgetForModel(provider, "some-unknown-model")).toBe(UNKNOWN_CONTEXT_WINDOW - OUTPUT_RESERVE_TOKENS);
  });

  it("keeps an explicit profile budget for eval determinism", () => {
    // Evals pin a number so their rungs stay comparable across changes.
    expect(profileFor("minimal").contextTokens).toBe(4_000);
  });
});

describe("compaction quality", () => {
  it("currently summarises mechanically, without a model call", () => {
    const messages = Array.from({ length: 40 }, (_value, index) => ({
      role: "user" as const,
      content: `message number ${index} ${"z".repeat(2_000)}`,
    }));
    const result = compactMessages(messages, 4_000);
    const summary = result.messages[0]?.content ?? "";
    // Mechanical marker + first-180-chars-per-message: no model was involved.
    expect(summary.startsWith("[compacted earlier context]")).toBe(true);
    expect(result.stats.droppedMessages).toBeGreaterThan(0);
  });

  it("names offloaded tool outputs in the compacted head so they can be re-read", () => {
    // Wave 1: a dropped message must not take with it the fact that its full output is on disk.
    const messages = Array.from({ length: 12 }, (_value, index) => ({
      role: "user" as const,
      content: `message ${index} ${"y".repeat(3_000)}`,
    }));
    const result = compactMessages(messages, 2_000, { artifacts: ["/tmp/artifacts/run_1/call_7.txt"] });
    const head = result.messages[0]?.content ?? "";
    expect(head).toContain("[compacted earlier context]");
    expect(head).toContain("read any with read_file");
    expect(head).toContain("/tmp/artifacts/run_1/call_7.txt");
  });

  it("prefers a model summary over the mechanical one when one is supplied", () => {
    // Wave 1: a real summariser replaces the first-180-chars dump, and the mechanical
    // path stays as the fallback when no summary arrives.
    const messages = Array.from({ length: 12 }, (_value, index) => ({
      role: "user" as const,
      content: `message ${index} ${"y".repeat(3_000)}`,
    }));
    const withModel = compactMessages(messages, 2_000, { modelSummary: "The agent fixed the parser and left two TODOs." });
    expect(withModel.messages[0]?.content).toContain("The agent fixed the parser and left two TODOs.");
    const mechanical = compactMessages(messages, 2_000);
    expect(mechanical.messages[0]?.content).toContain("message 0");
  });
});

describe("edit matching", () => {
  it("applies an exact match (already correct)", () => {
    const applied = applyTextEdit("alpha beta\n", { oldString: "beta", newString: "gamma" });
    expect(applied.text).toBe("alpha gamma\n");
  });

  it("refuses an ambiguous match with its count (already correct)", () => {
    expect(() => applyTextEdit("dup dup\n", { oldString: "dup", newString: "x" })).toThrow(/found 2/);
  });

  it("heals an indentation-only difference", () => {
    // Wave 2: indentation-flexible window matching.
    const applied = applyTextEdit("function a() {\n    return 1;\n}\n", {
      oldString: "function a() {\n  return 1;\n}",
      newString: "function a() {\n  return 2;\n}",
    });
    expect(applied.strategy).toBe("indentation");
    expect(applied.text).toContain("return 2");
  });

  it("heals a CRLF/LF-only difference", () => {
    // Wave 2: the model writes LF, the file is CRLF.
    const applied = applyTextEdit("a\r\nb\r\n", { oldString: "a\nb", newString: "X" });
    expect(applied.strategy).toBe("crlf");
    expect(applied.text).toContain("X");
  });

  it("preserves CRLF and BOM through a real write (already correct)", () => {
    const dir = tempDir("atelier-gap-crlf-");
    const file = join(dir, "crlf.txt");
    writeFileSync(file, "\uFEFFone\r\ntwo\r\n", "utf8");
    const applied = applyTextEdit(readFileSync(file, "utf8"), { oldString: "two", newString: "TWO" });
    writeFileSync(file, applied.text, "utf8");
    const after = readFileSync(file, "utf8");
    expect(after.startsWith("\uFEFF")).toBe(true);
    expect(after.includes("\r\n")).toBe(true);
    expect(after).toBe("\uFEFFone\r\nTWO\r\n");
  });
});

describe("write safety", () => {
  it("refuses an edit when the file changed on disk after it was read", async () => {
    // Wave 2: read ledger + stale-write refusal, reusing the FILE_CONFLICT pattern.
    const workspace = tempDir("atelier-gap-stale-ws-");
    const db = openDatabase(ensureHome(tempDir("atelier-gap-stale-home-")));
    try {
      const run = createRun(db, createSession(db, "stale").id, null, null, workspace);
      writeFileSync(join(workspace, "f.txt"), "alpha\n", "utf8");
      expect((await executeTool(db, run, "build", { id: "r1", name: "read_file", input: { path: "f.txt" } })).ok).toBe(true);
      writeFileSync(join(workspace, "f.txt"), "alpha\nexternally added\n", "utf8");
      const edit = await executeTool(db, run, "build", { id: "e1", name: "edit_file", input: { path: "f.txt", oldString: "alpha", newString: "ALPHA" } });
      expect(edit.ok).toBe(false);
    } finally {
      db.close();
    }
  });

  it("refuses a full overwrite of a file this run never read", async () => {
    // Wave 2: read-before-write, so the agent cannot clobber content it has not seen.
    const workspace = tempDir("atelier-gap-blind-ws-");
    const db = openDatabase(ensureHome(tempDir("atelier-gap-blind-home-")));
    try {
      const run = createRun(db, createSession(db, "blind").id, null, null, workspace);
      writeFileSync(join(workspace, "config.json"), '{"keep":"me"}\n', "utf8");
      const write = await executeTool(db, run, "build", { id: "w1", name: "write_file", input: { path: "config.json", content: "{}" } });
      expect(write.ok).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("fault tolerance", () => {
  it("classifies only provider and network hiccups as retryable", () => {
    // Wave 4: one 429 used to end a whole run, while a bad key must still fail at once.
    expect(isTransient("429 Too Many Requests")).toBe(true);
    expect(isTransient("provider overloaded, try again")).toBe(true);
    expect(isTransient("socket hang up")).toBe(true);
    expect(isTransient("502 bad gateway")).toBe(true);
    expect(isTransient("invalid api key")).toBe(false);
    expect(isTransient("model does not support tools")).toBe(false);
  });

  it("does not retry a deterministic fixture step", async () => {
    // A fixture adapter is replayed by index, so retrying one would shift every later response
    // and break the eval rungs. The guard is what makes the retry safe to add at all.
    const workspace = tempDir("atelier-gap-retry-ws-");
    writeFileSync(join(workspace, "notes.txt"), "42\n", "utf8");
    const db = openDatabase(ensureHome(tempDir("atelier-gap-retry-home-")));
    try {
      const config = loadConfig(db.paths);
      saveConfig(db.paths, {
        ...config,
        providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
        defaults: { provider: "fixture", model: "fixture-model" },
      });
      const session = createSession(db, "retry");
      const run = createRun(db, session.id, null, null, workspace);
      const adapter = new FixtureProviderAdapter({
        provider: "fixture",
        models: [{ id: "fixture-model" }],
        responses: [
          { events: [], error: { code: "RATE_LIMITED", message: "429 rate limit exceeded" } },
          { events: [{ type: "text-delta", text: "recovered" }, { type: "finish", reason: "stop" }] },
        ],
      });
      const loaded = getRun(db, run.id);
      if (loaded === null) throw new Error("run missing");
      const outcome = await runAgent(db, loadConfig(db.paths), loadSecrets(db.paths), loaded, "fixture", "fixture-model", new AbortController().signal, { adapter });
      expect(outcome.status).toBe("blocked");
      expect(outcome.reason).toMatch(/rate limit/i);
      // Exactly one model call was made: the failure was reported, not retried.
      expect(adapter.requests).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("tool history", () => {
  it("keeps a tool role so a resumed run can see what its tools did", async () => {
    const workspace = tempDir("atelier-gap-hist-ws-");
    writeFileSync(join(workspace, "notes.txt"), "vault key: 42\n", "utf8");
    const db = openDatabase(ensureHome(tempDir("atelier-gap-hist-home-")));
    try {
      const config = loadConfig(db.paths);
      saveConfig(db.paths, {
        ...config,
        providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
        defaults: { provider: "fixture", model: "fixture-model" },
      });
      const session = createSession(db, "history");
      appendMessage(db, session.id, "user", "read notes.txt", null);
      const run = createRun(db, session.id, null, null, workspace);
      const adapter = new FixtureProviderAdapter({
        provider: "fixture",
        models: [{ id: "fixture-model" }],
        responses: [
          { events: [{ type: "tool-call", id: "c1", name: "read_file", input: { path: "notes.txt" } }, { type: "finish", reason: "tool_calls" }] },
          { events: [{ type: "text-delta", text: "42" }, { type: "finish", reason: "stop" }] },
        ],
      });
      const loaded = getRun(db, run.id);
      if (loaded === null) throw new Error("run missing");
      await runAgent(db, loadConfig(db.paths), loadSecrets(db.paths), loaded, "fixture", "fixture-model", new AbortController().signal, { adapter });

      // The turn that ran is durable...
      const stored = listMessages(db, session.id, { includeTools: true }).find((message) => message.role === "tool");
      expect(stored?.tool_call_id).toBe("c1");
      expect(stored?.text).toContain("vault key: 42");

      // ...and a second run on the same conversation is told about it.
      const second = createRun(db, session.id, null, null, workspace);
      const adapterTwo = new FixtureProviderAdapter({ provider: "fixture", models: [{ id: "fixture-model" }], responses: [{ events: [{ type: "text-delta", text: "ok" }, { type: "finish", reason: "stop" }] }] });
      const loadedTwo = getRun(db, second.id);
      if (loadedTwo === null) throw new Error("run missing");
      await runAgent(db, loadConfig(db.paths), loadSecrets(db.paths), loadedTwo, "fixture", "fixture-model", new AbortController().signal, { adapter: adapterTwo });
      const sent = adapterTwo.requests[0]?.messages ?? [];
      expect(sent.some((message) => message.role === "tool")).toBe(true);
      expect(sent.some((message) => message.content.includes("vault key: 42"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("keeps tool turns out of the transcript a person reads", async () => {
    // The durable tool result is working state; the conversation list, the export and the
    // summariser must not render a tool output as if a participant had written it.
    const db = openDatabase(ensureHome(tempDir("atelier-gap-hist-view-home-")));
    try {
      const session = createSession(db, "view");
      appendMessage(db, session.id, "user", "hello", null);
      appendMessage(db, session.id, "tool", "SECRET-TOOL-OUTPUT", "c1:read_file", { toolCallId: "c1" });
      expect(listMessages(db, session.id).map((message) => message.role)).toEqual(["user"]);
      expect(listMessages(db, session.id, { includeTools: true }).map((message) => message.role)).toEqual(["user", "tool"]);
    } finally {
      db.close();
    }
  });
});
