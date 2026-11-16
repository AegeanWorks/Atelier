import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import { createAuth } from "../../server/auth";
import { ensureHome } from "../../server/config";
import { appendMessage, createSession, openDatabase, recoverOnBoot, SCHEMA_VERSION } from "../../server/db";
import { appendSessionEvent, createRun } from "../../server/runs";
import { loadConfig, saveConfig } from "../../server/state";

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "atelier-api-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeApp() {
  const paths = ensureHome(tempHome());
  const db = openDatabase(paths);
  const recovery = recoverOnBoot(db);
  const auth = createAuth(paths);
  const app = createApp({
    paths,
    db,
    auth,
    recovery,
    version: "0.1.0",
    startedAt: Date.now(),
    workspace: paths.home,
  });
  return { app, db, auth, paths };
}

describe("HTTP API", () => {
  it("serves the browser bootstrap without auth", async () => {
    const { app, db } = makeApp();
    try {
      const response = await app.request("/api/auth");
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie().some((value) => value.startsWith("atelier_session="))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("rejects API calls without a token", async () => {
    const { app, db } = makeApp();
    try {
      const response = await app.request("/api/health");
      expect(response.status).toBe(401);
    } finally {
      db.close();
    }
  });

  it("reports health and boot with a bearer token", async () => {
    const { app, db, auth } = makeApp();
    try {
      const headers = { authorization: `Bearer ${auth.token}` };
      const health = await app.request("/api/health", { headers });
      expect(health.status).toBe(200);
      const body = (await health.json()) as { ok: boolean; db: { schemaVersion: number } };
      expect(body.ok).toBe(true);
      expect(body.db.schemaVersion).toBe(SCHEMA_VERSION);

      const boot = await app.request("/api/boot", { headers });
      expect(boot.status).toBe(200);
      const bootBody = (await boot.json()) as { sessions: unknown[]; profiles: unknown[] };
      expect(bootBody.sessions).toHaveLength(0);
      expect(bootBody.profiles.length).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
  });

  it("lists and restores a shadow-git checkpoint", async () => {
    const { app, db, auth, paths } = makeApp();
    try {
      const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
      writeFileSync(join(paths.home, "note.txt"), "one");
      const write = await app.request("/api/workspace/file", { method: "PUT", headers, body: JSON.stringify({ path: "note.txt", content: "two" }) });
      expect(write.status).toBe(200);
      const listed = await app.request("/api/checkpoints", { headers });
      const body = (await listed.json()) as { checkpoints: Array<{ commit: string; path: string }> };
      const checkpoint = body.checkpoints.find((entry) => entry.path === "note.txt");
      expect(checkpoint).toBeDefined();
      const restore = await app.request("/api/checkpoints/restore", { method: "POST", headers, body: JSON.stringify({ commit: checkpoint?.commit, path: "note.txt" }) });
      expect(restore.status).toBe(200);
      expect(readFileSync(join(paths.home, "note.txt"), "utf8")).toBe("one");

      const tree = await app.request("/api/checkpoints/restore-directory", { method: "POST", headers, body: JSON.stringify({ path: "" }) });
      expect(tree.status).toBe(200);
      expect(((await tree.json()) as { restored: number }).restored).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("stores MCP server configuration through the config API", async () => {
    const { app, db, auth } = makeApp();
    try {
      const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
      const server = { id: "echo", name: "Echo", transport: "stdio", command: "node", args: ["server.mjs"] };
      const saved = await app.request("/api/config", { method: "PUT", headers, body: JSON.stringify({ mcpServers: [server] }) });
      expect(saved.status).toBe(200);
      const listed = await app.request("/api/config", { headers });
      const body = (await listed.json()) as { mcpServers: Array<{ id: string }> };
      expect(body.mcpServers.map((entry) => entry.id)).toEqual(["echo"]);
    } finally {
      db.close();
    }
  });

  it("lists and resolves a pending approval", async () => {
    const { app, db, auth, paths } = makeApp();
    try {
      const session = createSession(db, "Approval API");
      const run = createRun(db, session.id, null, null, paths.home);
      db.db.prepare("INSERT INTO approvals (id, run_id, session_id, call_id, tool, action, resource, reason, status, decision_reason, created, resolved) VALUES ('ap_1', ?, ?, 'c1', 'write_file', 'edit', 'a.txt', 'test', 'pending', NULL, ?, NULL)").run(run.id, session.id, Date.now());
      const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
      const listed = await app.request(`/api/sessions/${session.id}/approvals?pending=1`, { headers });
      expect(listed.status).toBe(200);
      const listedBody = (await listed.json()) as { approvals: Array<{ id: string }> };
      expect(listedBody.approvals.map((item) => item.id)).toEqual(["ap_1"]);
      const resolved = await app.request(`/api/runs/${run.id}/approvals/ap_1`, { method: "POST", headers, body: JSON.stringify({ decision: "deny" }) });
      expect(resolved.status).toBe(200);
      const resolvedBody = (await resolved.json()) as { approval: { status: string } };
      expect(resolvedBody.approval.status).toBe("denied");
    } finally {
      db.close();
    }
  });

  it("creates a session, appends a deduplicated message, and replays events", async () => {
    const { app, db, auth } = makeApp();
    try {
      const headers = {
        authorization: `Bearer ${auth.token}`,
        "content-type": "application/json",
      };
      const created = await app.request("/api/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Test session" }),
      });
      expect(created.status).toBe(201);
      const { session } = (await created.json()) as { session: { id: string } };

      const first = await app.request(`/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "hello", clientId: "client-1" }),
      });
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as { message: { id: string } };

      const duplicate = await app.request(`/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "hello", clientId: "client-1" }),
      });
      const duplicateBody = (await duplicate.json()) as { message: { id: string } };
      expect(duplicateBody.message.id).toBe(firstBody.message.id);

      const messages = await app.request(`/api/sessions/${session.id}/messages`, { headers });
      const messagesBody = (await messages.json()) as { messages: unknown[] };
      expect(messagesBody.messages).toHaveLength(1);

      const events = await app.request(`/api/sessions/${session.id}/events?after=0&once=1`, { headers });
      expect(events.status).toBe(200);
      const text = await events.text();
      expect(text).toContain("session.created");
      expect(text).toContain("user.message");
    } finally {
      db.close();
    }
  });

  it("streams durable events appended after the SSE connection opens", async () => {
    const { app, db, auth } = makeApp();
    const controller = new AbortController();
    try {
      const session = createSession(db, "Live session");
      const response = await app.request(`/api/sessions/${session.id}/events?after=0`, {
        headers: { authorization: `Bearer ${auth.token}` },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("SSE response has no body");
      const decoder = new TextDecoder();
      let received = "";
      async function readUntil(needle: string, timeoutMs: number): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!received.includes(needle)) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error(`timed out waiting for ${needle}; received: ${received}`);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const chunk = await Promise.race([
            reader!.read(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error(`timed out waiting for ${needle}`)), remaining);
            }),
          ]).finally(() => clearTimeout(timer));
          if (chunk.done) throw new Error(`stream ended before ${needle}; received: ${received}`);
          received += decoder.decode(chunk.value, { stream: true });
        }
      }
      await readUntil("session.created", 2000);
      appendSessionEvent(db, session.id, "run.started", { runId: "run-live" });
      await readUntil("run.started", 2000);
      expect(received).toContain("run-live");
    } finally {
      controller.abort();
      db.close();
    }
  });

  it("pins, archives and lists archived sessions separately", async () => {
    const { app, db, auth } = makeApp();
    try {
      const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
      const first = createSession(db, "First");
      const second = createSession(db, "Second");

      const pinned = await app.request(`/api/sessions/${second.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ pinned: true }),
      });
      expect(pinned.status).toBe(200);
      const pinnedBody = (await pinned.json()) as { sessions: Array<{ id: string; pinned: number }> };
      expect(pinnedBody.sessions[0]).toEqual(expect.objectContaining({ id: second.id, pinned: 1 }));

      const active = await app.request("/api/sessions", { headers });
      const activeBody = (await active.json()) as { sessions: Array<{ id: string; archived: number }> };
      expect(activeBody.sessions.map((session) => session.id)).toEqual([second.id, first.id]);
      expect(activeBody.sessions.every((session) => session.archived === 0)).toBe(true);

      const archived = await app.request(`/api/sessions/${first.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ archived: true }),
      });
      expect(archived.status).toBe(200);

      const visible = await app.request("/api/sessions", { headers });
      const visibleBody = (await visible.json()) as { sessions: Array<{ id: string }> };
      expect(visibleBody.sessions.map((session) => session.id)).toEqual([second.id]);

      const hidden = await app.request("/api/sessions?archived=1", { headers });
      const hiddenBody = (await hidden.json()) as { sessions: Array<{ id: string; archived: number }> };
      expect(hiddenBody.sessions).toEqual([expect.objectContaining({ id: first.id, archived: 1 })]);

      const restored = await app.request(`/api/sessions/${first.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ archived: false }),
      });
      const restoredBody = (await restored.json()) as { sessions: Array<{ id: string }> };
      expect(restoredBody.sessions.map((session) => session.id)).toEqual([second.id, first.id]);
    } finally {
      db.close();
    }
  });

  it("refuses a second run while one is running in the session", async () => {
    const { app, db, auth, paths } = makeApp();
    try {
      const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
      const session = createSession(db, "Busy session");
      createRun(db, session.id, null, null, paths.home);
      const blocked = await app.request(`/api/sessions/${session.id}/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "second" }),
      });
      expect(blocked.status).toBe(409);
      const body = (await blocked.json()) as { error: { code: string; fix: string } };
      expect(body.error.code).toBe("RUN_ACTIVE");
      expect(body.error.fix).toContain("Stop the run");
    } finally {
      db.close();
    }
  });

  it("requires CSRF for a cookie-authenticated mutation", async () => {
    const { app, db } = makeApp();
    try {
      const authResponse = await app.request("/api/auth");
      const cookies = authResponse.headers.getSetCookie();
      const sessionCookie = cookies.find((value) => value.startsWith("atelier_session="))?.split(";")[0] ?? "";
      const csrfCookie = cookies.find((value) => value.startsWith("atelier_csrf="))?.split(";")[0] ?? "";
      const csrf = csrfCookie.slice("atelier_csrf=".length);

      const missing = await app.request("/api/sessions", {
        method: "POST",
        headers: { cookie: sessionCookie, "content-type": "application/json" },
        body: JSON.stringify({ title: "No CSRF" }),
      });
      expect(missing.status).toBe(403);

      const allowed = await app.request("/api/sessions", {
        method: "POST",
        headers: {
          cookie: `${sessionCookie}; ${csrfCookie}`,
          "content-type": "application/json",
          "x-atelier-csrf": csrf,
        },
        body: JSON.stringify({ title: "With CSRF" }),
      });
      expect(allowed.status).toBe(201);
    } finally {
      db.close();
    }
  });

  it("returns a structured 404 for an unknown API route", async () => {
    const { app, db, auth } = makeApp();
    try {
      const response = await app.request("/api/nope", { headers: { authorization: `Bearer ${auth.token}` } });
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND");
    } finally {
      db.close();
    }
  });

  it("maps compact failures to honest statuses", async () => {
    const { app, db, auth } = makeApp();
    try {
      const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
      const missing = await app.request("/api/sessions/ses_nope/compact", { method: "POST", headers });
      expect(missing.status).toBe(404);
      const empty = createSession(db, "Empty");
      const none = await app.request(`/api/sessions/${empty.id}/compact`, { method: "POST", headers });
      expect(none.status).toBe(400);
      expect(((await none.json()) as { error: { code: string } }).error.code).toBe("COMPACT_EMPTY");
      const full = createSession(db, "Full");
      appendMessage(db, full.id, "user", "hello", null);
      const noProvider = await app.request(`/api/sessions/${full.id}/compact`, { method: "POST", headers });
      expect(noProvider.status).toBe(502);
      expect(((await noProvider.json()) as { error: { code: string } }).error.code).toBe("COMPACT_FAILED");
    } finally {
      db.close();
    }
  });

  it("uploads, serves and attaches an image to a run", async () => {
    const { app, db, auth } = makeApp();
    try {
      const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
      const bad = await app.request("/api/images", { method: "POST", headers, body: JSON.stringify({ mediaType: "image/png", data: "aGVsbG8=" }) });
      expect(bad.status).toBe(400);
      const up = await app.request("/api/images", { method: "POST", headers, body: JSON.stringify({ mediaType: "image/png", data: png }) });
      expect(up.status).toBe(201);
      const { id } = (await up.json()) as { id: string };
      const served = await app.request(`/api/images/${id}`, { headers: { authorization: headers.authorization } });
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await served.arrayBuffer()).toString("base64")).toBe(png);
      expect((await app.request("/api/images/not-an-id", { headers: { authorization: headers.authorization } })).status).toBe(404);
      const session = createSession(db, "Pic");
      const missing = await app.request(`/api/sessions/${session.id}/runs`, { method: "POST", headers, body: JSON.stringify({ prompt: "x", images: ["0123456789abcdef.png"] }) });
      expect(missing.status).toBe(400);
    } finally {
      db.close();
    }
  });

  it("forks a conversation over HTTP and maps failures", async () => {
    const { app, db, auth } = makeApp();
    try {
      const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
      const source = createSession(db, "Src");
      const first = appendMessage(db, source.id, "user", "one", null);
      appendMessage(db, source.id, "assistant", "two", null);
      const whole = await app.request(`/api/sessions/${source.id}/fork`, { method: "POST", headers, body: "{}" });
      expect(whole.status).toBe(201);
      const forked = (await whole.json()) as { session: { id: string; title: string } };
      expect(forked.session.title).toBe("Fork: Src");
      const part = await app.request(`/api/sessions/${source.id}/fork`, { method: "POST", headers, body: JSON.stringify({ messageId: first.id }) });
      expect(part.status).toBe(201);
      expect((await app.request("/api/sessions/ses_nope/fork", { method: "POST", headers, body: "{}" })).status).toBe(404);
      const empty = createSession(db, "Empty");
      expect((await app.request(`/api/sessions/${empty.id}/fork`, { method: "POST", headers, body: "{}" })).status).toBe(400);
    } finally {
      db.close();
    }
  });

  it("stores hooks through the config route and refuses an invalid one", async () => {
    const { app, db, auth } = makeApp();
    try {
      const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
      const good = await app.request("/api/config", { method: "PUT", headers, body: JSON.stringify({ hooks: [{ id: "guard", event: "pre_tool", match: "bash", command: "echo hi" }] }) });
      expect(good.status).toBe(200);
      const saved = (await good.json()) as { hooks: Array<{ id: string; timeoutMs: number }> };
      expect(saved.hooks[0]).toMatchObject({ id: "guard", timeoutMs: 10_000 });
      const read = (await (await app.request("/api/config", { headers })).json()) as { hooks: Array<{ id: string }> };
      expect(read.hooks.map((hook) => hook.id)).toEqual(["guard"]);
      const bad = await app.request("/api/config", { method: "PUT", headers, body: JSON.stringify({ hooks: [{ id: "x", event: "pre_tool", match: "(", command: "echo" }] }) });
      expect(bad.status).toBe(400);
      const kept = (await (await app.request("/api/config", { headers })).json()) as { hooks: Array<{ id: string }> };
      expect(kept.hooks.map((hook) => hook.id)).toEqual(["guard"]);
    } finally {
      db.close();
    }
  });

  it("stores permission rules through the config route and refuses a bad one", async () => {
    const { app, db, auth } = makeApp();
    try {
      const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
      const good = await app.request("/api/config", { method: "PUT", headers, body: JSON.stringify({ rules: [{ id: "tests", action: "exec", match: "npm test*", decision: "allow" }] }) });
      expect(good.status).toBe(200);
      expect(((await good.json()) as { rules: Array<{ id: string }> }).rules[0]?.id).toBe("tests");
      const read = (await (await app.request("/api/config", { headers })).json()) as { rules: Array<{ id: string }> };
      expect(read.rules.map((rule) => rule.id)).toEqual(["tests"]);
      const bad = await app.request("/api/config", { method: "PUT", headers, body: JSON.stringify({ rules: [{ id: "x", action: "read", match: "a", decision: "allow" }] }) });
      expect(bad.status).toBe(400);
    } finally {
      db.close();
    }
  });

  it("reports the current context use from the latest billed request", async () => {
    const { app, db, auth, paths } = makeApp();
    try {
      const headers = { authorization: `Bearer ${auth.token}` };
      const session = createSession(db, "Ctx");
      const empty = (await (await app.request(`/api/usage?session=${session.id}`, { headers })).json()) as { context: unknown };
      expect(empty.context).toBeNull();
      saveConfig(paths, { ...loadConfig(paths), providers: [{ id: "openai", name: "OpenAI", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1" }] });
      appendSessionEvent(db, session.id, "llm.usage", { providerId: "openai", model: "gpt-4.1", promptTokens: 100, completionTokens: 1, costUsd: 0, priced: true });
      appendSessionEvent(db, session.id, "llm.usage", { providerId: "openai", model: "gpt-4.1", promptTokens: 5000, completionTokens: 1, costUsd: 0, priced: true });
      const body = (await (await app.request(`/api/usage?session=${session.id}`, { headers })).json()) as { context: { usedTokens: number; windowTokens: number | null; model: string } };
      expect(body.context).toMatchObject({ usedTokens: 5000, windowTokens: 1_047_576, model: "gpt-4.1" });
    } finally {
      db.close();
    }
  });

  it("refuses requests addressed to a DNS name that is not local, even with a valid token", async () => {
    const { app, db, auth } = makeApp();
    try {
      const authz = { authorization: `Bearer ${auth.token}` };
      for (const host of ["evil.example", "evil.example:4317", "127.0.0.1.evil.example"]) {
        const bootstrap = await app.request("/api/auth", { headers: { host } });
        expect(bootstrap.status, host).toBe(421);
        expect(bootstrap.headers.getSetCookie()).toEqual([]);
        expect((await app.request("/api/health", { headers: { host, ...authz } })).status, host).toBe(421);
        expect((await app.request("/", { headers: { host } })).status, host).toBe(421);
      }
      const body = (await (await app.request("/api/auth", { headers: { host: "evil.example" } })).json()) as { error: { code: string; fix: string } };
      expect(body.error.code).toBe("HOST_REJECTED");
      expect(body.error.fix).toMatch(/127\.0\.0\.1|localhost/);
    } finally {
      db.close();
    }
  });

  it("still serves localhost, loopback and IP hosts", async () => {
    const { app, db, auth } = makeApp();
    try {
      for (const host of ["localhost:4317", "127.0.0.1:4317", "[::1]:4317", "192.168.1.5:4317"]) {
        const response = await app.request("/api/health", { headers: { host, authorization: `Bearer ${auth.token}` } });
        expect(response.status, host).toBe(200);
      }
    } finally {
      db.close();
    }
  });

  it("stores the shell environment pass-through list and refuses a malformed name", async () => {
    const { app, db, auth } = makeApp();
    try {
      const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
      const good = await app.request("/api/config", { method: "PUT", headers, body: JSON.stringify({ shellEnvPassthrough: ["GITHUB_TOKEN", "NPM_TOKEN"] }) });
      expect(good.status).toBe(200);
      expect(((await good.json()) as { shellEnvPassthrough: string[] }).shellEnvPassthrough).toEqual(["GITHUB_TOKEN", "NPM_TOKEN"]);
      const read = (await (await app.request("/api/config", { headers })).json()) as { shellEnvPassthrough: string[] };
      expect(read.shellEnvPassthrough).toEqual(["GITHUB_TOKEN", "NPM_TOKEN"]);
      const bad = await app.request("/api/config", { method: "PUT", headers, body: JSON.stringify({ shellEnvPassthrough: ["not a name"] }) });
      expect(bad.status).toBe(400);
      expect(((await (await app.request("/api/config", { headers })).json()) as { shellEnvPassthrough: string[] }).shellEnvPassthrough).toEqual(["GITHUB_TOKEN", "NPM_TOKEN"]);
    } finally {
      db.close();
    }
  });
});
