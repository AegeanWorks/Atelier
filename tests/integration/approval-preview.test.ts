import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listApprovals, resolveApproval } from "../../server/approvals";
import { runAgent } from "../../server/agent";
import { ensureHome } from "../../server/config";
import { createSession, listEvents, openDatabase, recoverOnBoot, type DbHandle } from "../../server/db";
import { FixtureProviderAdapter } from "../../server/eval/fixtures";
import { createRun, getRun } from "../../server/runs";
import { loadConfig, loadSecrets, saveConfig } from "../../server/state";

const dirs: string[] = [];
const handles: DbHandle[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function setup(): Promise<{ handle: DbHandle; workspace: string; runId: string }> {
  const paths = ensureHome(tempDir("atelier-preview-home-"));
  const config = loadConfig(paths);
  saveConfig(paths, {
    ...config,
    providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
    defaults: { provider: "fixture", model: "fixture-model" },
  });
  const handle = openDatabase(paths);
  handles.push(handle);
  recoverOnBoot(handle);
  const workspace = tempDir("atelier-preview-workspace-");
  writeFileSync(join(workspace, "notes.txt"), "alpha\nbeta\n");
  const session = createSession(handle, "preview test");
  const run = createRun(handle, session.id, null, null, workspace);
  handle.db.prepare("UPDATE runs SET profile_id = 'build' WHERE id = ?").run(run.id);
  return { handle, workspace, runId: run.id };
}

function fixture(): FixtureProviderAdapter {
  return new FixtureProviderAdapter({
    provider: "fixture",
    models: [{ id: "fixture-model", name: "Fixture" }],
    responses: [
      {
        events: [
          { type: "tool-call", id: "e1", name: "edit_file", input: { path: "notes.txt", oldString: "beta", newString: "gamma" } },
          { type: "finish", reason: "tool_calls" },
        ],
      },
      { events: [{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }] },
    ],
  });
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("approval diff preview", () => {
  it("attaches the proposed diff to the pending approval and its event", async () => {
    const { handle, runId } = await setup();
    const run = getRun(handle, runId);
    if (run === null) throw new Error("run missing");
    const adapter = fixture();
    const pending = runAgent(handle, loadConfig(handle.paths), loadSecrets(handle.paths), run, "fixture", "fixture-model", new AbortController().signal, { adapter });
    let approval = listApprovals(handle, { runId, pendingOnly: true })[0];
    for (let attempt = 0; attempt < 20 && approval === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      approval = listApprovals(handle, { runId, pendingOnly: true })[0];
    }
    expect(approval?.tool).toBe("edit_file");
    expect(approval?.preview).toContain("-beta");
    expect(approval?.preview).toContain("+gamma");
    const request = listEvents(handle, run.session_id).find((entry) => entry.type === "approval.request");
    const payload = JSON.parse(request?.data ?? "{}") as { preview?: string | null };
    expect(payload.preview).toContain("+gamma");

    resolveApproval(handle, approval?.id ?? "", "allow", "preview approved", runId);
    const outcome = await pending;
    expect(outcome.status).toBe("finished");
    expect(approval?.action).toBe("edit");
  });

  it("leaves the preview empty for a command approval", async () => {
    const { handle, runId } = await setup();
    const run = getRun(handle, runId);
    if (run === null) throw new Error("run missing");
    const adapter = new FixtureProviderAdapter({
      provider: "fixture",
      models: [{ id: "fixture-model" }],
      responses: [
        { events: [{ type: "tool-call", id: "b1", name: "bash", input: { command: "echo hi" } }, { type: "finish", reason: "tool_calls" }] },
        { events: [{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }] },
      ],
    });
    const pending = runAgent(handle, loadConfig(handle.paths), loadSecrets(handle.paths), run, "fixture", "fixture-model", new AbortController().signal, { adapter });
    let approval = listApprovals(handle, { runId, pendingOnly: true })[0];
    for (let attempt = 0; attempt < 20 && approval === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      approval = listApprovals(handle, { runId, pendingOnly: true })[0];
    }
    expect(approval?.tool).toBe("bash");
    expect(approval?.preview).toBeNull();
    resolveApproval(handle, approval?.id ?? "", "deny", "no command", runId);
    await pending;
  });
});
