import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import { createAuth } from "../../server/auth";
import { ensureHome } from "../../server/config";
import { createSession, openDatabase, recoverOnBoot } from "../../server/db";
import { getRun, type RunRow } from "../../server/runs";
import { startSessionRun } from "../../server/runner";
import { loadConfig, loadSecrets, saveConfig, saveSecrets } from "../../server/state";
import { readUsage } from "../../server/usage";

const tempDirs: string[] = [];
const servers: Server[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "atelier-usage-"));
  tempDirs.push(dir);
  return dir;
}

async function waitForRun(check: () => RunRow | null, status: RunRow["status"]): Promise<RunRow> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const run = check();
    if (run !== null && run.status === status) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run did not reach ${status}`);
}

async function fakeProvider(): Promise<number> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"provider reply"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n');
    response.end("data: [DONE]\n\n");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

function configure(paths: ReturnType<typeof ensureHome>, port: number): void {
  const config = loadConfig(paths);
  saveConfig(paths, {
    ...config,
    providers: [
      { id: "fake", name: "Fake", protocol: "openai-chat", baseUrl: `http://127.0.0.1:${port}/v1`, defaultModel: "gpt-4.1" },
    ],
    defaults: { provider: "fake", model: "gpt-4.1" },
  });
  const secrets = loadSecrets(paths);
  secrets.keys.fake = "sk-usage-test";
  saveSecrets(paths, secrets);
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("usage accounting", () => {
  it("records a durable llm.usage event and serves the session totals", async () => {
    const port = await fakeProvider();
    const paths = ensureHome(tempHome());
    configure(paths, port);
    const db = openDatabase(paths);
    try {
      const recovery = recoverOnBoot(db);
      const session = createSession(db, "Usage");
      const started = startSessionRun(db, session.id, "hello", null, paths.home);
      await waitForRun(() => getRun(db, started.run.id), "finished");

      const summary = readUsage(db, session.id);
      expect(summary.requests).toBe(1);
      expect(summary.replays).toBe(0);
      expect(summary.promptTokens).toBe(3);
      expect(summary.completionTokens).toBe(2);
      expect(summary.unpricedRequests).toBe(0);
      expect(summary.costUsd).toBeCloseTo((3 * 2 + 2 * 8) / 1_000_000, 12);
      expect(summary.byModel[0]).toMatchObject({ providerId: "fake", model: "gpt-4.1", requests: 1 });

      const auth = createAuth(paths);
      const app = createApp({ paths, db, auth, recovery, version: "0.1.0", startedAt: Date.now(), workspace: paths.home });
      const response = await app.request(`/api/usage?session=${session.id}`, { headers: { authorization: `Bearer ${auth.token}` } });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { sessionId: string; requests: number; promptTokens: number };
      expect(body.sessionId).toBe(session.id);
      expect(body.requests).toBe(1);
      expect(body.promptTokens).toBe(3);

      const missing = await app.request("/api/usage?session=missing", { headers: { authorization: `Bearer ${auth.token}` } });
      expect(missing.status).toBe(404);
    } finally {
      db.close();
    }
  });
});
