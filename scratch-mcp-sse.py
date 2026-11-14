from pathlib import Path

p = Path("server/mcp.ts")
s = p.read_text(encoding="utf-8")
sse = '''
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
          const lines = buffer.split(/\\r?\\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.length === 0) {
              if (data.length > 0) {
                const message = data.join("\\n");
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
    const output = content.filter((entry) => entry.type === "text").map((entry) => entry.text ?? "").join("\\n");
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
'''
s = s.replace("interface RegisteredTool {", sse + "\ninterface RegisteredTool {")
s = s.replace('const client: McpClient = server.transport === "http" ? new HttpMcpClient(server) : new StdioMcpClient(server);', 'const client: McpClient = server.transport === "http" ? new HttpMcpClient(server) : server.transport === "sse" ? new SseMcpClient(server) : new StdioMcpClient(server);')
p.write_text(s, encoding="utf-8")
