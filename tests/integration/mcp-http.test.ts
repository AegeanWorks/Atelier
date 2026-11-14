import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgent } from "../../server/agent";
import { ensureHome } from "../../server/config";
import { createSession, openDatabase, recoverOnBoot, type DbHandle } from "../../server/db";
import { FixtureProviderAdapter } from "../../server/eval/fixtures";
import { createRun, getRun } from "../../server/runs";
import { loadConfig, loadSecrets, saveConfig } from "../../server/state";
import type { FixtureSpec } from "../../server/eval/types";

const dirs: string[] = [];
const handles: DbHandle[] = [];
const servers: ReturnType<typeof createServer>[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mcpToolCall(name: string, text: string): FixtureSpec {
  return {
    provider: "fixture",
    models: [{ id: "fixture-model", name: "Fixture" }],
    responses: [
      { events: [{ type: "tool-call", id: "m1", name, input: { text } }, { type: "finish", reason: "tool_calls" }] },
      { events: [{ type: "text-delta", text: "mcp done" }, { type: "finish", reason: "stop" }] },
    ],
  };
}

describe("MCP HTTP", () => {
  it("discovers and calls a streamable HTTP tool", async () => {
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        const message = JSON.parse(body) as { id?: number; method?: string; params?: { arguments?: { text?: string } } };
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        let result: Record<string, unknown> = {};
        if (message.method === "initialize") {
          response.setHeader("mcp-session-id", "session-1");
          result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "http-echo", version: "1" } };
        } else if (message.method === "tools/list") {
          result = { tools: [{ name: "echo", description: "Echoes text.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] };
        } else if (message.method === "tools/call") {
          result = { content: [{ type: "text", text: `http:${message.params?.arguments?.text ?? ""}` }], isError: false };
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const paths = ensureHome(tempDir("atelier-mcp-http-home-"));
    saveConfig(paths, {
      ...loadConfig(paths),
      providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
      defaults: { provider: "fixture", model: "fixture-model" },
      mcpServers: [{ id: "remote", name: "Remote", transport: "http", url: `http://127.0.0.1:${address.port}/mcp` }],
    });
    const handle = openDatabase(paths);
    handles.push(handle);
    recoverOnBoot(handle);
    const workspace = tempDir("atelier-mcp-http-workspace-");
    const session = createSession(handle, "mcp http test");
    const run = createRun(handle, session.id, null, null, workspace);
    handle.db.prepare("UPDATE runs SET profile_id = 'build' WHERE id = ?").run(run.id);
    const updated = getRun(handle, run.id) ?? run;
    const adapter = new FixtureProviderAdapter(mcpToolCall("mcp__remote__echo", "hello"));
    const outcome = await runAgent(handle, loadConfig(paths), loadSecrets(paths), updated, "fixture", "fixture-model", new AbortController().signal, { adapter, approve: async () => true });
    expect(outcome.status).toBe("finished");
    expect(adapter.requests[0]?.tools?.some((tool) => tool.name === "mcp__remote__echo")).toBe(true);
    expect(adapter.requests[1]?.messages.find((message) => message.role === "tool")?.content).toBe("http:hello");
  });
});
