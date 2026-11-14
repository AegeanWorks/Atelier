import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgent } from "../../server/agent";
import { ensureHome } from "../../server/config";
import { createSession, listEvents, openDatabase, recoverOnBoot, type DbHandle } from "../../server/db";
import { FixtureProviderAdapter } from "../../server/eval/fixtures";
import { McpHub } from "../../server/mcp";
import { callMcpTool } from "../../server/mcpEffects";
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

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("MCP stdio", () => {
  it("discovers and calls a namespaced MCP tool", async () => {
    const paths = ensureHome(tempDir("atelier-mcp-home-"));
    saveConfig(paths, {
      ...loadConfig(paths),
      providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
      defaults: { provider: "fixture", model: "fixture-model" },
      mcpServers: [{ id: "echo", name: "Echo fixture", transport: "stdio", command: process.execPath, args: [join(process.cwd(), "tests", "fixtures", "mcp-echo-server.mjs")] }],
    });
    const handle = openDatabase(paths);
    handles.push(handle);
    recoverOnBoot(handle);
    const workspace = tempDir("atelier-mcp-workspace-");
    const session = createSession(handle, "mcp test");
    const run = createRun(handle, session.id, null, null, workspace);
    handle.db.prepare("UPDATE runs SET profile_id = 'build' WHERE id = ?").run(run.id);
    const updated = getRun(handle, run.id) ?? run;
    const spec: FixtureSpec = {
      provider: "fixture",
      models: [{ id: "fixture-model", name: "Fixture" }],
      responses: [
        { events: [{ type: "tool-call", id: "m1", name: "mcp__echo__echo", input: { text: "hello" } }, { type: "finish", reason: "tool_calls" }] },
        { events: [{ type: "text-delta", text: "mcp done" }, { type: "finish", reason: "stop" }] },
      ],
    };
    const adapter = new FixtureProviderAdapter(spec);
    const outcome = await runAgent(handle, loadConfig(paths), loadSecrets(paths), updated, "fixture", "fixture-model", new AbortController().signal, { adapter, approve: async () => true });
    expect(outcome.status).toBe("finished");
    expect(outcome.text).toBe("mcp done");
    expect(adapter.requests[0]?.tools?.some((tool) => tool.name === "mcp__echo__echo")).toBe(true);
    expect(adapter.requests[1]?.messages.find((message) => message.role === "tool")?.content).toBe("echo:hello");
    expect(listEvents(handle, session.id).some((event) => event.type === "access.decision" && event.data.includes("namespaced MCP tool"))).toBe(true);
  });
});

describe("MCP reconnect", () => {
  it("rebuilds a dead stdio server for a later call", async () => {
    const paths = ensureHome(tempDir("atelier-mcp-reconnect-home-"));
    saveConfig(paths, {
      ...loadConfig(paths),
      providers: [],
      defaults: { provider: null, model: null },
      mcpServers: [{ id: "echo", name: "Echo fixture", transport: "stdio", command: process.execPath, args: [join(process.cwd(), "tests", "fixtures", "mcp-echo-server.mjs")] }],
    });
    const handle = openDatabase(paths);
    handles.push(handle);
    recoverOnBoot(handle);
    const workspace = tempDir("atelier-mcp-reconnect-workspace-");
    const session = createSession(handle, "mcp reconnect");
    const run = createRun(handle, session.id, null, null, workspace);
    const hub = await McpHub.open(loadConfig(paths).mcpServers);
    try {
      const dead = await callMcpTool(handle, run, hub, { id: "m1", name: "mcp__echo__echo", input: { text: "__die__" } });
      expect(dead.ok).toBe(false);
      expect(dead.output).toContain("reconnected");

      const alive = await callMcpTool(handle, run, hub, { id: "m2", name: "mcp__echo__echo", input: { text: "hello" } });
      expect(alive.ok).toBe(true);
      expect(alive.output).toBe("echo:hello");

      const statuses = (handle.db.prepare("SELECT status FROM effects WHERE run_id = ? ORDER BY created").all(run.id) as Array<{ status: string }>).map((row) => row.status);
      expect(statuses).toEqual(["failed", "applied"]);
    } finally {
      hub.close();
    }
  });
});

describe("MCP effect ledger", () => {
  it("replays an applied MCP call instead of calling the server twice", async () => {
    const paths = ensureHome(tempDir("atelier-mcp-ledger-home-"));
    saveConfig(paths, {
      ...loadConfig(paths),
      providers: [],
      defaults: { provider: null, model: null },
      mcpServers: [{ id: "echo", name: "Echo fixture", transport: "stdio", command: process.execPath, args: [join(process.cwd(), "tests", "fixtures", "mcp-echo-server.mjs")] }],
    });
    const handle = openDatabase(paths);
    handles.push(handle);
    recoverOnBoot(handle);
    const workspace = tempDir("atelier-mcp-ledger-workspace-");
    const session = createSession(handle, "mcp ledger");
    const run = createRun(handle, session.id, null, null, workspace);
    const hub = await McpHub.open(loadConfig(paths).mcpServers);
    try {
      const call = { id: "m1", name: "mcp__echo__echo", input: { text: "hello" } };
      const first = await callMcpTool(handle, run, hub, call);
      const second = await callMcpTool(handle, run, hub, call);
      expect(first.ok).toBe(true);
      expect(first.output).toBe("echo:hello");
      expect(second.output).toBe(first.output);
      expect(second.effectKey).toBe(first.effectKey);

      const effects = handle.db.prepare("SELECT status, result FROM effects WHERE run_id = ?").all(run.id) as Array<{ status: string; result: string | null }>;
      expect(effects).toHaveLength(1);
      expect(effects[0]?.status).toBe("applied");
      expect(effects[0]?.result).toBe("echo:hello");
    } finally {
      hub.close();
    }
  });
});
