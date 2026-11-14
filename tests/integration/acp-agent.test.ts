import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { serveAcp } from "../../server/acp/agent";
import { JsonRpcPeer, RpcError } from "../../server/acp/rpc";
import { ensureHome } from "../../server/config";
import { appendMessage, getSession, listMessages, openDatabase, type DbHandle } from "../../server/db";
import { FixtureProviderAdapter } from "../../server/eval/fixtures";
import { executeRun, stopSessionRun, whenRunsSettled } from "../../server/runner";
import { createRun } from "../../server/runs";
import { loadConfig, saveConfig } from "../../server/state";

const dirs: string[] = [];
const handles: DbHandle[] = [];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  // A run left waiting for an approval (for example by a failed test) would hold the teardown until its own timeout.
  for (const handle of handles) {
    const waiting = handle.db.prepare("SELECT DISTINCT session_id FROM runs WHERE status = 'running'").all() as Array<{ session_id: string }>;
    for (const row of waiting) stopSessionRun(handle, row.session_id);
  }
  await whenRunsSettled();
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

type PermissionHandler = (params: { toolCall: { toolCallId: string; kind?: string; status?: string; title?: string }; options: Array<{ optionId: string; kind: string; name: string }> }) => Promise<unknown>;

interface Update {
  sessionId: string;
  update: Record<string, unknown> & { sessionUpdate: string };
}

interface Client {
  call: (method: string, params: unknown) => Promise<unknown>;
  notify: (method: string, params: unknown) => void;
  updates: Update[];
  order: string[];
  permission: { handler: PermissionHandler };
  rawLines: string[];
  workspace: string;
  home: string;
  handle: DbHandle;
  /** Close the client's end, as an editor does when it exits. */
  end: () => void;
  /** Resolves when the agent has shut down. */
  done: Promise<void>;
}

function setup(adapter?: FixtureProviderAdapter): Client {
  const home = tempDir("atelier-acp-home-");
  const workspace = tempDir("atelier-acp-ws-");
  const paths = ensureHome(home);
  saveConfig(paths, {
    ...loadConfig(paths),
    providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "fixture-model" }],
    defaults: { provider: "fixture", model: "fixture-model" },
  });
  const handle = openDatabase(paths);
  handles.push(handle);
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const rawLines: string[] = [];
  let buffer = "";
  fromAgent.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    rawLines.push(...parts);
  });
  const updates: Update[] = [];
  const order: string[] = [];
  const permission = { handler: (async () => ({ outcome: { outcome: "selected", optionId: "allow" } })) as PermissionHandler };
  const client = new JsonRpcPeer(fromAgent, toAgent, {
    onRequest: async (method, params) => {
      if (method !== "session/request_permission") throw new RpcError(-32601, "Method not found");
      order.push("permission");
      return permission.handler(params as Parameters<PermissionHandler>[0]);
    },
    onNotification: (method, params) => {
      if (method === "session/update") {
        const update = params as Update;
        updates.push(update);
        order.push(update.update.sessionUpdate);
      }
    },
    onClose: () => undefined,
  });
  client.start();
  const done = serveAcp(toAgent, fromAgent, {
    db: handle,
    version: "0.1.0",
    pollMs: 15,
    ...(adapter === undefined
      ? {}
      : {
          startRun: (sessionId: string, prompt: string, cwd: string, mode: "plan" | "build") => {
            appendMessage(handle, sessionId, "user", prompt, null);
            const run = createRun(handle, sessionId, null, null, cwd);
            handle.db.prepare("UPDATE runs SET profile_id = ?, workspace = ? WHERE id = ?").run(mode, cwd, run.id);
            void executeRun(handle, run.id, { adapter });
          },
        }),
  });
  return {
    call: (method, params) => client.request(method, params),
    notify: (method, params) => client.notify(method, params),
    updates,
    order,
    permission,
    rawLines,
    workspace,
    home,
    handle,
    end: () => toAgent.end(),
    done,
  };
}

