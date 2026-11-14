import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("quality suite", () => {
  it("grades coding and long recall through a configured provider", async () => {
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        const wantsCode = body.includes("greatest common divisor");
        const text = wantsCode
          ? "function gcd(a, b) { while (b !== 0) { const t = a % b; a = b; b = t; } return a; }"
          : "VAULT-4510";
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");

    const paths = ensureHome(tempDir("atelier-quality-home-"));
    saveConfig(paths, {
      ...loadConfig(paths),
      providers: [{ id: "local", name: "Local", protocol: "openai-chat", baseUrl: `http://127.0.0.1:${address.port}/v1`, defaultModel: "local-model" }],
      defaults: { provider: "local", model: "local-model" },
    });
    const secrets = loadSecrets(paths);
    secrets.keys.local = "sk-local";
    saveSecrets(paths, secrets);

    const suiteDir = tempDir("atelier-quality-suite-");
    mkdirSync(join(suiteDir, "tasks"), { recursive: true });
    mkdirSync(join(suiteDir, "prompts"), { recursive: true });
    const filler = Array.from({ length: 600 }, (_value, index) => `Note ${index}: the pond is calm.`).join(" ");
    writeFileSync(join(suiteDir, "prompts", "recall.txt"), `Read these notes.\n\n${filler}\n\nThe vault code is VAULT-4510.\n\n${filler}\n\nWhat is the vault code? Reply with only the code.`);
    writeFileSync(join(suiteDir, "tasks", "code.json"), `${JSON.stringify({
      id: "q-code",
      suite: "quality-test",
      split: "dev",
      mode: "quality",
      provider: "configured",
      prompt: "Write a JavaScript function named gcd that returns the greatest common divisor of two non-negative integers. Reply with code only.",
      qualityChecks: [{ type: "jsTests", entry: "gcd", cases: [{ args: [12, 18], expect: 6 }, { args: [0, 9], expect: 9 }] }],
    })}\n`);
    writeFileSync(join(suiteDir, "tasks", "recall.json"), `${JSON.stringify({
      id: "q-recall",
      suite: "quality-test",
      split: "dev",
      mode: "quality",
      provider: "configured",
      prompt: "",
      promptFile: "prompts/recall.txt",
      qualityChecks: [{ type: "exact", value: "VAULT-4510" }],
      budgets: { wallMs: 10_000 },
    })}\n`);

    const db = openDatabase(paths);
    try {
      recoverOnBoot(db);
      const run = await runEval(db, {
        suiteDir,
        split: "dev",
        profile: "full-v1",
        repeat: 1,
        resultsRoot: tempDir("atelier-quality-results-"),
      });
      expect(run.ok).toBe(true);
      expect(run.results).toHaveLength(2);
      expect(run.results.map((result) => result.status)).toEqual(["finished", "finished"]);
    } finally {
      db.close();
    }
  });
});
