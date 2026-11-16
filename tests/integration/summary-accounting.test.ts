/**
 * A compaction summary is a real, billable provider request. Before this fix it was priced
 * nowhere: the loop's spentUsd counted only its main steps, so --max-budget-usd could be
 * exceeded by an amount the run never saw.
 *
 * Uses a real HTTP provider rather than a fixture adapter, because the summary is deliberately
 * skipped when an adapter is present (a fixture replays by index and a second call would shift
 * every later response).
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgent } from "../../server/agent";
import { ensureHome } from "../../server/config";
import { appendMessage, createSession, listEvents, openDatabase, recoverOnBoot } from "../../server/db";
import { createRun, getRun } from "../../server/runs";
import { loadConfig, loadSecrets, saveConfig, saveSecrets } from "../../server/state";

const dirs: string[] = [];
const servers: Server[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A provider that answers every request, so a summary and a main step both get a stream. */
async function provider(promptTokens: number): Promise<number> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"summary or answer"}}]}\n\n');
    response.write(`data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":${promptTokens},"completion_tokens":10}}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("compaction summary accounting", () => {
  it("records the summary's usage so its cost counts against the budget", async () => {
    const port = await provider(50_000);
    const paths = ensureHome(tempDir("atelier-acct-home-"));
    const config = loadConfig(paths);
    saveConfig(paths, {
      ...config,
      providers: [
        {
          id: "fake",
          name: "Fake",
          protocol: "openai-chat",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          defaultModel: "priced-model",
          // Priced, so a summary that is not accounted for is visible as missing cost.
          models: [{ id: "priced-model", pricing: { input: 3, output: 15 } }],
        },
      ],
      defaults: { provider: "fake", model: "priced-model" },
    });
    const secrets = loadSecrets(paths);
    secrets.keys.fake = "sk-test";
    saveSecrets(paths, secrets);

    const db = openDatabase(paths);
    try {
      recoverOnBoot(db);
      const session = createSession(db, "accounting");
      // Enough history to exceed any small budget and trigger a summary.
      for (let index = 0; index < 40; index += 1) {
        appendMessage(db, session.id, index % 2 === 0 ? "user" : "assistant", `turn ${index} ${"x".repeat(6_000)}`, null);
      }
      const run = createRun(db, session.id, null, null, tempDir("atelier-acct-ws-"));
      const loaded = getRun(db, run.id);
      if (loaded === null) throw new Error("run missing");
      // A tiny budget forces compaction on the first step.
      await runAgent(db, loadConfig(paths), loadSecrets(paths), loaded, "fake", "priced-model", new AbortController().signal, {
        profile: { ...(await import("../../server/eval/harness")).FULL_PROFILE, contextTokens: 2_000 },
      });

      const usage = listEvents(db, session.id)
        .filter((event) => event.type === "llm.usage")
        .map((event) => JSON.parse(event.data) as { purpose?: string; costUsd?: number; promptTokens?: number });
      const summary = usage.filter((entry) => entry.purpose === "compaction-summary");
      expect(summary.length).toBeGreaterThan(0);
      // Non-zero cost proves the summary was priced, not merely logged.
      expect(summary.every((entry) => (entry.costUsd ?? 0) > 0)).toBe(true);
      expect(summary.every((entry) => (entry.promptTokens ?? 0) > 0)).toBe(true);
    } finally {
      db.close();
    }
  }, 60_000);
});
