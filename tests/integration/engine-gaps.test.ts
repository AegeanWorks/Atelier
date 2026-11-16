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
import { appendMessage, createSession, openDatabase } from "../../server/db";
import { ensureHome } from "../../server/config";
import { createRun } from "../../server/runs";
import { executeTool } from "../../server/tools";
import { applyTextEdit } from "../../server/edits";
import { compactMessages } from "../../server/compaction";
import { toMessages } from "../../server/agent";
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

describe("tool history", () => {
  it.fails("needs a tool role in the message store before a resumed run can see tool results", async () => {
    // Wave 1 dependency: today `appendMessage` accepts only 'user' | 'assistant'
    // (server/db.ts:478-483), so tool results survive only as `tool.result` events
    // and `toMessages` (agent.ts:34) rebuilds history as role+text. The gap is not a
    // coercion bug to patch in the mapper: the store itself has no tool role.
    const db = openDatabase(ensureHome(tempDir("atelier-gap-hist-home-")));
    try {
      const session = createSession(db, "history");
      appendMessage(db, session.id, "user", "do the thing", null);
      appendMessage(db, session.id, "assistant", "using a tool", null);
      const toolRow = appendMessage(db, session.id, "tool" as "user", "tool output here", null);
      const rebuilt = toMessages(db, session.id, 50);
      // The desired end state: the tool row keeps its own role and its call id.
      expect(toolRow.role).toBe("tool");
      expect((toolRow as unknown as { tool_call_id?: string }).tool_call_id).toBeTruthy();
      expect(rebuilt.map((message) => message.role)).toContain("tool");
    } finally {
      db.close();
    }
  });
});
