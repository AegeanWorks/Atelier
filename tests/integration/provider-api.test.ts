import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import { createAuth } from "../../server/auth";
import { ensureHome } from "../../server/config";
import { openDatabase, recoverOnBoot } from "../../server/db";

const tempDirs: string[] = [];
const servers: Server[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "atelier-provider-api-"));
  tempDirs.push(dir);
  return dir;
}

function makeApp() {
  const paths = ensureHome(tempHome());
  const db = openDatabase(paths);
  const recovery = recoverOnBoot(db);
  const auth = createAuth(paths);
  const app = createApp({ paths, db, auth, recovery, version: "0.1.0", startedAt: Date.now(), workspace: paths.home });
  return { app, db, auth, paths };
}

function sseChunks(text: string): string[] {
  return [
    `data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n',
    "data: [DONE]\n\n",
  ];
}

async function startFakeProvider(handler: (requestCount: number, response: import("node:http").ServerResponse) => void): Promise<{ server: Server; port: number; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    handler(requests.length, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { server, port: address.port, requests };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("config MCP servers", () => {
  it("round-trips MCP servers and rejects an invalid entry", async () => {
    const { app, db, auth } = makeApp();
    try {
      const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
      const servers = [
        { id: "filesystem", name: "Filesystem", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
        { id: "tracker", name: "Tracker", transport: "http", url: "http://127.0.0.1:3001/mcp" },
      ];
      const saved = await app.request("/api/config", { method: "PUT", headers, body: JSON.stringify({ mcpServers: servers }) });
      expect(saved.status).toBe(200);
      const savedBody = (await saved.json()) as { mcpServers: unknown[] };
      expect(savedBody.mcpServers).toEqual(servers);

      const read = await app.request("/api/config", { headers });
      const readBody = (await read.json()) as { mcpServers: unknown[] };
      expect(readBody.mcpServers).toEqual(servers);

      const invalid = await app.request("/api/config", {
        method: "PUT",
        headers,
        body: JSON.stringify({ mcpServers: [{ id: "broken", name: "Broken", transport: "stdio" }] }),
      });
      expect(invalid.status).toBe(400);
      const invalidBody = (await invalid.json()) as { error: { code: string } };
      expect(invalidBody.error.code).toBe("CONFIG_INVALID");

      const unknownProvider = await app.request("/api/config", {
        method: "PUT",
        headers,
        body: JSON.stringify({ defaults: { provider: "ghost", model: null } }),
      });
      expect(unknownProvider.status).toBe(400);
      expect(((await unknownProvider.json()) as { error: { code: string } }).error.code).toBe("CONFIG_PROVIDER");
    } finally {
      db.close();
    }
  });
});

describe("provider API", () => {
  it("updates a provider in place and rotates or clears its key", async () => {
    const { app, db, auth } = makeApp();
    try {
      const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
      const created = await app.request("/api/providers", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "local", name: "Local", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "sk-one" }),
      });
      expect(created.status).toBe(201);

      const updated = await app.request("/api/providers/local", {
        method: "PUT",
        headers,
        body: JSON.stringify({ name: "Local server", protocol: "openai-chat", baseUrl: "http://127.0.0.1:4321/v1", apiKey: "sk-two" }),
      });
      expect(updated.status).toBe(200);
      const updatedBody = (await updated.json()) as { provider: { id: string; name: string; baseUrl: string; key: { set: boolean; source: string } } };
      expect(updatedBody.provider.id).toBe("local");
      expect(updatedBody.provider.name).toBe("Local server");
      expect(updatedBody.provider.baseUrl).toBe("http://127.0.0.1:4321/v1");
      expect(updatedBody.provider.key).toEqual({ set: true, source: "secret" });
      expect(JSON.stringify(updatedBody)).not.toContain("sk-two");

      const cleared = await app.request("/api/providers/local", {
        method: "PUT",
        headers,
        body: JSON.stringify({ name: "Local server", protocol: "openai-chat", baseUrl: "http://127.0.0.1:4321/v1", clearKey: true }),
      });
      expect(cleared.status).toBe(200);
      const clearedBody = (await cleared.json()) as { provider: { key: { set: boolean } } };
      expect(clearedBody.provider.key.set).toBe(false);

      const unknown = await app.request("/api/providers/absent", {
        method: "PUT",
        headers,
        body: JSON.stringify({ name: "X", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1" }),
      });
      expect(unknown.status).toBe(404);
      const unknownBody = (await unknown.json()) as { error: { code: string } };
      expect(unknownBody.error.code).toBe("PROVIDER_NOT_FOUND");
    } finally {
      db.close();
    }
  });


  it("streams, memoizes and never renders the key", async () => {
    const fake = await startFakeProvider((_count, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of sseChunks("hello")) response.write(chunk);
      response.end();
    });
    const { app, db, auth } = makeApp();
    try {
      const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
      const created = await app.request("/api/providers", {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "fake",
          name: "Fake",
          protocol: "openai-chat",
          baseUrl: `http://127.0.0.1:${fake.port}/v1`,
          apiKey: "sk-never-render-this",
          defaultModel: "test-model",
        }),
      });
      expect(created.status).toBe(201);
      expect(await created.text()).not.toContain("sk-never-render-this");

      const first = await app.request("/api/providers/fake/complete", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { text: string; replayed: boolean; events: Array<{ type: string }> };
      expect(firstBody.text).toBe("hello");
      expect(firstBody.replayed).toBe(false);
      expect(firstBody.events.some((event) => event.type === "finish")).toBe(true);

      const second = await app.request("/api/providers/fake/complete", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
      });
      const secondBody = (await second.json()) as { text: string; replayed: boolean; events: Array<{ type: string }> };
      expect(secondBody.replayed).toBe(true);
      expect(secondBody.events[0]?.type).toBe("memo.replay");
      expect(fake.requests.filter((url) => url.endsWith("/chat/completions"))).toHaveLength(1);

      const status = await app.request("/api/providers", { headers });
      const statusText = await status.text();
      expect(statusText).not.toContain("sk-never-render-this");
      expect(statusText).toContain("\"set\":true");
    } finally {
      db.close();
    }
  });

  it("streams canonical SSE events and retries a 429", async () => {
    const fake = await startFakeProvider((count, response) => {
      if (count === 1) {
        response.writeHead(429, { "content-type": "application/json" });
        response.end('{"error":"rate limited"}');
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of sseChunks("retry-ok")) response.write(chunk);
      response.end();
    });
    const { app, db, auth } = makeApp();
    try {
      const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
      await app.request("/api/providers", {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "retry",
          name: "Retry",
          protocol: "openai-chat",
          baseUrl: `http://127.0.0.1:${fake.port}/v1`,
          apiKeyEnv: "ATELIER_TEST_KEY",
          defaultModel: "test-model",
        }),
      });
      process.env.ATELIER_TEST_KEY = "env-secret";
      const response = await app.request("/api/providers/retry/stream", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("event: text-delta");
      expect(text).toContain("retry-ok");
      expect(fake.requests.filter((url) => url.endsWith("/chat/completions"))).toHaveLength(2);
    } finally {
      delete process.env.ATELIER_TEST_KEY;
      db.close();
    }
  });
});
