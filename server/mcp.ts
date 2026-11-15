import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ToolSchema } from "./providers/types.js";
import type { Config } from "./state.js";

type McpServer = Config["mcpServers"][number];

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpClient {
  initialize(): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: unknown): Promise<{ ok: boolean; output: string }>;
  close(): void;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 5_000;

class StdioMcpClient implements McpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly buffer: string[] = [];
  private nextId = 1;
  private stderr = "";

  constructor(private readonly server: McpServer, baseEnv: NodeJS.ProcessEnv) {
    this.child = spawn(server.command ?? "", server.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...baseEnv, ...server.env },
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    let buffer = "";
    this.child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        try {
          const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
          if (typeof message.id !== "number") continue;
          const pending = this.pending.get(message.id);
          if (pending === undefined) continue;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error !== undefined) pending.reject(new Error(message.error.message ?? "MCP error"));
          else pending.resolve(message.result ?? {});
        } catch {
          this.buffer.push(`unparsed: ${line.slice(0, 200)}`);
        }
      }
    });
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-2_000);
    });
    this.child.on("exit", (code) => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`MCP server ${server.id} exited (${code ?? "signal"}): ${this.stderr}`));
        this.pending.delete(id);
      }
    });
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.server.id} timed out on ${method}: ${this.stderr}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "atelier", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.request("tools/list", {});
    return Array.isArray(result.tools) ? result.tools as McpTool[] : [];
  }

  async callTool(name: string, args: unknown): Promise<{ ok: boolean; output: string }> {
    const result = await this.request("tools/call", { name, arguments: args });
    const content = Array.isArray(result.content) ? result.content as Array<{ type?: string; text?: string }> : [];
    const output = content.filter((entry) => entry.type === "text").map((entry) => entry.text ?? "").join("\n");
    return { ok: result.isError !== true, output: output.length > 0 ? output : JSON.stringify(result) };
  }

  close(): void {
    try {
      this.child.stdin.end();
    } catch {
      // The pipe may already be closed.
    }
    this.child.kill();
  }
}


/** Streamable HTTP protocol revisions this client speaks, newest first; the first is what it asks for. */
export const HTTP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

class HttpMcpClient implements McpClient {
  private sessionId: string | null = null;
  /** The version the server agreed to, sent as `MCP-Protocol-Version` on every request after initialize. */
  private protocolVersion: string | null = null;
  private nextId = 1;

  constructor(private readonly server: McpServer) {}

  private async post(body: Record<string, unknown>, expectResponse = true): Promise<Record<string, unknown> | null> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.server.headers,
    };
    if (this.sessionId !== null) headers["mcp-session-id"] = this.sessionId;
    if (this.protocolVersion !== null) headers["mcp-protocol-version"] = this.protocolVersion;
    const response = await fetch(this.server.url ?? "", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const session = response.headers.get("mcp-session-id");
    if (session !== null) this.sessionId = session;
    if (!response.ok) throw new Error(`MCP ${this.server.id} HTTP ${response.status}`);
    if (!expectResponse) return null;
    const contentType = response.headers.get("content-type") ?? "";
    const messages: Array<{ id?: number; result?: Record<string, unknown>; error?: { message?: string } }> = [];
    if (contentType.includes("text/event-stream")) {
      const text = await response.text();
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        try {
          messages.push(JSON.parse(line.slice(5).trim()) as typeof messages[number]);
        } catch {
          // Ignore keepalive or malformed SSE frames.
        }
      }
    } else {
      messages.push(await response.json() as typeof messages[number]);
    }
    const message = messages.find((entry) => entry.id === body.id) ?? messages.at(-1);
    if (message?.error !== undefined) throw new Error(message.error.message ?? "MCP error");
    return message?.result ?? {};
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId;
    this.nextId += 1;
    return this.post({ jsonrpc: "2.0", id, method, params }).then((result) => result ?? {});
  }

  async initialize(): Promise<void> {
    const asked = HTTP_PROTOCOL_VERSIONS[0] as string;
    const result = await this.request("initialize", { protocolVersion: asked, capabilities: {}, clientInfo: { name: "atelier", version: "0.1.0" } });
    const agreed = typeof result.protocolVersion === "string" ? result.protocolVersion : asked;
    if (!HTTP_PROTOCOL_VERSIONS.includes(agreed)) {
      throw new Error(`MCP ${this.server.id} answered protocol version ${agreed}, but this client speaks ${HTTP_PROTOCOL_VERSIONS.join(", ")}`);
    }
    this.protocolVersion = agreed;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, false);
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.request("tools/list", {});
    return Array.isArray(result.tools) ? result.tools as McpTool[] : [];
  }

  async callTool(name: string, args: unknown): Promise<{ ok: boolean; output: string }> {
    const result = await this.request("tools/call", { name, arguments: args });
    const content = Array.isArray(result.content) ? result.content as Array<{ type?: string; text?: string }> : [];
    const output = content.filter((entry) => entry.type === "text").map((entry) => entry.text ?? "").join("\n");
    return { ok: result.isError !== true, output: output.length > 0 ? output : JSON.stringify(result) };
  }

  close(): void {}
}


class SseMcpClient implements McpClient {
  private endpoint: URL | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly controller = new AbortController();
  private nextId = 1;
  private connecting: Promise<void> | null = null;

  constructor(private readonly server: McpServer) {}

