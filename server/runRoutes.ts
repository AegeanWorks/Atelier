import { attachMentionedFiles } from "./attachments.js";
import { Hono } from "hono";
import { attachImages, loadImage, saveImage } from "./images.js";
import { forkSession } from "./fork.js";
import { compactSession } from "./summarize.js";
import { z } from "zod";
import { AtelierError } from "./config.js";
import { DELEGATE_SESSIONS_SQL, deleteSession, getSession, listEvents, listMessages, listSessions, type DbHandle } from "./db.js";
import { resumeRun, startSessionRun, stopSessionRun } from "./runner.js";
import { getRun, listRunSteps, listRuns } from "./runs.js";
import { auditRun } from "./audit.js";
import { listApprovals, resolveApproval } from "./approvals.js";
import { latestTodos } from "./todos.js";

const runInput = z.object({
  prompt: z.string().trim().min(1).max(100_000),
  clientId: z.string().trim().min(1).max(100).optional(),
  mode: z.enum(["plan", "build"]).optional(),
  images: z.array(z.string().max(40)).max(8).optional(),
});

const forkInput = z.object({ messageId: z.string().max(100).optional() });

const imageInput = z.object({ mediaType: z.string().max(40), data: z.string().min(1).max(8_000_000) });

const resumeInput = z.object({
  mode: z.enum(["retry", "fork"]),
  forkId: z.string().trim().min(1).max(100).optional(),
});

const approvalInput = z.object({
  decision: z.enum(["approve", "deny"]),
  reason: z.string().trim().max(500).optional(),
});

const patchSession = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export interface RunRouteDeps {
  db: DbHandle;
  workspace: string;
}

