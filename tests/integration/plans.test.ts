import Database from "better-sqlite3";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import { createAuth } from "../../server/auth";
import { ensureHome } from "../../server/config";
import { createSession, listEvents, openDatabase, recoverOnBoot, SCHEMA_VERSION } from "../../server/db";
import { createPlan, deletePlan, getPlan, listPlanRevisions, listPlans, restorePlanRevision, updatePlan } from "../../server/plans";
import { getRun, type RunRow } from "../../server/runs";
import { startSessionRun } from "../../server/runner";
import { loadConfig, loadSecrets, saveConfig, saveSecrets } from "../../server/state";

const tempDirs: string[] = [];
const servers: Server[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "atelier-plans-"));
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

async function fakeProvider(): Promise<number> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"# Provider plan\\n\\nDo the thing."}}]}\n\n');
    response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n');
    response.end("data: [DONE]\n\n");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

function configure(paths: ReturnType<typeof ensureHome>, port: number): void {
  const config = loadConfig(paths);
  saveConfig(paths, {
    ...config,
    providers: [
      { id: "fake", name: "Fake", protocol: "openai-chat", baseUrl: `http://127.0.0.1:${port}/v1`, defaultModel: "gpt-4.1" },
    ],
    defaults: { provider: "fake", model: "gpt-4.1" },
  });
  const secrets = loadSecrets(paths);
  secrets.keys.fake = "sk-plans-test";
  saveSecrets(paths, secrets);
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("plans store", () => {
  it("migrates a schema-6 database to the current schema and creates a plans table", () => {
    const paths = ensureHome(tempHome());
    const first = openDatabase(paths);
    first.close();
    const raw = new Database(paths.db);
    raw.exec("DROP TABLE IF EXISTS plans");
    raw.exec("ALTER TABLE approvals DROP COLUMN preview");
    // A real schema-6 database predates these columns; this fixture is a current one rolled
    // back, so drop them too or the later migrations would re-add existing columns.
    raw.exec("ALTER TABLE messages DROP COLUMN tool_call_id");
    raw.exec("ALTER TABLE messages DROP COLUMN tool_calls");
    raw.pragma("user_version = 6");
    raw.close();

    const migrated = openDatabase(paths);
    try {
      expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
      const table = migrated.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plans'").get() as { name: string } | undefined;
      expect(table?.name).toBe("plans");
      const session = createSession(migrated, "Migrated");
      expect(createPlan(migrated, { sessionId: session.id, body: "one" }).title).toBe("one");
    } finally {
      migrated.close();
    }
  });

  it("creates, lists, updates and deletes a plan with durable events", () => {
    const paths = ensureHome(tempHome());
    const handle = openDatabase(paths);
    try {
      const session = createSession(handle, "Plans");
      const plan = createPlan(handle, { sessionId: session.id, body: "# Ship it\n\nStep one" });
      expect(plan.title).toBe("Ship it");
      expect(plan.status).toBe("draft");
      expect(listPlans(handle, session.id)).toHaveLength(1);

      const updated = updatePlan(handle, plan.id, { title: "Ship v2", status: "active" });
      expect(updated.title).toBe("Ship v2");
      expect(updated.status).toBe("active");
      expect(getPlan(handle, plan.id)?.status).toBe("active");

      deletePlan(handle, plan.id);
      expect(getPlan(handle, plan.id)).toBeNull();

      const types = listEvents(handle, session.id).map((event) => event.type);
      expect(types).toContain("plan.created");
      expect(types).toContain("plan.updated");
      expect(types).toContain("plan.deleted");
    } finally {
      handle.close();
    }
  });

  it("stores a revision per create and update and restores an older body", () => {
    const paths = ensureHome(tempHome());
    const handle = openDatabase(paths);
    try {
      const session = createSession(handle, "Revisions");
      const plan = createPlan(handle, { sessionId: session.id, body: "one" });
      updatePlan(handle, plan.id, { body: "two" });
      updatePlan(handle, plan.id, { body: "three" });

      const revisions = listPlanRevisions(handle, plan.id);
      expect(revisions.map((revision) => revision.body)).toEqual(["three", "two", "one"]);

      const restored = restorePlanRevision(handle, plan.id, revisions[2]?.id ?? "");
      expect(restored.body).toBe("one");
      expect(listPlanRevisions(handle, plan.id)).toHaveLength(4);
    } finally {
      handle.close();
    }
  });

  it("backfills one revision when upgrading a schema-7 database", () => {
    const paths = ensureHome(tempHome());
    const first = openDatabase(paths);
    const session = createSession(first, "Backfill");
    const plan = createPlan(first, { sessionId: session.id, body: "kept" });
    first.close();

    const raw = new Database(paths.db);
    raw.exec("DROP TABLE IF EXISTS plan_revisions");
    raw.exec("ALTER TABLE approvals DROP COLUMN preview");
    raw.exec("ALTER TABLE messages DROP COLUMN tool_call_id");
    raw.exec("ALTER TABLE messages DROP COLUMN tool_calls");
    raw.pragma("user_version = 7");
    raw.close();

    const migrated = openDatabase(paths);
    try {
      expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
      const revisions = listPlanRevisions(migrated, plan.id);
      expect(revisions).toHaveLength(1);
      expect(revisions[0]?.body).toBe("kept");
    } finally {
      migrated.close();
    }
  });
});

describe("plan capture and API", () => {
  it("captures a finished plan-mode run as a draft plan", async () => {
    const port = await fakeProvider();
    const paths = ensureHome(tempHome());
    configure(paths, port);
    const db = openDatabase(paths);
    try {
      recoverOnBoot(db);
      const session = createSession(db, "Plan run");
      const started = startSessionRun(db, session.id, "write a plan", null, paths.home, "plan");
      const run = await waitForRun(() => getRun(db, started.run.id), "finished");
      const plans = listPlans(db, session.id);
      expect(plans).toHaveLength(1);
      expect(plans[0]?.title).toBe("Provider plan");
      expect(plans[0]?.body).toContain("Do the thing");
      expect(plans[0]?.status).toBe("draft");
      expect(plans[0]?.source_run_id).toBe(run.id);
    } finally {
      db.close();
    }
  });

  it("serves plan CRUD and deletes plans with their session", async () => {
    const paths = ensureHome(tempHome());
    const db = openDatabase(paths);
    try {
      const recovery = recoverOnBoot(db);
      const session = createSession(db, "API plans");
      const auth = createAuth(paths);
      const app = createApp({ paths, db, auth, recovery, version: "0.1.0", startedAt: Date.now(), workspace: paths.home });
      const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };

      const created = await app.request("/api/plans", { method: "POST", headers, body: JSON.stringify({ sessionId: session.id, body: "# API plan\n\nBody" }) });
      expect(created.status).toBe(201);
      const createdBody = (await created.json()) as { plan: { id: string; title: string } };
      expect(createdBody.plan.title).toBe("API plan");

      const listed = await app.request(`/api/plans?session=${session.id}`, { headers });
      expect(listed.status).toBe(200);
      expect(((await listed.json()) as { plans: unknown[] }).plans).toHaveLength(1);

      const patched = await app.request(`/api/plans/${createdBody.plan.id}`, { method: "PATCH", headers, body: JSON.stringify({ status: "active" }) });
      expect(patched.status).toBe(200);
      expect(((await patched.json()) as { plan: { status: string } }).plan.status).toBe("active");

      const history = await app.request(`/api/plans/${createdBody.plan.id}/revisions`, { headers });
      expect(history.status).toBe(200);
      const revisions = (await history.json()) as { revisions: Array<{ id: string; body: string }> };
      expect(revisions.revisions.length).toBeGreaterThanOrEqual(2);
      const oldest = revisions.revisions.at(-1);
      const restored = await app.request(`/api/plans/${createdBody.plan.id}/revisions/${oldest?.id}/restore`, { method: "POST", headers });
      expect(restored.status).toBe(200);
      expect(((await restored.json()) as { plan: { body: string } }).plan.body).toContain("API plan");

      const missingSession = await app.request("/api/plans?session=nope", { headers });
      expect(missingSession.status).toBe(404);
      const missingPlan = await app.request("/api/plans/plan_missing", { method: "PATCH", headers, body: JSON.stringify({ status: "done" }) });
      expect(missingPlan.status).toBe(404);

      const removed = await app.request(`/api/plans/${createdBody.plan.id}`, { method: "DELETE", headers });
      expect(removed.status).toBe(200);
      expect(getPlan(db, createdBody.plan.id)).toBeNull();

      createPlan(db, { sessionId: session.id, body: "cascade me" });
      const deletedSession = await app.request(`/api/sessions/${session.id}`, { method: "DELETE", headers });
      expect(deletedSession.status).toBe(200);
      expect(listPlans(db, session.id)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
