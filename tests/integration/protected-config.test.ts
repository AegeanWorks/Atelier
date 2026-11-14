import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHome } from "../../server/config";
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

function home(rules: Array<Record<string, unknown>> = []): string {
  const dir = tempDir("atelier-protected-home-");
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

describe("headless runs and the agent's own configuration", () => {
  it("--yes does not let the agent write an instruction file, a skill or a command", async () => {
    for (const path of ["AGENTS.md", ".atelier/commands/evil.md", ".claude/settings.json", "docs/CLAUDE.md"]) {
      const workspace = tempDir("atelier-protected-ws-");
      const adapter = writer(path);
      const result = await runHeadless({ homeDir: home(), workspace, mode: "build", autoApprove: true, prompt: "write it", adapter });
      expect(result.status, path).toBe("finished");
      expect(existsSync(join(workspace, path)), path).toBe(false);
      expect(adapter.requests[1]?.messages.find((message) => message.role === "tool")?.content, path).toMatch(/denied by approval/i);
    }
  });

  it("--yes still writes an ordinary file", async () => {
    const workspace = tempDir("atelier-protected-ws-");
    const result = await runHeadless({ homeDir: home(), workspace, mode: "build", autoApprove: true, prompt: "write it", adapter: writer("notes.txt") });
    expect(result.status).toBe("finished");
    expect(existsSync(join(workspace, "notes.txt"))).toBe(true);
  });

  it("a broad allow rule does not auto-approve a protected path, so a run without --yes blocks on it", async () => {
    const workspace = tempDir("atelier-protected-ws-");
    const result = await runHeadless({ homeDir: home([{ id: "all", action: "edit", match: "*", decision: "allow" }]), workspace, mode: "build", autoApprove: false, prompt: "write it", adapter: writer("AGENTS.md") });
    expect(result.status).toBe("blocked");
    expect(existsSync(join(workspace, "AGENTS.md"))).toBe(false);
  });

  it("the same allow rule still auto-approves an ordinary path", async () => {
    const workspace = tempDir("atelier-protected-ws-");
    const result = await runHeadless({ homeDir: home([{ id: "all", action: "edit", match: "*", decision: "allow" }]), workspace, mode: "build", autoApprove: false, prompt: "write it", adapter: writer("notes.txt") });
    expect(result.status).toBe("finished");
    expect(existsSync(join(workspace, "notes.txt"))).toBe(true);
  });
});