export function createRunRoutes(deps: RunRouteDeps): Hono {
  const app = new Hono();

  app.get("/runs", (c) => c.json({ runs: listRuns(deps.db, c.req.query("session") ?? null) }));

  app.get("/audit/:runId", (c) => c.json(auditRun(deps.db, c.req.param("runId"))));

  app.get("/runs/:id/approvals", (c) => {
    const run = getRun(deps.db, c.req.param("id"));
    if (run === null) throw new AtelierError("RUN_NOT_FOUND", "Run not found.", c.req.param("id"), "Refresh the session.");
    return c.json({ approvals: listApprovals(deps.db, { runId: run.id, pendingOnly: c.req.query("pending") === "1" }) });
  });

  app.post("/runs/:id/approvals/:approvalId", async (c) => {
    const run = getRun(deps.db, c.req.param("id"));
    if (run === null) throw new AtelierError("RUN_NOT_FOUND", "Run not found.", c.req.param("id"), "Refresh the session.");
    const parsed = approvalInput.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new AtelierError("APPROVAL_INVALID", "Approval payload is invalid.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send `{ decision: 'approve' | 'deny', reason? }`.");
    }
    const approval = resolveApproval(deps.db, c.req.param("approvalId"), parsed.data.decision === "approve" ? "allow" : "deny", parsed.data.reason ?? "user decision", run.id);
    return c.json({ approval });
  });

  app.get("/sessions/:id/approvals", (c) => {
    const session = getSession(deps.db, c.req.param("id"));
    if (session === null) throw new AtelierError("NOT_FOUND", "Session not found.", c.req.param("id"), "Refresh the conversation list.");
    return c.json({ approvals: listApprovals(deps.db, { sessionId: session.id, pendingOnly: c.req.query("pending") === "1" }) });
  });

  app.get("/runs/:id", (c) => {
    const run = getRun(deps.db, c.req.param("id"));
    if (run === null) throw new AtelierError("RUN_NOT_FOUND", "Run not found.", c.req.param("id"), "Refresh the session.");
    return c.json({ run, steps: listRunSteps(deps.db, run.id) });
  });

  app.post("/sessions/:id/runs", async (c) => {
    const session = getSession(deps.db, c.req.param("id"));
    if (session === null) throw new AtelierError("NOT_FOUND", "Session not found.", c.req.param("id"), "Refresh the conversation list.");
    const parsed = runInput.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new AtelierError("RUN_INVALID", "Run payload is invalid.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send `{ prompt, clientId? }`.");
    }
    const result = startSessionRun(deps.db, session.id, attachImages(deps.db.paths, attachMentionedFiles(deps.workspace, parsed.data.prompt), parsed.data.images ?? []), parsed.data.clientId ?? null, deps.workspace, parsed.data.mode ?? "build");
    return c.json(result, 201);
  });

  app.post("/runs/:id/resume", async (c) => {
    const parsed = resumeInput.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new AtelierError("RESUME_INVALID", "Resume payload is invalid.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send `{ mode: 'retry' | 'fork', forkId? }`.");
    }
    const result = resumeRun(deps.db, c.req.param("id"), parsed.data.mode, parsed.data.forkId ?? null);
    return c.json(result);
  });

  app.post("/images", async (c) => {
    const parsed = imageInput.safeParse(await c.req.json());
    if (!parsed.success) throw new AtelierError("BAD_REQUEST", "Invalid image payload.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send { mediaType, data } with base64 data.");
    return c.json({ id: saveImage(deps.db.paths, parsed.data.mediaType, parsed.data.data) }, 201);
  });

  app.get("/images/:id", (c) => {
    const image = loadImage(deps.db.paths, c.req.param("id"));
    if (image === null) throw new AtelierError("NOT_FOUND", "Image not found.", c.req.param("id"), "Attach the image again.");
    return new Response(Buffer.from(image.data, "base64"), { headers: { "content-type": image.mediaType, "cache-control": "private, max-age=31536000, immutable" } });
  });

  app.post("/sessions/:id/fork", async (c) => {
    const parsed = forkInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AtelierError("BAD_REQUEST", "Invalid fork payload.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send { messageId? }.");
    return c.json({ session: forkSession(deps.db, c.req.param("id"), parsed.data.messageId) }, 201);
  });

  app.post("/sessions/:id/compact", async (c) => {
    const session = getSession(deps.db, c.req.param("id"));
    if (session === null) throw new AtelierError("NOT_FOUND", "Session not found.", c.req.param("id"), "Refresh the conversation list.");
    return c.json(await compactSession(deps.db, session.id), 201);
  });

  app.post("/sessions/:id/stop", (c) => {
    const run = stopSessionRun(deps.db, c.req.param("id"));
    return c.json({ run });
  });

  app.patch("/sessions/:id", async (c) => {
    const session = getSession(deps.db, c.req.param("id"));
    if (session === null) throw new AtelierError("NOT_FOUND", "Session not found.", c.req.param("id"), "Refresh the conversation list.");
    const parsed = patchSession.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new AtelierError("SESSION_INVALID", "Session payload is invalid.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send title, pinned or archived.");
    }
    deps.db.db
      .prepare("UPDATE sessions SET title = ?, pinned = ?, archived = ?, updated = ? WHERE id = ?")
      .run(
        parsed.data.title ?? session.title,
        parsed.data.pinned === undefined ? (deps.db.db.prepare("SELECT pinned FROM sessions WHERE id = ?").get(session.id) as { pinned: number }).pinned : parsed.data.pinned ? 1 : 0,
        parsed.data.archived === undefined ? (deps.db.db.prepare("SELECT archived FROM sessions WHERE id = ?").get(session.id) as { archived: number }).archived : parsed.data.archived ? 1 : 0,
        Date.now(),
        session.id,
      );
    return c.json({ sessions: listSessions(deps.db) });
  });

  app.delete("/sessions/:id", (c) => {
    const session = getSession(deps.db, c.req.param("id"));
    if (session === null) throw new AtelierError("NOT_FOUND", "Session not found.", c.req.param("id"), "Refresh the conversation list.");
    deleteSession(deps.db, session.id);
    return c.json({ ok: true });
  });

  app.get("/search", (c) => {
    const query = (c.req.query("q") ?? "").trim();
    if (query.length === 0) return c.json({ sessions: [], messages: [] });
    const like = `%${query}%`;
    const sessions = deps.db.db
      .prepare(`SELECT id, title, created, updated FROM sessions WHERE archived = 0 AND title LIKE ? AND id NOT IN (${DELEGATE_SESSIONS_SQL}) ORDER BY updated DESC LIMIT 20`)
      .all(like);
    const messages = deps.db.db
      .prepare(`SELECT id, session_id, seq, role, text, created FROM messages WHERE text LIKE ? AND session_id NOT IN (${DELEGATE_SESSIONS_SQL}) ORDER BY created DESC LIMIT 20`)
      .all(like);
    return c.json({ sessions, messages });
  });

  app.get("/sessions/:id/todos", (c) => {
    const session = getSession(deps.db, c.req.param("id"));
    if (session === null) throw new AtelierError("NOT_FOUND", "Session not found.", c.req.param("id"), "Refresh the conversation list.");
    return c.json(latestTodos(deps.db, session.id));
  });

  app.get("/sessions/:id/export", (c) => {
    const session = getSession(deps.db, c.req.param("id"));
    if (session === null) throw new AtelierError("NOT_FOUND", "Session not found.", c.req.param("id"), "Refresh the conversation list.");
    const lines: string[] = [];
    for (const message of listMessages(deps.db, session.id)) lines.push(JSON.stringify({ recordType: "message", ...message }));
    for (const event of listEvents(deps.db, session.id)) lines.push(JSON.stringify({ recordType: "event", ...event }));
    c.header("Content-Type", "application/x-ndjson; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="${session.id}.jsonl"`);
    return c.body(`${lines.join("\n")}\n`);
  });

  return app;
}
