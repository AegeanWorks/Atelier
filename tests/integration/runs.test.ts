import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtelierError, ensureHome } from "../../server/config";
import { appendMessage, createSession, listMessages, openDatabase, recoverOnBoot } from "../../server/db";
import {
  acquireLease,
  appendRunStep,
  createRun,
  getRun,
  listRunSteps,
  markRun,
  releaseLease,
  type RunRow,
} from "../../server/runs";
import { resumeRun, startSessionRun } from "../../server/runner";
import { loadConfig, loadSecrets, saveConfig, saveSecrets } from "../../server/state";

const tempDirs: string[] = [];
const servers: Server[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "atelier-runs-"));
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

async function fakeProvider(): Promise<{ port: number; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"provider reply"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n');
    response.end("data: [DONE]\n\n");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { port: address.port, requests };
}

function configure(paths: ReturnType<typeof ensureHome>, port: number): void {
  const config = loadConfig(paths);
  saveConfig(paths, {
    ...config,
    providers: [
      { id: "fake", name: "Fake", protocol: "openai-chat", baseUrl: `http://127.0.0.1:${port}/v1`, defaultModel: "test-model" },
    ],
    defaults: { provider: "fake", model: "test-model" },
  });
  const secrets = loadSecrets(paths);
  secrets.keys.fake = "sk-run-test";
  saveSecrets(paths, secrets);
}

afterEach(async () => {
  delete process.env.ATELIER_RUN_KEY;
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runs and leases", () => {
  it("runs a provider turn and appends an assistant message", async () => {
    const fake = await fakeProvider();
    const paths = ensureHome(tempHome());
    configure(paths, fake.port);
    const db = openDatabase(paths);
    try {
      recoverOnBoot(db);
      const session = createSession(db, "Chat");
      const started = startSessionRun(db, session.id, "hello", "client-1");
      const run = await waitForRun(() => getRun(db, started.run.id), "finished");
      expect(run.status).toBe("finished");
      const messages = listMessages(db, session.id);
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(messages[1]?.text).toBe("provider reply");
      expect(listRunSteps(db, run.id).length).toBe(1);
    } finally {
      db.close();
    }
  });

  it("gives one owner a lease and releases it", () => {
    const paths = ensureHome(tempHome());
    const db = openDatabase(paths);
    try {
      const session = createSession(db, "Lease");
      const run = createRun(db, session.id);
      expect(acquireLease(db, run.id, "owner-a")).toBe(true);
      expect(acquireLease(db, run.id, "owner-b")).toBe(false);
      releaseLease(db, run.id, "owner-a");
      expect(acquireLease(db, run.id, "owner-b")).toBe(true);
      releaseLease(db, run.id, "owner-b");
    } finally {
      db.close();
    }
  });

  it("recovers an interrupted run and resumes it with retry", async () => {
    const fake = await fakeProvider();
    const home = tempHome();
    const paths = ensureHome(home);
    configure(paths, fake.port);
    let db = openDatabase(paths);
    const session = createSession(db, "Crash");
    appendMessage(db, session.id, "user", "recover me", null);
    const run = createRun(db, session.id);
    appendRunStep(db, run.id, "llm_request", "running", { model: "test-model" }, null);
    acquireLease(db, run.id, "dead-owner", 1000);
    db.close();

    db = openDatabase(paths);
    try {
      const recovery = recoverOnBoot(db);
      expect(recovery.actions.some((action) => action.includes(run.id))).toBe(true);
      const blocked = getRun(db, run.id);
      expect(blocked?.status).toBe("blocked");
      expect(blocked?.blocked_reason).toBe("interrupted");
      const resumed = resumeRun(db, run.id, "retry", null);
      expect(resumed.run.id).toBe(run.id);
      const finished = await waitForRun(() => getRun(db, run.id), "finished");
      expect(finished.status).toBe("finished");
      expect(listMessages(db, session.id).some((message) => message.role === "assistant")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("forks a blocked run once and rejects a duplicate fork", async () => {
    const fake = await fakeProvider();
    const paths = ensureHome(tempHome());
    configure(paths, fake.port);
    const db = openDatabase(paths);
    try {
      recoverOnBoot(db);
      const session = createSession(db, "Fork");
      appendMessage(db, session.id, "user", "branch me", null);
      const run = createRun(db, session.id);
      markRun(db, run.id, "blocked", { blockedReason: "interrupted" });
      const fork = resumeRun(db, run.id, "fork", "fork-1");
      expect(fork.run.parent_run_id).toBe(run.id);
      expect(fork.run.fork_id).toBe("fork-1");
      await waitForRun(() => getRun(db, fork.run.id), "finished");
      expect(() => resumeRun(db, run.id, "fork", "fork-1")).toThrow(AtelierError);
    } finally {
      db.close();
    }
  });

  it("runs two conversations concurrently", async () => {
    const fake = await fakeProvider();
    const paths = ensureHome(tempHome());
    configure(paths, fake.port);
    const db = openDatabase(paths);
    try {
      recoverOnBoot(db);
      const first = createSession(db, "Concurrent A");
      const second = createSession(db, "Concurrent B");
      const a = startSessionRun(db, first.id, "first", null);
      const b = startSessionRun(db, second.id, "second", null);
      await Promise.all([waitForRun(() => getRun(db, a.run.id), "finished"), waitForRun(() => getRun(db, b.run.id), "finished")]);
      expect(listMessages(db, first.id)).toHaveLength(2);
      expect(listMessages(db, second.id)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("accepts a retry once and rejects a concurrent second claim", async () => {
    const fake = await fakeProvider();
    const paths = ensureHome(tempHome());
    configure(paths, fake.port);
    const db = openDatabase(paths);
    try {
      recoverOnBoot(db);
      const session = createSession(db, "Resume");
      appendMessage(db, session.id, "user", "retry once", null);
      const run = createRun(db, session.id);
      markRun(db, run.id, "blocked", { blockedReason: "interrupted" });
      resumeRun(db, run.id, "retry", null);
      expect(() => resumeRun(db, run.id, "retry", null)).toThrow(AtelierError);
      await waitForRun(() => getRun(db, run.id), "finished");
    } finally {
      db.close();
    }
  });
});