  private connect(): Promise<void> {
    if (this.connecting !== null) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP ${this.server.id} SSE did not send an endpoint`)), REQUEST_TIMEOUT_MS);
      void (async () => {
        const response = await fetch(this.server.url ?? "", {
          headers: { accept: "text/event-stream", ...this.server.headers },
          signal: this.controller.signal,
        });
        if (!response.ok || response.body === null) throw new Error(`MCP ${this.server.id} SSE HTTP ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let event = "message";
        const data: string[] = [];
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.length === 0) {
              if (data.length > 0) {
                const message = data.join("\n");
                if (event === "endpoint") {
                  this.endpoint = new URL(message, this.server.url ?? undefined);
                  clearTimeout(timer);
                  resolve();
                } else if (event === "message") {
                  try {
                    const parsed = JSON.parse(message) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
                    if (typeof parsed.id === "number") {
                      const pending = this.pending.get(parsed.id);
                      if (pending !== undefined) {
                        this.pending.delete(parsed.id);
                        clearTimeout(pending.timer);
                        if (parsed.error !== undefined) pending.reject(new Error(parsed.error.message ?? "MCP error"));
                        else pending.resolve(parsed.result ?? {});
                      }
                    }
                  } catch {
                    // Ignore malformed SSE message frames.
                  }
                }
              }
              event = "message";
              data.length = 0;
            } else if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
          }
        }
        clearTimeout(timer);
        reject(new Error(`MCP ${this.server.id} SSE stream ended`));
      })().catch((error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    return this.connecting;
  }

  private async post(body: Record<string, unknown>): Promise<void> {
    if (this.endpoint === null) throw new Error(`MCP ${this.server.id} SSE endpoint is not ready`);
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.server.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`MCP ${this.server.id} SSE POST ${response.status}`);
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.server.id} timed out on ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      void this.post({ jsonrpc: "2.0", id, method, params }).catch((error: unknown) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async initialize(): Promise<void> {
    await this.connect();
    await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "atelier", version: "0.1.0" } });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.request("tools/list", {});
    return Array.isArray(result.tools) ? result.tools as McpTool[] : [];
  }

  async callTool(name: string, args: unknown): Promise<{ ok: boolean; output: string }> {
    const result = await this.request("tools/call", { name, arguments: args });
    const content = Array.isArray(result.content) ? result.content as Array<{ type?: string; text?: string }> : [];
    const output = content.filter((entry) => entry.type === "text").map((entry) => entry.text ?? "").join("\n");
    return { ok: result.isError !== true, output: output.length > 0 ? output : JSON.stringify(result) };
  }

  close(): void {
    this.controller.abort();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP ${this.server.id} closed`));
      this.pending.delete(id);
    }
  }
}

interface RegisteredTool {
  server: McpServer;
  client: McpClient;
  tool: McpTool;
}

function clientFor(server: McpServer, baseEnv: NodeJS.ProcessEnv): McpClient {
  return server.transport === "http" ? new HttpMcpClient(server) : server.transport === "sse" ? new SseMcpClient(server) : new StdioMcpClient(server, baseEnv);
}

export class McpHub {
  private readonly registered = new Map<string, RegisteredTool>();

  constructor(private readonly clients: McpClient[], readonly errors: string[], private readonly baseEnv: NodeJS.ProcessEnv = process.env) {}

  static async open(servers: McpServer[], baseEnv: NodeJS.ProcessEnv = process.env): Promise<McpHub> {
    const clients: McpClient[] = [];
    const errors: string[] = [];
    const hub = new McpHub(clients, errors, baseEnv);
    for (const server of servers) {
      const client = clientFor(server, baseEnv);
      try {
        await client.initialize();
        const tools = await client.listTools();
        clients.push(client);
        for (const tool of tools) {
          const name = `mcp__${server.id}__${tool.name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
          if (hub.registered.has(name)) {
            errors.push(`${server.id}: duplicate tool name ${name}`);
            continue;
          }
          hub.registered.set(name, { server, client, tool });
        }
      } catch (error) {
        client.close();
        errors.push(`${server.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return hub;
  }

  schemas(): ToolSchema[] {
    return [...this.registered.entries()].map(([name, entry]) => ({
      name,
      description: `[MCP ${entry.server.name}] ${entry.tool.description ?? entry.tool.name}`,
      parameters: entry.tool.inputSchema ?? { type: "object", properties: {} },
    }));
  }

  has(name: string): boolean {
    return this.registered.has(name);
  }

  private async restart(server: McpServer): Promise<boolean> {
    const stale = [...this.registered.entries()].filter(([, entry]) => entry.server.id === server.id);
    if (stale.length === 0) return false;
    const client = clientFor(server, this.baseEnv);
    try {
      await client.initialize();
      const tools = await client.listTools();
      const names = new Set<string>();
      for (const tool of tools) {
        const name = `mcp__${server.id}__${tool.name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
        names.add(name);
        this.registered.set(name, { server, client, tool });
      }
      for (const [name] of stale) {
        if (!names.has(name)) this.registered.delete(name);
      }
      for (const oldClient of new Set(stale.map(([, entry]) => entry.client))) {
        if (oldClient !== client) oldClient.close();
      }
      return true;
    } catch (error) {
      client.close();
      this.errors.push(`${server.id}: reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async call(name: string, input: unknown): Promise<{ ok: boolean; output: string; effectKey?: undefined }> {
    const entry = this.registered.get(name);
    if (entry === undefined) return { ok: false, output: `Unknown MCP tool '${name}'.` };
    try {
      const result = await entry.client.callTool(entry.tool.name, input);
      return { ok: result.ok, output: result.output, effectKey: undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reconnected = await this.restart(entry.server);
      return {
        ok: false,
        output: reconnected ? `${message} (MCP server ${entry.server.id} reconnected; retry the call)` : message,
        effectKey: undefined,
      };
    }
  }

  close(): void {
    const clients = new Set<McpClient>(this.clients);
    for (const entry of this.registered.values()) clients.add(entry.client);
    for (const client of clients) client.close();
  }
}
