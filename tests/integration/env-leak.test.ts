import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureHome } from "../../server/config";
import { createSession, openDatabase, type DbHandle } from "../../server/db";
import { runHooks } from "../../server/hooks";
import { McpHub } from "../../server/mcp";
import { createRun } from "../../server/runs";
import { loadConfig, saveConfig } from "../../server/state";
import { scrubbedEnv } from "../../server/shellEnv";
import { executeTool } from "../../server/tools";

// Fabricated values only: nothing real is read, set or printed.
const FAKE = { OPENAI_API_KEY: "sk-fabricated-for-test-0000", ATELIER_FAKE_TOKEN: "tok-fabricated-for-test-1111", VENDOR_ACCESS: "fabricated-vendor-2222", KEEP_ME: "kept-value" };
const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];
const handles: DbHandle[] = [];

beforeEach(() => {
  for (const [name, value] of Object.entries(FAKE)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function setup(config: Record<string, unknown> = {}): { handle: DbHandle; workspace: string } {
  const home = mkdtempSync(join(tmpdir(), "atelier-envleak-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "atelier-envleak-ws-"));
  dirs.push(home, workspace);
  const paths = ensureHome(home);
  saveConfig(paths, { ...loadConfig(paths), ...config } as ReturnType<typeof loadConfig>);
  const handle = openDatabase(paths);
  handles.push(handle);
  return { handle, workspace };
}

const probe = `node -e "console.log(JSON.stringify({k:process.env.OPENAI_API_KEY||null,t:process.env.ATELIER_FAKE_TOKEN||null,v:process.env.VENDOR_ACCESS||null,keep:process.env.KEEP_ME||null}))"`;

async function bashEnv(handle: DbHandle, workspace: string): Promise<Record<string, string | null>> {
  const session = createSession(handle, "env");
  const run = createRun(handle, session.id, null, null, workspace);
  const result = await executeTool(handle, run, "build", { id: "c1", name: "bash", input: { command: probe } });
  const line = result.output.split("\n").find((entry) => entry.startsWith("{"));
  return JSON.parse(line ?? "{}") as Record<string, string | null>;
}

describe("the agent's bash tool", () => {
  it("does not see key- or token-shaped variables from the server's environment", async () => {
    const { handle, workspace } = setup();
    expect(await bashEnv(handle, workspace)).toEqual({ k: null, t: null, v: "fabricated-vendor-2222", keep: "kept-value" });
  });

  it("does not see the variable a provider names for its key, whatever it is called", async () => {
    const { handle, workspace } = setup({ providers: [{ id: "v", name: "Vendor", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "VENDOR_ACCESS" }] });
    expect((await bashEnv(handle, workspace)).v).toBeNull();
  });

  it("sees a variable the user listed to pass through", async () => {
    const { handle, workspace } = setup({ shellEnvPassthrough: ["ATELIER_FAKE_TOKEN"] });
    const seen = await bashEnv(handle, workspace);
    expect(seen.t).toBe("tok-fabricated-for-test-1111");
    expect(seen.k).toBeNull();
  });
});

describe("MCP stdio servers", () => {
  const server = { id: "echo", name: "Echo", transport: "stdio" as const, command: process.execPath, args: [join(process.cwd(), "tests", "fixtures", "mcp-echo-server.mjs")], env: { EXPLICIT_FROM_CONFIG: "explicit-value" } };

  it("start with a scrubbed environment plus whatever the server's own config lists", async () => {
    const hub = await McpHub.open([server], scrubbedEnv(process.env, { providers: [], passthrough: [] }));
    try {
      const result = await hub.call("mcp__echo__echo", { text: "__env__" });
      const seen = JSON.parse(result.output.replace(/^echo:/, "")) as Record<string, string | null>;
      expect(seen).toEqual({ k: null, t: null, explicit: "explicit-value" });
    } finally {
      hub.close();
    }
  });
});

describe("MCP servers that crash and are restarted", () => {
  it("come back with the scrubbed environment, not the full one", async () => {
    const server = { id: "echo", name: "Echo", transport: "stdio" as const, command: process.execPath, args: [join(process.cwd(), "tests", "fixtures", "mcp-echo-server.mjs")] };
    const hub = await McpHub.open([server], scrubbedEnv(process.env, { providers: [], passthrough: [] }));
    try {
      await hub.call("mcp__echo__echo", { text: "__die__" });
      const again = await hub.call("mcp__echo__echo", { text: "__env__" });
      expect(again.ok).toBe(true);
      expect(JSON.parse(again.output.replace(/^echo:/, ""))).toMatchObject({ k: null, t: null });
    } finally {
      hub.close();
    }
  });
});

describe("hooks keep the environment, because the user wrote them", () => {
  it("still see the server's variables", async () => {
    const { workspace } = setup();
    const result = await runHooks(workspace, [{ id: "h", event: "pre_tool", match: ".*", command: probe, timeoutMs: 10_000 }], "pre_tool", { tool: "bash", input: {}, runId: "r", sessionId: "s" });
    expect(JSON.parse(result.results[0]?.output ?? "{}").t).toBe("tok-fabricated-for-test-1111");
  });
});