async function started(client: Client): Promise<string> {
  await client.call("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "test", version: "0" } });
  const created = (await client.call("session/new", { cwd: client.workspace, mcpServers: [] })) as { sessionId: string };
  return created.sessionId;
}

function answers(...texts: string[]): FixtureProviderAdapter {
  return new FixtureProviderAdapter({
    provider: "fixture",
    models: [{ id: "fixture-model" }],
    responses: [{ events: [...texts.map((text) => ({ type: "text-delta" as const, text })), { type: "finish" as const, reason: "stop" }] }],
  });
}

function writer(path: string, content = "data"): FixtureProviderAdapter {
  return new FixtureProviderAdapter({
    provider: "fixture",
    models: [{ id: "fixture-model" }],
    responses: [
      { events: [{ type: "tool-call", id: "w1", name: "write_file", input: { path, content } }, { type: "finish", reason: "tool_calls" }] },
      { events: [{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }] },
    ],
  });
}

const prompt = (text: string) => [{ type: "text", text }];
const codeOf = async (promise: Promise<unknown>): Promise<number | undefined> => promise.then(() => undefined, (error: RpcError) => error.code);

describe("ACP agent: connection and sessions", () => {
  it("answers initialize with its version, capabilities and no auth methods, whatever version was asked", async () => {
    const client = setup();
    const result = (await client.call("initialize", { protocolVersion: 99, clientCapabilities: {}, clientInfo: { name: "t", version: "1" } })) as Record<string, any>;
    expect(result.protocolVersion).toBe(1);
    expect(result.agentInfo).toMatchObject({ name: "atelier", version: "0.1.0" });
    expect(result.authMethods).toEqual([]);
    expect(result.agentCapabilities).toMatchObject({ loadSession: false, promptCapabilities: { image: true, audio: false, embeddedContext: false } });
  });

  it("refuses anything but initialize first", async () => {
    const client = setup();
    expect(await codeOf(client.call("session/new", { cwd: client.workspace, mcpServers: [] }))).toBe(-32600);
  });

  it("creates a conversation for a session and rejects a bad working directory or an unknown method", async () => {
    const client = setup();
    const id = await started(client);
    expect(getSession(client.handle, id)).not.toBeNull();
    expect(await codeOf(client.call("session/new", { cwd: "relative/path", mcpServers: [] }))).toBe(-32602);
    expect(await codeOf(client.call("session/new", { cwd: join(client.workspace, "missing"), mcpServers: [] }))).toBe(-32602);
    expect(await codeOf(client.call("session/frobnicate", {}))).toBe(-32601);
  });

  it("answers a prompt for an unknown session with resource-not-found naming it, and a malformed prompt with invalid params", async () => {
    const client = setup(answers("x"));
    const id = await started(client);
    const missing = await client.call("session/prompt", { sessionId: "sess_nope", prompt: prompt("hi") }).catch((error: RpcError) => error);
    expect(missing).toBeInstanceOf(RpcError);
    expect((missing as RpcError).code).toBe(-32002);
    expect((missing as RpcError).data).toMatchObject({ sessionId: "sess_nope" });
    expect(await codeOf(client.call("session/prompt", { sessionId: id, prompt: [] }))).toBe(-32602);
  });

  it("writes nothing to its output but protocol messages", async () => {
    const client = setup(answers("hello"));
    const id = await started(client);
    await client.call("session/prompt", { sessionId: id, prompt: prompt("hi") });
    expect(client.rawLines.length).toBeGreaterThan(2);
    for (const line of client.rawLines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
  });
});

describe("ACP agent: a turn", () => {
  it("streams the answer as message chunks before it ends the turn, and the chunks add up to what is stored", async () => {
    const client = setup(answers("The ", "answer ", "is 42."));
    const id = await started(client);
    const result = (await client.call("session/prompt", { sessionId: id, prompt: prompt("what is it?") })) as { stopReason: string };
    expect(result.stopReason).toBe("end_turn");
    const chunks = client.updates.filter((entry) => entry.update.sessionUpdate === "agent_message_chunk");
    expect(chunks.map((entry) => (entry.update.content as { text: string }).text).join("")).toBe("The answer is 42.");
    expect(chunks.every((entry) => entry.sessionId === id && (entry.update.content as { type: string }).type === "text")).toBe(true);
    const stored = listMessages(client.handle, id).find((message) => message.role === "assistant");
    expect(stored?.text).toBe("The answer is 42.");
  });

  it("refuses a second prompt while a turn is running", async () => {
    const client = setup(writer("slow.txt"));
    const id = await started(client);
    let release: (value: unknown) => void = () => undefined;
    client.permission.handler = () => new Promise((resolve) => (release = resolve));
    const first = client.call("session/prompt", { sessionId: id, prompt: prompt("write") });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await codeOf(client.call("session/prompt", { sessionId: id, prompt: prompt("again") }))).toBe(-32600);
    release({ outcome: { outcome: "selected", optionId: "allow" } });
    await first;
  });

  it("reports a provider failure as an internal error carrying the reason", async () => {
    const failing = new FixtureProviderAdapter({ provider: "fixture", models: [{ id: "fixture-model" }], responses: [{ events: [], error: { message: "model is unavailable" } }] });
    const client = setup(failing);
    const id = await started(client);
    const error = (await client.call("session/prompt", { sessionId: id, prompt: prompt("hi") }).catch((caught: RpcError) => caught)) as RpcError;
    expect(error.code).toBe(-32603);
    expect(error.message).toMatch(/model is unavailable/);
  });

  it("attaches an image block and a link to a workspace file to the stored message", async () => {
    const client = setup(answers("ok"));
    const id = await started(client);
    mkdirSync(join(client.workspace, "src"));
    writeFileSync(join(client.workspace, "src", "a.ts"), "export const marker = 7;\n");
    const uri = process.platform === "win32" ? `file:///${client.workspace.replace(/\\/g, "/")}/src/a.ts` : `file://${client.workspace}/src/a.ts`;
    await client.call("session/prompt", {
      sessionId: id,
      prompt: [{ type: "text", text: "explain" }, { type: "resource_link", uri, name: "a.ts" }, { type: "image", mimeType: "image/png", data: PNG }],
    });
    const user = listMessages(client.handle, id).find((message) => message.role === "user");
    expect(user?.text).toContain("export const marker = 7;");
    expect(user?.text).toMatch(/<attached_image id="[0-9a-f]{16}\.png"\/>/);
  });
});

describe("ACP agent: tools and permissions", () => {
  it("announces a write, asks the client, and carries out the write when allowed", async () => {
    const client = setup(writer("out.txt"));
    const id = await started(client);
    const seen: Array<{ options: string[]; kind: string | undefined; status: string | undefined }> = [];
    client.permission.handler = async (params) => {
      seen.push({ options: params.options.map((option) => option.kind), kind: params.toolCall.kind, status: params.toolCall.status });
      return { outcome: { outcome: "selected", optionId: "allow" } };
    };
    const result = (await client.call("session/prompt", { sessionId: id, prompt: prompt("write it") })) as { stopReason: string };
    expect(result.stopReason).toBe("end_turn");
    expect(existsSync(join(client.workspace, "out.txt"))).toBe(true);
    expect(seen).toEqual([{ options: ["allow_once", "allow_always", "reject_once"], kind: "edit", status: "pending" }]);
    expect(client.order.indexOf("tool_call")).toBeLessThan(client.order.indexOf("permission"));
    const calls = client.updates.filter((entry) => entry.update.sessionUpdate === "tool_call");
    expect(calls[0]?.update).toMatchObject({ toolCallId: "w1", kind: "edit", status: "pending" });
    const finals = client.updates.filter((entry) => entry.update.sessionUpdate === "tool_call_update");
    expect(finals.at(-1)?.update).toMatchObject({ toolCallId: "w1", status: "completed" });
  });

  it("does not write when the client rejects, reports the call as failed, and still ends the turn", async () => {
    const client = setup(writer("out.txt"));
    const id = await started(client);
    client.permission.handler = async () => ({ outcome: { outcome: "selected", optionId: "deny" } });
    const result = (await client.call("session/prompt", { sessionId: id, prompt: prompt("write it") })) as { stopReason: string };
    expect(result.stopReason).toBe("end_turn");
    expect(existsSync(join(client.workspace, "out.txt"))).toBe(false);
    const finals = client.updates.filter((entry) => entry.update.sessionUpdate === "tool_call_update");
    expect(finals.at(-1)?.update).toMatchObject({ toolCallId: "w1", status: "failed" });
  });

  it("saves an exact-match allow rule when the client chooses allow always", async () => {
    const client = setup(writer("out.txt"));
    const id = await started(client);
    client.permission.handler = async () => ({ outcome: { outcome: "selected", optionId: "always" } });
    await client.call("session/prompt", { sessionId: id, prompt: prompt("write it") });
    expect(existsSync(join(client.workspace, "out.txt"))).toBe(true);
    const rules = loadConfig(ensureHome(client.home)).rules;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ action: "edit", match: "out.txt", decision: "allow" });
  });

  it("does not offer allow always for a protected configuration path", async () => {
    const client = setup(writer("AGENTS.md"));
    const id = await started(client);
    let kinds: string[] = [];
    client.permission.handler = async (params) => {
      kinds = params.options.map((option) => option.kind);
      return { outcome: { outcome: "selected", optionId: "deny" } };
    };
    await client.call("session/prompt", { sessionId: id, prompt: prompt("write it") });
    expect(kinds).toEqual(["allow_once", "reject_once"]);
  });

  it("treats a cancelled permission outcome as a rejection", async () => {
    const client = setup(writer("out.txt"));
    const id = await started(client);
    client.permission.handler = async () => ({ outcome: { outcome: "cancelled" } });
    await client.call("session/prompt", { sessionId: id, prompt: prompt("write it") });
    expect(existsSync(join(client.workspace, "out.txt"))).toBe(false);
  });

  it("answers cancelled and stops the run when the client cancels while a permission is pending", async () => {
    const client = setup(writer("out.txt"));
    const id = await started(client);
    client.permission.handler = () => new Promise(() => undefined);
    const turn = client.call("session/prompt", { sessionId: id, prompt: prompt("write it") });
    await new Promise((resolve) => setTimeout(resolve, 300));
    client.notify("session/cancel", { sessionId: id });
    const result = (await turn) as { stopReason: string };
    expect(result.stopReason).toBe("cancelled");
    expect(existsSync(join(client.workspace, "out.txt"))).toBe(false);
  });

  it("settles its run before it reports that it has shut down, so the database can be closed safely", async () => {
    const client = setup(writer("out.txt"));
    const id = await started(client);
    let asked: () => void = () => undefined;
    const permissionAsked = new Promise<void>((resolve) => (asked = resolve));
    client.permission.handler = () => {
      asked();
      return new Promise(() => undefined);
    };
    void client.call("session/prompt", { sessionId: id, prompt: prompt("write it") }).catch(() => undefined);
    await permissionAsked;
    client.end();
    await client.done;
    const leases = client.handle.db.prepare("SELECT COUNT(*) AS n FROM leases").get() as { n: number };
    expect(leases.n).toBe(0);
    const running = client.handle.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").get() as { n: number };
    expect(running.n).toBe(0);
  });

  it("reports a read-only tool as one completed call with its output", async () => {
    const reader = new FixtureProviderAdapter({
      provider: "fixture",
      models: [{ id: "fixture-model" }],
      responses: [
        { events: [{ type: "tool-call", id: "r1", name: "read_file", input: { path: "notes.txt" } }, { type: "finish", reason: "tool_calls" }] },
        { events: [{ type: "text-delta", text: "read it" }, { type: "finish", reason: "stop" }] },
      ],
    });
    const client = setup(reader);
    const id = await started(client);
    writeFileSync(join(client.workspace, "notes.txt"), "vault key: 42\n");
    const result = (await client.call("session/prompt", { sessionId: id, prompt: prompt("read it") })) as { stopReason: string };
    expect(result.stopReason).toBe("end_turn");
    expect(client.order).not.toContain("permission");
    const call = client.updates.find((entry) => entry.update.sessionUpdate === "tool_call" && entry.update.toolCallId === "r1");
    expect(call?.update).toMatchObject({ kind: "read", status: "completed" });
    expect(JSON.stringify(call?.update.content)).toContain("vault key: 42");
  });
});
