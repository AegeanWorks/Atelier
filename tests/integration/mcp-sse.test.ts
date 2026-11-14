import { createServer, type ServerResponse } from "node:http";
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
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("MCP legacy SSE", () => {
  it("discovers the endpoint and calls a namespaced SSE tool", async () => {
    let stream: ServerResponse | null = null;
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/sse") === true) {
        stream = response;
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        response.write("event: endpoint\ndata: /messages?session=1\n\n");
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        const message = JSON.parse(body) as { id?: number; method?: string; params?: { arguments?: { text?: string } } };
        if (message.method !== "notifications/initialized" && stream !== null && message.id !== undefined) {
          let result: Record<string, unknown> = {};
          if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "sse-echo", version: "1" } };
          else if (message.method === "tools/list") result = { tools: [{ name: "echo", description: "Echoes text.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] };
          else if (message.method === "tools/call") result = { content: [{ type: "text", text: `sse:${message.params?.arguments?.text ?? ""}` }], isError: false };
          stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
        }
        response.writeHead(202).end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const paths = ensureHome(tempDir("atelier-mcp-sse-home-"));
    saveConfig(paths, {
      ...loadConfig(paths),
      providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
      defaults: { provider: "fixture", model: "fixture-model" },
      mcpServers: [{ id: "remote", name: "Remote", transport: "sse", url: `http://127.0.0.1:${address.port}/sse` }],
    });
    const handle = openDatabase(paths);
    handles.push(handle);
    recoverOnBoot(handle);
    const workspace = tempDir("atelier-mcp-sse-workspace-");
    const session = createSession(handle, "mcp sse test");
    const run = createRun(handle, session.id, null, null, workspace);
    handle.db.prepare("UPDATE runs SET profile_id = 'build' WHERE id = ?").run(run.id);
    const updated = getRun(handle, run.id) ?? run;
    const spec: FixtureSpec = {
      provider: "fixture",
      models: [{ id: "fixture-model", name: "Fixture" }],
      responses: [
        { events: [{ type: "tool-call", id: "m1", name: "mcp__remote__echo", input: { text: "hello" } }, { type: "finish", reason: "tool_calls" }] },
        { events: [{ type: "text-delta", text: "sse done" }, { type: "finish", reason: "stop" }] },
      ],
    };
    const adapter = new FixtureProviderAdapter(spec);
    const outcome = await runAgent(handle, loadConfig(paths), loadSecrets(paths), updated, "fixture", "fixture-model", new AbortController().signal, { adapter, approve: async () => true });
    expect(outcome.status).toBe("finished");
    expect(adapter.requests[0]?.tools?.some((tool) => tool.name === "mcp__remote__echo")).toBe(true);
    expect(adapter.requests[1]?.messages.find((message) => message.role === "tool")?.content).toBe("sse:hello");
  });
});
