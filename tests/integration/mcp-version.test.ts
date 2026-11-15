import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { McpHub } from "../../server/mcp";

interface Seen {
  method: string;
  version: string | undefined;
  advertised: string | undefined;
}

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A streamable HTTP MCP server that answers initialize with `answer` and records what each request carried. */
async function fakeServer(answer: string): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      const message = JSON.parse(body) as { id?: number; method?: string; params?: { protocolVersion?: string } };
      seen.push({ method: message.method ?? "", version: request.headers["mcp-protocol-version"] as string | undefined, advertised: message.params?.protocolVersion });
      if (message.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      const result = message.method === "initialize" ? { protocolVersion: answer, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } : { tools: [{ name: "echo", description: "e", inputSchema: { type: "object" } }] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${address.port}/mcp`, seen };
}

async function connect(url: string): Promise<McpHub> {
  return McpHub.open([{ id: "fake", name: "Fake", transport: "http", url }]);
}

describe("MCP streamable HTTP protocol version", () => {
  it("asks for the newest version and sends the negotiated one on every later request", async () => {
    const { url, seen } = await fakeServer("2025-06-18");
    const hub = await connect(url);
    expect(hub.errors).toEqual([]);
    expect(seen[0]?.method).toBe("initialize");
    expect(seen[0]?.advertised).toBe("2025-06-18");
    expect(seen[0]?.version).toBeUndefined();
    const later = seen.slice(1);
    expect(later.map((entry) => entry.method)).toEqual(["notifications/initialized", "tools/list"]);
    expect(later.every((entry) => entry.version === "2025-06-18")).toBe(true);
    hub.close();
  });

  it("follows a server that answers with an older version it supports", async () => {
    const { url, seen } = await fakeServer("2025-03-26");
    const hub = await connect(url);
    expect(hub.errors).toEqual([]);
    expect(seen.slice(1).every((entry) => entry.version === "2025-03-26")).toBe(true);
    hub.close();
  });

  it("refuses a server whose answer is a version this client does not speak, naming both", async () => {
    const { url } = await fakeServer("1999-01-01");
    const hub = await connect(url);
    expect(hub.schemas()).toEqual([]);
    expect(hub.errors).toHaveLength(1);
    expect(hub.errors[0]).toMatch(/1999-01-01/);
    expect(hub.errors[0]).toMatch(/2025-06-18/);
    hub.close();
  });
});
