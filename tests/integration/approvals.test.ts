import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgent } from "../../server/agent";
import { ensureHome } from "../../server/config";
import { createSession, openDatabase, recoverOnBoot, type DbHandle } from "../../server/db";
import { FixtureProviderAdapter } from "../../server/eval/fixtures";
import { listApprovals, requestApproval, resolveApproval } from "../../server/approvals";
import { createRun, getRun } from "../../server/runs";
import { loadConfig, loadSecrets, saveConfig } from "../../server/state";
import type { FixtureSpec } from "../../server/eval/types";

const dirs: string[] = [];
const handles: DbHandle[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function fixture(): FixtureProviderAdapter {
  const spec: FixtureSpec = {
    provider: "fixture",
    models: [{ id: "fixture-model", name: "Fixture" }],
    responses: [
      { events: [
        { type: "tool-call", id: "w1", name: "write_file", input: { path: "approved.txt", content: "approved" } },
        { type: "finish", reason: "tool_calls" },
      ] },
      { events: [{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }] },
    ],
  };
  return new FixtureProviderAdapter(spec);
}

async function setup(): Promise<{ handle: DbHandle; workspace: string; runId: string; sessionId: string }> {
  const paths = ensureHome(tempDir("atelier-approval-home-"));
  const config = loadConfig(paths);
  saveConfig(paths, {
    ...config,
    providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
    defaults: { provider: "fixture", model: "fixture-model" },
  });
  const handle = openDatabase(paths);
  handles.push(handle);
  recoverOnBoot(handle);
  const workspace = tempDir("atelier-approval-workspace-");
  const session = createSession(handle, "approval test");
  const run = createRun(handle, session.id, null, null, workspace);
  handle.db.prepare("UPDATE runs SET profile_id = 'build' WHERE id = ?").run(run.id);
  return { handle, workspace, runId: run.id, sessionId: session.id };
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("approvals", () => {
  it("blocks a write until the user approves it", async () => {
    const { handle, workspace, runId } = await setup();
    const run = getRun(handle, runId);
    if (run === null) throw new Error("run missing");
    const adapter = fixture();
    const pending = runAgent(handle, loadConfig(handle.paths), loadSecrets(handle.paths), run, "fixture", "fixture-model", new AbortController().signal, { adapter });
    let approval = listApprovals(handle, { runId, pendingOnly: true })[0];
    for (let attempt = 0; attempt < 20 && approval === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      approval = listApprovals(handle, { runId, pendingOnly: true })[0];
    }
    expect(approval?.tool).toBe("write_file");
    expect(existsSync(join(workspace, "approved.txt"))).toBe(false);
    resolveApproval(handle, approval?.id ?? "", "allow", "test approval", runId);
    const outcome = await pending;
    expect(outcome.status).toBe("finished");
    expect(readFileSync(join(workspace, "approved.txt"), "utf8")).toBe("approved");
    expect(listApprovals(handle, { runId })[0]?.status).toBe("approved");
  });

  it("does not write when the user denies it", async () => {
    const { handle, workspace, runId } = await setup();
    const run = getRun(handle, runId);
    if (run === null) throw new Error("run missing");
    const adapter = fixture();
    const pending = runAgent(handle, loadConfig(handle.paths), loadSecrets(handle.paths), run, "fixture", "fixture-model", new AbortController().signal, { adapter });
    let approval = listApprovals(handle, { runId, pendingOnly: true })[0];
    for (let attempt = 0; attempt < 20 && approval === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      approval = listApprovals(handle, { runId, pendingOnly: true })[0];
    }
    resolveApproval(handle, approval?.id ?? "", "deny", "test denial", runId);
    const outcome = await pending;
    expect(outcome.status).toBe("finished");
    expect(existsSync(join(workspace, "approved.txt"))).toBe(false);
    expect(listApprovals(handle, { runId })[0]?.status).toBe("denied");
  });

  it("expires pending approvals during boot recovery", async () => {
    const { handle, runId, sessionId } = await setup();
    handle.db.prepare("INSERT INTO approvals (id, run_id, session_id, call_id, tool, action, resource, reason, status, decision_reason, created, resolved) VALUES ('ap_boot', ?, ?, 'c1', 'write_file', 'edit', 'a.txt', 'test', 'pending', NULL, ?, NULL)").run(runId, sessionId, Date.now());
    recoverOnBoot(handle);
    expect(listApprovals(handle, { runId })[0]?.status).toBe("expired");
  });

  it("expires a pending approval on timeout", async () => {
    const { handle, runId } = await setup();
    const run = getRun(handle, runId);
    if (run === null) throw new Error("run missing");
    const decision = await requestApproval(handle, run, { id: "call-1", name: "write_file" }, "edit", "a.txt", "test", new AbortController().signal, 100);
    expect(decision.verdict).toBe("deny");
    expect(listApprovals(handle, { runId })[0]?.status).toBe("expired");
  });
});
