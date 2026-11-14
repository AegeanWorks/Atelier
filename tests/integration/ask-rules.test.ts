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

function home(rules: Array<Record<string, unknown>>): string {
  const dir = tempDir("atelier-ask-home-");
  const paths = ensureHome(dir);
  saveConfig(paths, {
    ...loadConfig(paths),
    providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
    defaults: { provider: "fixture", model: "fixture-model" },
    rules: rules.map((rule) => ruleSchema.parse(rule)),
  });
  return dir;
}

function writer(path: string): FixtureProviderAdapter {
  return new FixtureProviderAdapter({
    provider: "fixture",
    models: [{ id: "fixture-model" }],
    responses: [
      { events: [{ type: "tool-call", id: "w1", name: "write_file", input: { path, content: "data" } }, { type: "finish", reason: "tool_calls" }] },
      { events: [{ type: "text-delta", text: "finished" }, { type: "finish", reason: "stop" }] },
    ],
  });
}

const allowAll = { id: "all", action: "edit", match: "*", decision: "allow" };
const askOut = { id: "careful", action: "edit", match: "out.txt", decision: "ask" };

describe("an ask rule in a real run", () => {
  it("stops an allow rule from approving the call, so a run without --yes blocks", async () => {
    const workspace = tempDir("atelier-ask-ws-");
    const result = await runHeadless({ homeDir: home([allowAll, askOut]), workspace, mode: "build", autoApprove: false, prompt: "write", adapter: writer("out.txt") });
    expect(result.status).toBe("blocked");
    expect(existsSync(join(workspace, "out.txt"))).toBe(false);
  });

  it("is not satisfied by --yes: the call is refused and the model is told", async () => {
    const workspace = tempDir("atelier-ask-ws-");
    const adapter = writer("out.txt");
    const result = await runHeadless({ homeDir: home([allowAll, askOut]), workspace, mode: "build", autoApprove: true, prompt: "write", adapter });
    expect(result.status).toBe("finished");
    expect(existsSync(join(workspace, "out.txt"))).toBe(false);
    expect(adapter.requests[1]?.messages.find((message) => message.role === "tool")?.content).toMatch(/denied by approval/i);
  });

  it("leaves other paths to the allow rule", async () => {
    const workspace = tempDir("atelier-ask-ws-");
    const result = await runHeadless({ homeDir: home([allowAll, askOut]), workspace, mode: "build", autoApprove: false, prompt: "write", adapter: writer("other.txt") });
    expect(result.status).toBe("finished");
    expect(existsSync(join(workspace, "other.txt"))).toBe(true);
  });

  it("still lets --yes write a path no rule mentions", async () => {
    const workspace = tempDir("atelier-ask-ws-");
    const result = await runHeadless({ homeDir: home([askOut]), workspace, mode: "build", autoApprove: true, prompt: "write", adapter: writer("plain.txt") });
    expect(result.status).toBe("finished");
    expect(existsSync(join(workspace, "plain.txt"))).toBe(true);
  });
});

describe("the rule schema", () => {
  it("accepts ask and still rejects an unknown decision", () => {
    expect(ruleSchema.parse(askOut).decision).toBe("ask");
    expect(ruleSchema.safeParse({ ...askOut, decision: "maybe" }).success).toBe(false);
  });
});

describe("the database is not needed to evaluate rules", () => {
  it("opens cleanly with an ask rule stored in the config", () => {
    const dir = home([askOut]);
    const handle = openDatabase(ensureHome(dir));
    handle.close();
    expect(loadConfig(ensureHome(dir)).rules[0]?.decision).toBe("ask");
  });
});
