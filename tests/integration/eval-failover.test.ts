import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHome } from "../../server/config";
import { openDatabase, recoverOnBoot } from "../../server/db";
import { runEval } from "../../server/eval/runner";
import { loadConfig, loadSecrets, saveConfig, saveSecrets } from "../../server/state";

const dirs: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("configured provider failover", () => {
  it("falls back from a dead primary to a compatible provider", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"42"}}]}\n\n');
      response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1}}\n\n');
      response.end("data: [DONE]\n\n");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");

    const paths = ensureHome(tempDir("atelier-failover-home-"));
    const config = loadConfig(paths);
    saveConfig(paths, {
      ...config,
      providers: [
        { id: "primary", name: "Primary", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "local-model", fallbackId: "fallback" },
        { id: "fallback", name: "Fallback", protocol: "openai-chat", baseUrl: `http://127.0.0.1:${address.port}/v1`, defaultModel: "local-model" },
      ],
      defaults: { provider: "primary", model: "local-model" },
    });
    const secrets = loadSecrets(paths);
    secrets.keys.fallback = "sk-fallback";
    saveSecrets(paths, secrets);

    const db = openDatabase(paths);
    try {
      recoverOnBoot(db);
      const run = await runEval(db, {
        suiteDir: join(process.cwd(), "evals", "suites", "atelier-real"),
        split: "test",
        profile: "full-v1",
        repeat: 1,
        resultsRoot: tempDir("atelier-failover-results-"),
      });
      expect(run.ok).toBe(true);
      expect(run.results.some((result) => result.taskId === "r8-failover" && result.ok)).toBe(true);
    } finally {
      db.close();
    }
  });
});
