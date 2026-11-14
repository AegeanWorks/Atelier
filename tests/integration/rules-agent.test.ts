import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHome } from "../../server/config";
import { openDatabase } from "../../server/db";
import { FixtureProviderAdapter } from "../../server/eval/fixtures";
import { runHeadless } from "../../server/headless";
import { loadConfig, ruleSchema, saveConfig } from "../../server/state";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function homeWithRules(rules: Array<Record<string, unknown>>): string {
  const home = tempDir("atelier-rules-home-");
  const paths = ensureHome(home);
  const config = loadConfig(paths);
  saveConfig(paths, {
    ...config,
    providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
    defaults: { provider: "fixture", model: "fixture-model" },
    rules: rules.map((rule) => ruleSchema.parse(rule)),
  });
  return home;
}

function oneCall(name: string, input: Record<string, unknown>): FixtureProviderAdapter {
  return new FixtureProviderAdapter({
    provider: "fixture",
    models: [{ id: "fixture-model" }],
    responses: [
      { events: [{ type: "tool-call", id: "c1", name, input }, { type: "finish", reason: "tool_calls" }] },
      { events: [{ type: "text-delta", text: "finished" }, { type: "finish", reason: "stop" }] },
    ],
  });
}

function events(home: string, type: string): Array<Record<string, unknown>> {
  const db = openDatabase(ensureHome(home));
  try {
    return (db.db.prepare("SELECT data FROM events WHERE type = ?").all(type) as Array<{ data: string }>).map((row) => JSON.parse(row.data) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

describe("rule schema", () => {
  it("accepts a rule and rejects bad shapes", () => {
    expect(ruleSchema.parse({ id: "tests", action: "exec", match: "npm test*", decision: "allow" })).toMatchObject({ id: "tests" });
    expect(ruleSchema.safeParse({ id: "x", action: "read", match: "a", decision: "allow" }).success).toBe(false);
    expect(ruleSchema.safeParse({ id: "x", action: "exec", match: "", decision: "allow" }).success).toBe(false);
    expect(ruleSchema.safeParse({ id: "x", action: "exec", match: "a", decision: "maybe" }).success).toBe(false);
    expect(ruleSchema.safeParse({ id: "Bad Id", action: "exec", match: "a", decision: "allow" }).success).toBe(false);
  });
});

describe("permission rules in a run", () => {
  it("an allow rule lets a build run write without --yes and records why", async () => {
    const home = homeWithRules([{ id: "outputs", action: "edit", match: "out.txt", decision: "allow" }]);
    const workspace = tempDir("atelier-rules-ws-");
    const result = await runHeadless({ homeDir: home, workspace, mode: "build", autoApprove: false, prompt: "write", adapter: oneCall("write_file", { path: "out.txt", content: "data" }) });
    expect(result.status).toBe("finished");
    expect(existsSync(join(workspace, "out.txt"))).toBe(true);
    expect(events(home, "access.decision").some((event) => event.decision === "allow" && String(event.reason).includes("rule outputs"))).toBe(true);
  });

  it("without a matching rule a build run still needs approval", async () => {
    const home = homeWithRules([{ id: "other", action: "edit", match: "docs/*", decision: "allow" }]);
    const workspace = tempDir("atelier-rules-ws-");
    const result = await runHeadless({ homeDir: home, workspace, mode: "build", autoApprove: false, prompt: "write", adapter: oneCall("write_file", { path: "out.txt", content: "data" }) });
    expect(result.status).toBe("blocked");
    expect(existsSync(join(workspace, "out.txt"))).toBe(false);
  });

  it("a deny rule refuses the call even with --yes and tells the model which rule", async () => {
    const home = homeWithRules([{ id: "frozen", action: "edit", match: "out.txt", decision: "deny" }]);
    const workspace = tempDir("atelier-rules-ws-");
    const adapter = oneCall("write_file", { path: "out.txt", content: "data" });
    const result = await runHeadless({ homeDir: home, workspace, mode: "build", autoApprove: true, prompt: "write", adapter });
    expect(result.status).toBe("finished");
    expect(existsSync(join(workspace, "out.txt"))).toBe(false);
    const tool = adapter.requests[1]?.messages.find((message) => message.role === "tool");
    expect(tool?.content).toMatch(/denied by permission rule frozen/i);
  });

  it("an allow rule never overrides the hard safety checks", async () => {
    const home = homeWithRules([{ id: "everything", action: "exec", match: "*", decision: "allow" }]);
    const workspace = tempDir("atelier-rules-ws-");
    const adapter = oneCall("bash", { command: "rm -rf build" });
    const result = await runHeadless({ homeDir: home, workspace, mode: "build", autoApprove: false, prompt: "clean", adapter });
    expect(result.status).toBe("finished");
    const tool = adapter.requests[1]?.messages.find((message) => message.role === "tool");
    expect(tool?.content).toMatch(/destructive command/i);
  });

  it("does not auto-allow a chained command even when its prefix matches an allow rule", async () => {
    const home = homeWithRules([{ id: "node", action: "exec", match: "node -e*", decision: "allow" }]);
    const workspace = tempDir("atelier-rules-ws-");
    const result = await runHeadless({ homeDir: home, workspace, mode: "build", autoApprove: false, prompt: "run", adapter: oneCall("bash", { command: "node -e \"1\" && node -e \"2\"" }) });
    expect(result.status).toBe("blocked");
  });
});
