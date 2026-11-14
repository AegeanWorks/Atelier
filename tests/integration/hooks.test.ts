import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHome } from "../../server/config";
import { openDatabase } from "../../server/db";
import { FixtureProviderAdapter } from "../../server/eval/fixtures";
import { runHeadless } from "../../server/headless";
import { runHooks, type Hook } from "../../server/hooks";
import { hookSchema, loadConfig, saveConfig } from "../../server/state";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const node = (code: string): string => `node -e "${code}"`;
function hook(command: string, extra: Partial<Hook> = {}): Hook {
  return { id: "h1", event: "pre_tool", match: ".*", command, timeoutMs: 10_000, ...extra };
}
const call = { tool: "bash", input: { command: "ls" }, runId: "run_1", sessionId: "ses_1" };

describe("hook runner", () => {
  it("blocks a pre_tool call only on exit code 2 and reports the hook's output", async () => {
    const root = tempDir("atelier-hook-ws-");
    const blocked = await runHooks(root, [hook(node("console.error('no way');process.exit(2)"))], "pre_tool", call);
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toContain("no way");
    expect(blocked.results[0]).toMatchObject({ hookId: "h1", exitCode: 2 });
    const warned = await runHooks(root, [hook(node("process.exit(1)"))], "pre_tool", call);
    expect(warned.blocked).toBe(false);
    expect(warned.results[0]?.exitCode).toBe(1);
  });

  it("runs only hooks for the event whose match pattern fits the tool", async () => {
    const root = tempDir("atelier-hook-ws-");
    const hooks = [hook(node("process.exit(2)"), { id: "write", match: "^write_file$" }), hook(node("process.exit(0)"), { id: "post", event: "post_tool" })];
    const result = await runHooks(root, hooks, "pre_tool", call);
    expect(result.results).toEqual([]);
    expect(result.blocked).toBe(false);
  });

  it("hands the call to the command through environment variables", async () => {
    const root = tempDir("atelier-hook-ws-");
    const result = await runHooks(root, [hook(node("process.stdout.write([process.env.ATELIER_HOOK_EVENT,process.env.ATELIER_TOOL,process.env.ATELIER_TOOL_INPUT].join('|'))"))], "pre_tool", call);
    expect(result.results[0]?.output).toBe('pre_tool|bash|{"command":"ls"}');
  });

  it("gives a post_tool hook the tool outcome and never blocks", async () => {
    const root = tempDir("atelier-hook-ws-");
    const result = await runHooks(root, [hook(node("process.stdout.write(process.env.ATELIER_TOOL_OK+':'+process.env.ATELIER_TOOL_OUTPUT);process.exit(2)"), { event: "post_tool" })], "post_tool", { ...call, outcome: { ok: true, output: "done" } });
    expect(result.results[0]?.output).toBe("true:done");
    expect(result.blocked).toBe(false);
  });

  it("stops a slow hook at its timeout without blocking", async () => {
    const root = tempDir("atelier-hook-ws-");
    const result = await runHooks(root, [hook(node("setTimeout(()=>{},30000)"), { timeoutMs: 300 })], "pre_tool", call);
    expect(result.blocked).toBe(false);
    expect(result.results[0]).toMatchObject({ exitCode: null, timedOut: true });
  });

  it("runs the hook in the workspace directory", async () => {
    const root = tempDir("atelier-hook-ws-");
    const result = await runHooks(root, [hook(node("process.stdout.write(process.cwd())"))], "pre_tool", call);
    expect(result.results[0]?.output.toLowerCase()).toBe(root.toLowerCase());
  });
});

describe("hook configuration", () => {
  it("accepts a valid hook and fills defaults", () => {
    const parsed = hookSchema.parse({ id: "guard", event: "pre_tool", command: "echo hi" });
    expect(parsed).toMatchObject({ match: ".*", timeoutMs: 10_000 });
  });

  it("rejects a bad event, a bad pattern, an empty command and an out of range timeout", () => {
    expect(hookSchema.safeParse({ id: "a", event: "later", command: "x" }).success).toBe(false);
    expect(hookSchema.safeParse({ id: "a", event: "pre_tool", match: "(", command: "x" }).success).toBe(false);
    expect(hookSchema.safeParse({ id: "a", event: "pre_tool", command: "" }).success).toBe(false);
    expect(hookSchema.safeParse({ id: "a", event: "pre_tool", command: "x", timeoutMs: 5 }).success).toBe(false);
  });
});

describe("hooks in a run", () => {
  function homeWithHook(hookDef: Record<string, unknown>): string {
    const home = tempDir("atelier-hook-home-");
    const paths = ensureHome(home);
    const config = loadConfig(paths);
    saveConfig(paths, {
      ...config,
      providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
      defaults: { provider: "fixture", model: "fixture-model" },
      hooks: [hookSchema.parse(hookDef)],
    });
    return home;
  }
  function writer(): FixtureProviderAdapter {
    return new FixtureProviderAdapter({
      provider: "fixture",
      models: [{ id: "fixture-model" }],
      responses: [
        { events: [{ type: "tool-call", id: "w1", name: "write_file", input: { path: "out.txt", content: "data" } }, { type: "finish", reason: "tool_calls" }] },
        { events: [{ type: "text-delta", text: "finished" }, { type: "finish", reason: "stop" }] },
      ],
    });
  }

  it("a pre_tool hook that exits 2 vetoes the write and tells the model why", async () => {
    const home = homeWithHook({ id: "guard", event: "pre_tool", match: "write_file", command: node("console.error('writes are frozen');process.exit(2)") });
    const workspace = tempDir("atelier-hook-ws-");
    const adapter = writer();
    const result = await runHeadless({ homeDir: home, workspace, mode: "build", autoApprove: true, prompt: "write it", adapter });
    expect(result.status).toBe("finished");
    expect(existsSync(join(workspace, "out.txt"))).toBe(false);
    const toolMessage = adapter.requests[1]?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toMatch(/blocked by hook guard/i);
    expect(toolMessage?.content).toContain("writes are frozen");
    const db = openDatabase(ensureHome(home));
    try {
      const events = db.db.prepare("SELECT type, data FROM events WHERE type = 'hook.result'").all() as Array<{ type: string; data: string }>;
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]?.data ?? "{}")).toMatchObject({ hookId: "guard", event: "pre_tool", blocked: true, tool: "write_file" });
    } finally {
      db.close();
    }
  });

  it("a hook that exits 0 lets the write through and a post_tool hook sees the result", async () => {
    const home = homeWithHook({ id: "audit", event: "post_tool", match: "write_file", command: node("require('fs').writeFileSync('hook-ran.txt', process.env.ATELIER_TOOL_OK)") });
    const workspace = tempDir("atelier-hook-ws-");
    const result = await runHeadless({ homeDir: home, workspace, mode: "build", autoApprove: true, prompt: "write it", adapter: writer() });
    expect(result.status).toBe("finished");
    expect(existsSync(join(workspace, "out.txt"))).toBe(true);
    expect(existsSync(join(workspace, "hook-ran.txt"))).toBe(true);
  });
});
