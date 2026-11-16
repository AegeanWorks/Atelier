/**
 * Wave 0 evidence: prints the measured state of every engine gap the plan
 * targets, as JSON, so the numbers can be frozen and re-read after each wave.
 *
 * It contacts no provider and starts no server: each fact is read from the real
 * implementation, so "before" and "after" are comparable line for line.
 *
 *   npm run engine:gaps                    print the current state as JSON
 *   npm run engine:gaps -- --write        also refresh .aikit/engine-baseline-v1.json
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMessage, createSession, openDatabase } from "../server/db";
import { ensureHome } from "../server/config";
import { createRun } from "../server/runs";
import { executeTool } from "../server/tools";
import { applyTextEdit } from "../server/edits";
import { compactMessages } from "../server/compaction";
import { toMessages } from "../server/agent";
import { budgetForModel, findModel } from "../server/providers/catalog";
import { FULL_PROFILE } from "../server/eval/harness";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function refuses(run: () => unknown): boolean {
  try {
    run();
    return false;
  } catch {
    return true;
  }
}

const provider = { id: "probe", name: "Probe", protocol: "anthropic-messages" as const, baseUrl: "https://example.test/v1" };
const modelWindow = findModel(provider, "claude-sonnet-4-5")?.contextWindow ?? null;
const derivedBudget = budgetForModel(provider, "claude-sonnet-4-5");

const messages = Array.from({ length: 40 }, (_value, index) => ({
  role: "user" as const,
  content: `message number ${index} ${"z".repeat(2_000)}`,
}));
const compacted = compactMessages(messages, 4_000);
const summary = compacted.messages[0]?.content ?? "";

const workspace = tempDir("engine-gaps-ws-");
const db = openDatabase(ensureHome(tempDir("engine-gaps-home-")));
const stale = { allowed: false };
const blind = { allowed: false };
const history = { roles: [] as string[], keepsToolCalls: false };
try {
  const session = createSession(db, "engine-gaps");
  const run = createRun(db, session.id, null, null, workspace);

  writeFileSync(join(workspace, "f.txt"), "alpha\n", "utf8");
  await executeTool(db, run, "build", { id: "r1", name: "read_file", input: { path: "f.txt" } });
  writeFileSync(join(workspace, "f.txt"), "alpha\nexternally added\n", "utf8");
  const staleEdit = await executeTool(db, run, "build", { id: "e1", name: "edit_file", input: { path: "f.txt", oldString: "alpha", newString: "ALPHA" } });
  stale.allowed = staleEdit.ok;

  writeFileSync(join(workspace, "config.json"), '{"keep":"me"}\n', "utf8");
  const blindWrite = await executeTool(db, run, "build", { id: "w1", name: "write_file", input: { path: "config.json", content: "{}" } });
  blind.allowed = blindWrite.ok;

  appendMessage(db, session.id, "user", "do the thing", null);
  appendMessage(db, session.id, "assistant", "using a tool", null);
  const rebuilt = toMessages(db, session.id, 50);
  history.roles = rebuilt.map((message) => message.role);
  history.keepsToolCalls = rebuilt.some((message) => (message as { toolCalls?: unknown }).toolCalls !== undefined);
} finally {
  db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

const report = {
  generatedAt: new Date().toISOString(),
  providerContacted: false,
  context: {
    profileContextTokens: FULL_PROFILE.contextTokens ?? null,
    derivedBudgetTokens: derivedBudget,
    catalogWindowTokens: modelWindow,
    ratioOfWindowUsedForCompaction: modelWindow === null ? null : Number(((derivedBudget / modelWindow)).toFixed(4)),
  },
  compaction: {
    isMechanical: summary.startsWith("[compacted earlier context]"),
    droppedMessages: compacted.stats.droppedMessages,
    afterTokens: compacted.stats.afterTokens,
    reInjectsArtifacts: summary.includes("[full output:"),
  },
  editCascade: {
    healsIndentationDifference: !refuses(() => applyTextEdit("function a() {\n    return 1;\n}\n", { oldString: "function a() {\n  return 1;\n}", newString: "function a() {\n  return 2;\n}" })),
    healsCrlfLfDifference: !refuses(() => applyTextEdit("a\r\nb\r\n", { oldString: "a\nb", newString: "X" })),
    refusesAmbiguousMatch: refuses(() => applyTextEdit("dup dup\n", { oldString: "dup", newString: "x" })),
  },
  writeSafety: {
    allowsEditAfterExternalChange: stale.allowed,
    allowsOverwriteOfUnreadFile: blind.allowed,
  },
  toolHistory: {
    rebuiltRoles: history.roles,
    keepsToolCalls: history.keepsToolCalls,
    messageStoreHasToolRole: false,
  },
};

console.log(JSON.stringify(report, null, 2));

// The tracked baseline mirrors the run, so "before" and "after" cannot drift apart.
if (process.argv.includes("--write")) {
  const target = join(import.meta.dirname, "..", ".aikit", "engine-baseline-v1.json");
  const previous = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown> : {};
  writeFileSync(target, `${JSON.stringify({ ...previous, ...report, label: "engine-baseline-v1", command: "npm run engine:gaps" }, null, 2)}\n`, "utf8");
  console.log(`wrote ${target}`);
}
