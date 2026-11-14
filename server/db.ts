import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { AtelierError, assertDiskSpace, type AtelierPaths } from "./config.js";

export const SCHEMA_VERSION = 9;

export interface RecoverySummary {
  startedAt: number;
  finishedAt: number;
  actionCount: number;
  result: "clean" | "recovered" | "blocked";
  actions: string[];
}

export interface SessionRow {
  id: string;
  title: string;
  created: number;
  updated: number;
  pinned: number;
  archived: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: string;
  text: string;
  client_id: string | null;
  created: number;
}

export interface EventRow {
  id: string;
  session_id: string;
  seq: number;
  type: string;
  data: string;
  created: number;
}

export interface LlmMemoRow {
  id: string;
  request_hash: string;
  provider_id: string;
  model: string;
  request_json: string;
  response_json: string;
  usage_json: string | null;
  created: number;
}

export interface DbHandle {
  db: Database.Database;
  paths: AtelierPaths;
  schemaVersion: number;
  sqliteVersion: string;
  quickCheck: () => string;
  close: () => void;
}

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  client_id TEXT,
  created INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_client
  ON messages(session_id, client_id) WHERE client_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS events_session_seq ON events(session_id, seq);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status, lease_expires_at);
CREATE TABLE IF NOT EXISTS recovery_log (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  actions TEXT NOT NULL,
  result TEXT NOT NULL
);
`;

const MIGRATION_2 = `
CREATE TABLE IF NOT EXISTS llm_requests (
  id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  usage_json TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS llm_requests_provider ON llm_requests(provider_id, created);
`;

const MIGRATION_3 = `
ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN parent_run_id TEXT;
ALTER TABLE runs ADD COLUMN fork_id TEXT;
ALTER TABLE runs ADD COLUMN profile_id TEXT;
ALTER TABLE runs ADD COLUMN blocked_reason TEXT;
ALTER TABLE runs ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN started_at INTEGER;
ALTER TABLE runs ADD COLUMN finished_at INTEGER;
ALTER TABLE runs ADD COLUMN error TEXT;
ALTER TABLE runs ADD COLUMN workspace TEXT;
CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT,
  output_ref TEXT,
  created INTEGER NOT NULL,
  UNIQUE(run_id, seq)
);
CREATE INDEX IF NOT EXISTS run_steps_run ON run_steps(run_id, seq);
CREATE TABLE IF NOT EXISTS leases (
  run_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS leases_expiry ON leases(expires_at);
CREATE TABLE IF NOT EXISTS interrupts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT,
  status TEXT NOT NULL,
  consumed_by TEXT,
  consumed_at INTEGER,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS interrupts_run ON interrupts(run_id, status);
CREATE TABLE IF NOT EXISTS resume_requests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  fork_id TEXT,
  status TEXT NOT NULL,
  created INTEGER NOT NULL,
  UNIQUE(run_id, mode, fork_id)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const MIGRATION_4 = `
CREATE TABLE IF NOT EXISTS effects (
  effect_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  pre_hash TEXT,
  post_hash TEXT,
  result TEXT,
  created INTEGER NOT NULL,
  settled INTEGER
);
CREATE INDEX IF NOT EXISTS effects_run ON effects(run_id, status);
`;

const MIGRATION_5 = `
CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  suite TEXT NOT NULL,
  suite_hash TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  split TEXT NOT NULL,
  repeat INTEGER NOT NULL,
  profile_json TEXT NOT NULL,
  status TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  environment_json TEXT NOT NULL,
  created INTEGER NOT NULL,
  finished INTEGER
);
CREATE INDEX IF NOT EXISTS eval_runs_suite ON eval_runs(suite, split, created);
CREATE TABLE IF NOT EXISTS eval_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  split TEXT NOT NULL,
  repeat INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  metrics_json TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  trace_ref TEXT,
  diff_ref TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS eval_results_run ON eval_results(run_id, task_id);
CREATE TABLE IF NOT EXISTS eval_baselines (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  suite TEXT NOT NULL,
  suite_hash TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  split TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  run_id TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_changes (
  id TEXT PRIMARY KEY,
  hypothesis TEXT NOT NULL,
  baseline_id TEXT NOT NULL,
  candidate_run_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created INTEGER NOT NULL
);
`;


const MIGRATION_6 = `
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  decision_reason TEXT,
  created INTEGER NOT NULL,
  resolved INTEGER
);
CREATE INDEX IF NOT EXISTS approvals_run ON approvals(run_id, status);
CREATE INDEX IF NOT EXISTS approvals_session ON approvals(session_id, status);
`;

const MIGRATION_7 = `
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  source_run_id TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plans_session ON plans(session_id, updated);
`;

const MIGRATION_8 = `
CREATE TABLE IF NOT EXISTS plan_revisions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_revisions_plan ON plan_revisions(plan_id, created);
INSERT INTO plan_revisions (id, plan_id, title, body, status, created)
  SELECT 'rev_' || id, id, title, body, status, updated FROM plans;
`;

const MIGRATION_9 = `
ALTER TABLE approvals ADD COLUMN preview TEXT;
`;

const MIGRATIONS = [MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6, MIGRATION_7, MIGRATION_8, MIGRATION_9];

function migrate(db: Database.Database): void {
  const version = Number(db.pragma("user_version", { simple: true }));
  if (version > SCHEMA_VERSION) {
    throw new AtelierError(
      "DB_NEWER",
      "The atelier database was written by a newer version.",
      `This build supports schema ${SCHEMA_VERSION}; the file declares ${version}.`,
      "Use the newer atelier build, or move the database aside deliberately; it is never auto-overwritten.",
    );
  }
  for (let current = version; current < SCHEMA_VERSION; current += 1) {
    const sql = MIGRATIONS[current];
    if (sql === undefined) throw new AtelierError("DB_MIGRATION", "Missing database migration.", `No migration for schema ${current}.`, "Use a complete atelier build.");
    const transaction = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${current + 1}`);
    });
    transaction();
  }
}

export function openDatabase(paths: AtelierPaths, options: { readonly?: boolean } = {}): DbHandle {
  assertDiskSpace(paths.home);
  const db = new Database(paths.db, { readonly: options.readonly ?? false });
  if (!options.readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("busy_timeout = 3000");
    db.pragma("foreign_keys = ON");
    db.pragma("cache_size = -65536");
    db.pragma("mmap_size = 268435456");
    db.pragma("temp_store = MEMORY");
    db.pragma("wal_autocheckpoint = 4000");
  }
  try {
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const quickCheck = (): string => String(db.pragma("quick_check", { simple: true }));
  const check = quickCheck();
  if (check !== "ok") {
    db.close();
    throw new AtelierError(
      "DB_CORRUPT",
      `SQLite quick_check failed for ${paths.db}.`,
      check,
      "Stop atelier, keep the file, and restore the newest `VACUUM INTO` backup; never delete evidence.",
    );
  }
  const sqliteVersion = String((db.prepare("SELECT sqlite_version() AS version").get() as { version?: string } | undefined)?.version ?? "unknown");
  return {
    db,
    paths,
    schemaVersion: SCHEMA_VERSION,
    sqliteVersion,
    quickCheck,
    close: () => db.close(),
  };
}

export function rebuildMessages(handle: DbHandle): number {
  const rows = handle.db
    .prepare("SELECT id, session_id, seq, type, data, created FROM events WHERE type IN ('user.message', 'text.ended') ORDER BY session_id, seq")
    .all() as EventRow[];
  const transaction = handle.db.transaction(() => {
    handle.db.prepare("DELETE FROM messages").run();
    const counters = new Map<string, number>();
    for (const row of rows) {
      const data = JSON.parse(row.data) as { messageId?: string; text?: string; clientId?: string | null };
      const seq = (counters.get(row.session_id) ?? 0) + 1;
      counters.set(row.session_id, seq);
      handle.db
        .prepare("INSERT INTO messages (id, session_id, seq, role, text, client_id, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          typeof data.messageId === "string" ? data.messageId : randomUUID(),
          row.session_id,
          seq,
          row.type === "user.message" ? "user" : "assistant",
          data.text ?? "",
          data.clientId ?? null,
          row.created,
        );
    }
  });
  transaction();
  return rows.length;
}

export function recoverOnBoot(handle: DbHandle): RecoverySummary {
  const startedAt = Date.now();
  const actions: string[] = [];
  const now = Date.now();
  const expired = handle.db.prepare("DELETE FROM leases WHERE expires_at < ?").run(now).changes;
  if (expired > 0) actions.push(`expired ${expired} lease(s)`);
  const rows = handle.db
    .prepare("SELECT id, status FROM runs WHERE status IN ('running', 'claimed', 'resuming')")
    .all() as Array<{ id: string; status: string }>;
  if (rows.length > 0) {
    const transaction = handle.db.transaction(() => {
      for (const row of rows) {
        handle.db
          .prepare("UPDATE runs SET status = 'blocked', blocked_reason = 'interrupted', recovery_attempts = recovery_attempts + 1, updated = ? WHERE id = ? AND status IN ('running', 'claimed', 'resuming')")
          .run(Date.now(), row.id);
        actions.push(`run ${row.id}: ${row.status} -> blocked (interrupted)`);
      }
    });
    transaction();
  }
  const pending = handle.db.prepare("UPDATE effects SET status = 'unknown', settled = ? WHERE status = 'intent'").run(now).changes;
  if (pending > 0) actions.push(`${pending} effect(s) -> unknown`);
  const approvals = handle.db.prepare("UPDATE approvals SET status = 'expired', decision_reason = 'boot recovery', resolved = ? WHERE status = 'pending'").run(now).changes;
  if (approvals > 0) actions.push(`${approvals} approval(s) -> expired`);
  const projection = handle.db.prepare("SELECT value FROM meta WHERE key = 'projection_version'").get() as { value: string } | undefined;
  if (projection?.value !== "1") {
    const count = rebuildMessages(handle);
    handle.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('projection_version', '1')").run();
    if (count > 0) actions.push(`projection rebuilt (${count} message event(s))`);
  }
  const finishedAt = Date.now();
  const result: RecoverySummary["result"] = actions.length === 0 ? "clean" : "recovered";
  handle.db
    .prepare("INSERT INTO recovery_log (id, started_at, finished_at, actions, result) VALUES (?, ?, ?, ?, ?)")
    .run(randomUUID(), startedAt, finishedAt, JSON.stringify(actions), result);
  return { startedAt, finishedAt, actionCount: actions.length, result, actions };
}

function nextSeq(db: Database.Database, table: "events" | "messages", sessionId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ${table} WHERE session_id = ?`)
    .get(sessionId) as { next: number };
  return row.next;
}

export function createSession(handle: DbHandle, title: string): SessionRow {
  const now = Date.now();
  const session: SessionRow = { id: `ses_${randomUUID()}`, title, created: now, updated: now, pinned: 0, archived: 0 };
  const transaction = handle.db.transaction(() => {
    handle.db
      .prepare("INSERT INTO sessions (id, title, created, updated) VALUES (?, ?, ?, ?)")
      .run(session.id, session.title, session.created, session.updated);
    handle.db
      .prepare("INSERT INTO events (id, session_id, seq, type, data, created) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), session.id, 1, "session.created", JSON.stringify({ title }), now);
  });
  transaction();
  return session;
}

export function listSessions(handle: DbHandle, options: { archived?: boolean } = {}): SessionRow[] {
  const archived = options.archived === true ? 1 : 0;
  return handle.db
    .prepare("SELECT id, title, created, updated, pinned, archived FROM sessions WHERE archived = ? ORDER BY pinned DESC, updated DESC")
    .all(archived) as SessionRow[];
}

export function getSession(handle: DbHandle, id: string): SessionRow | null {
  const row = handle.db.prepare("SELECT id, title, created, updated, pinned, archived FROM sessions WHERE id = ?").get(id) as
    | SessionRow
    | undefined;
  return row ?? null;
}

export function appendMessage(
  handle: DbHandle,
  sessionId: string,
  role: "user" | "assistant",
  text: string,
  clientId: string | null,
): MessageRow {
  const now = Date.now();
  const transaction = handle.db.transaction(() => {
    if (clientId !== null) {
      const existing = handle.db
        .prepare("SELECT id, session_id, seq, role, text, client_id, created FROM messages WHERE session_id = ? AND client_id = ?")
        .get(sessionId, clientId) as MessageRow | undefined;
      if (existing) return existing;
    }
    const seq = nextSeq(handle.db, "messages", sessionId);
    const message: MessageRow = {
      id: `msg_${randomUUID()}`,
      session_id: sessionId,
      seq,
      role,
      text,
      client_id: clientId,
      created: now,
    };
    handle.db
      .prepare("INSERT INTO messages (id, session_id, seq, role, text, client_id, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(message.id, message.session_id, message.seq, message.role, message.text, message.client_id, message.created);
    const eventSeq = nextSeq(handle.db, "events", sessionId);
    handle.db
      .prepare("INSERT INTO events (id, session_id, seq, type, data, created) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        randomUUID(),
        sessionId,
        eventSeq,
        role === "user" ? "user.message" : "text.ended",
        JSON.stringify({ messageId: message.id, text, clientId }),
        now,
      );
    handle.db.prepare("UPDATE sessions SET updated = ? WHERE id = ?").run(now, sessionId);
    return message;
  });
  return transaction();
}

export function listMessages(handle: DbHandle, sessionId: string): MessageRow[] {
  return handle.db
    .prepare("SELECT id, session_id, seq, role, text, client_id, created FROM messages WHERE session_id = ? ORDER BY seq ASC")
    .all(sessionId) as MessageRow[];
}

export function listEvents(handle: DbHandle, sessionId: string, after = 0): EventRow[] {
  return handle.db
    .prepare("SELECT id, session_id, seq, type, data, created FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC")
    .all(sessionId, after) as EventRow[];
}

export function getLlmMemo(handle: DbHandle, requestHash: string): LlmMemoRow | null {
  const row = handle.db
    .prepare("SELECT id, request_hash, provider_id, model, request_json, response_json, usage_json, created FROM llm_requests WHERE request_hash = ?")
    .get(requestHash) as LlmMemoRow | undefined;
  return row ?? null;
}

export function putLlmMemo(
  handle: DbHandle,
  entry: {
    requestHash: string;
    providerId: string;
    model: string;
    request: unknown;
    events: unknown;
    usage: unknown;
  },
): void {
  handle.db
    .prepare(
      "INSERT OR REPLACE INTO llm_requests (id, request_hash, provider_id, model, request_json, response_json, usage_json, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      randomUUID(),
      entry.requestHash,
      entry.providerId,
      entry.model,
      JSON.stringify(entry.request),
      JSON.stringify(entry.events),
      entry.usage === null ? null : JSON.stringify(entry.usage),
      Date.now(),
    );
}

export function countLlmMemos(handle: DbHandle): number {
  return (handle.db.prepare("SELECT COUNT(*) AS n FROM llm_requests").get() as { n: number }).n;
}
