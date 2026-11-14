import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { requireAuth, type AuthConfig } from "./auth.js";
import { AtelierError, type AtelierPaths } from "./config.js";
import {
  appendMessage,
  createSession,
  getSession,
  listEvents,
  listMessages,
  listSessions,
  type DbHandle,
  type RecoverySummary,
} from "./db.js";
import { toReport } from "./errors.js";
import { createProviderRoutes } from "./providers/routes.js";
import { createRunRoutes } from "./runRoutes.js";
import { createWorkspaceRoutes } from "./workspaceRoutes.js";
import { createPreviewRoutes } from "./previewRoutes.js";
import { createEvalRoutes } from "./evalRoutes.js";
import { createUsageRoutes } from "./usageRoutes.js";
import { createPlanRoutes } from "./planRoutes.js";
import { loadConfig, loadSecrets, providerStatuses } from "./state.js";
import { hostAllowed } from "./hosts.js";

export interface AppDeps {
  paths: AtelierPaths;
  db: DbHandle;
  auth: AuthConfig;
  recovery: RecoverySummary;
  version: string;
  startedAt: number;
  workspace: string;
  /** Extra host names (beyond localhost and IP literals) the server answers to, from ATELIER_ALLOWED_HOSTS. */
  allowedHosts?: string[];
}

const createSessionSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
});

const messageSchema = z.object({
  clientId: z.string().trim().min(1).max(100).optional(),
  text: z.string().min(1).max(100_000),
});

const EVENT_POLL_MS = 250;
const EVENT_HEARTBEAT_MS = 15_000;

function cookieOptions(httpOnly: boolean): {
  httpOnly: boolean;
  sameSite: "Strict";
  path: string;
  secure: boolean;
} {
  return { httpOnly, sameSite: "Strict", path: "/", secure: false };
}

function setBrowserCookies(deps: AppDeps, c: Context): void {
  setCookie(c, "atelier_session", deps.auth.token, cookieOptions(true));
  setCookie(c, "atelier_csrf", deps.auth.csrf, cookieOptions(false));
}

function serveIndex(deps: AppDeps, c: Context): Response {
  setBrowserCookies(deps, c);
  const file = join(process.cwd(), "dist", "index.html");
  if (existsSync(file)) {
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(readFileSync(file, "utf8"));
  }
  c.header("Content-Type", "text/html; charset=utf-8");
  return c.body(`<!doctype html><html><head><meta charset="utf-8"><title>atelier</title></head>
<body style="font-family:system-ui;background:#0a0e17;color:#e9eef7;padding:2rem">
<h1>atelier server is running</h1>
<p>The API is on this port. Start the UI with <code>npm run dev</code> and open
<a style="color:#9fc1ff" href="http://127.0.0.1:5173/">http://127.0.0.1:5173/</a>.</p>
</body></html>`);
}

export function createApp(deps: AppDeps): Hono<{ Variables: { authMode: string } }> {
  const app = new Hono<{ Variables: { authMode: string } }>();

  // First of all: a DNS-rebinding page reaches this server under its own domain name, so refuse any Host that is
  // neither localhost, an IP literal nor a name the operator listed. This runs before any cookie or token is issued.
  app.use("*", async (c, next) => {
    if (!hostAllowed(c.req.header("host") ?? new URL(c.req.url).host, deps.allowedHosts ?? [])) {
      return c.json(
        {
          error: {
            code: "HOST_REJECTED",
            what: "This host name is not allowed.",
            why: "Atelier only answers requests addressed to localhost or an IP address, which blocks DNS-rebinding attacks from web pages.",
            fix: "Open it as http://127.0.0.1:<port> or http://localhost:<port>, or list the name in ATELIER_ALLOWED_HOSTS.",
          },
        },
        421,
      );
    }
    await next();
  });

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", c.req.path.startsWith("/api/preview") ? "SAMEORIGIN" : "DENY");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });

  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  // The browser bootstrap is the one API route that establishes the cookie pair.
  app.get("/api/auth", (c) => {
    setBrowserCookies(deps, c);
    return c.json({ ok: true });
  });

  app.use("/api/*", requireAuth(deps.auth));

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      service: "atelier",
      version: deps.version,
      uptimeMs: Date.now() - deps.startedAt,
      workspace: deps.workspace,
      db: {
        ok: deps.db.quickCheck() === "ok",
        schemaVersion: deps.db.schemaVersion,
        sqliteVersion: deps.db.sqliteVersion,
        journalMode: String(deps.db.db.pragma("journal_mode", { simple: true })),
        synchronous: String(deps.db.db.pragma("synchronous", { simple: true })),
      },
      recovery: deps.recovery,
    }),
  );

  app.get("/api/boot", (c) =>
    c.json({
      version: deps.version,
      workspace: deps.workspace,
      sessions: listSessions(deps.db),
      profiles: [
        { id: "minimal", label: "Minimal", tools: ["read_file", "write_file", "bash"] },
        { id: "full", label: "Full", tools: ["read_file", "edit_file", "bash", "git_diff"] },
      ],
      providers: providerStatuses(loadConfig(deps.paths), loadSecrets(deps.paths)),
      recovery: deps.recovery,
    }),
  );

  app.get("/api/recovery", (c) => {
    const rows = deps.db.db
      .prepare("SELECT id, started_at, finished_at, actions, result FROM recovery_log ORDER BY finished_at DESC LIMIT 20")
      .all() as Array<{ id: string; started_at: number; finished_at: number; actions: string; result: string }>;
    return c.json({
      last: deps.recovery,
      history: rows.map((row) => ({
        id: row.id,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        result: row.result,
        actions: JSON.parse(row.actions) as string[],
      })),
    });
  });

  app.get("/api/sessions", (c) => c.json({ sessions: listSessions(deps.db, { archived: c.req.query("archived") === "1" }) }));

  app.post("/api/sessions", async (c) => {
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const parsed = createSessionSchema.safeParse(body);
    if (!parsed.success) {
      throw new AtelierError(
        "BAD_REQUEST",
        "Invalid session payload.",
        parsed.error.issues[0]?.message ?? "Invalid JSON.",
        "Send `{ title?: string }`.",
      );
    }
    const session = createSession(deps.db, parsed.data.title ?? "New conversation");
    return c.json({ session }, 201);
  });

  app.get("/api/sessions/:id/messages", (c) => {
    const session = getSession(deps.db, c.req.param("id"));
    if (!session) throw new AtelierError("NOT_FOUND", "Session not found.", c.req.param("id"), "Refresh the conversation list.");
    return c.json({ session, messages: listMessages(deps.db, session.id) });
  });

  app.post("/api/sessions/:id/messages", async (c) => {
    const session = getSession(deps.db, c.req.param("id"));
    if (!session) throw new AtelierError("NOT_FOUND", "Session not found.", c.req.param("id"), "Refresh the conversation list.");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new AtelierError("BAD_REQUEST", "Message body must be JSON.", "The request body did not parse.", "Send `{ text, clientId? }`.");
    }
    const parsed = messageSchema.safeParse(body);
    if (!parsed.success) {
      throw new AtelierError(
        "BAD_REQUEST",
        "Invalid message payload.",
        parsed.error.issues[0]?.message ?? "Invalid JSON.",
        "Send `{ text, clientId? }`.",
      );
    }
    const message = appendMessage(deps.db, session.id, "user", parsed.data.text, parsed.data.clientId ?? null);
    return c.json({ message }, 201);
  });

  app.get("/api/sessions/:id/events", (c) => {
    const session = getSession(deps.db, c.req.param("id"));
    if (!session) throw new AtelierError("NOT_FOUND", "Session not found.", c.req.param("id"), "Refresh the conversation list.");
    const after = Number(c.req.query("after") ?? "0");
    const once = c.req.query("once") === "1";
    return streamSSE(c, async (stream) => {
      let lastSeq = Number.isFinite(after) ? after : 0;
      const write = async (event: { seq: number; type: string; data: string }): Promise<void> => {
        await stream.writeSSE({ id: String(event.seq), event: event.type, data: event.data });
        lastSeq = event.seq;
      };
      for (const event of listEvents(deps.db, session.id, lastSeq)) await write(event);
      if (once) return;
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });
      let idleTicks = 0;
      while (!closed) {
        await stream.sleep(EVENT_POLL_MS);
        if (closed) break;
        const fresh = listEvents(deps.db, session.id, lastSeq);
        if (fresh.length > 0) {
          idleTicks = 0;
          for (const event of fresh) await write(event);
        } else {
          idleTicks += 1;
          if (idleTicks * EVENT_POLL_MS >= EVENT_HEARTBEAT_MS) {
            idleTicks = 0;
            await stream.writeSSE({ event: "heartbeat", data: "{}" });
          }
        }
      }
    });
  });

  app.route("/api", createProviderRoutes({ paths: deps.paths, db: deps.db }));
  app.route("/api", createRunRoutes({ db: deps.db, workspace: deps.workspace }));
  app.route("/api", createWorkspaceRoutes({ workspace: deps.workspace, home: deps.paths.home }));
  app.route("/api", createPreviewRoutes());
  app.route("/api", createEvalRoutes({ db: deps.db }));
  app.route("/api", createUsageRoutes({ db: deps.db }));
  app.route("/api", createPlanRoutes({ db: deps.db }));

  app.get("/favicon.ico", (c) => c.body(null, 204));

  app.get("/", (c) => serveIndex(deps, c));

  const distRoot = join(process.cwd(), "dist");
  if (existsSync(distRoot)) app.use("/*", serveStatic({ root: "./dist" }));

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: { code: "NOT_FOUND", what: "No such API route." } }, 404);
    }
    return c.text("Not found", 404);
  });

  app.onError((error, c) => {
    const report = toReport(error);
    const status = error instanceof AtelierError
      ? error.code === "NOT_FOUND" || error.code === "PROVIDER_NOT_FOUND"
        ? 404
        : error.code === "BAD_REQUEST" || error.code === "CONFIG_INVALID" || error.code === "CONFIG_PROVIDER" || error.code === "PROVIDER_INVALID"
          ? 400
          : error.code === "RUN_ACTIVE" || error.code === "SKILL_EXISTS"
            ? 409
            : error.code === "COMPACT_EMPTY" || error.code === "FORK_EMPTY"
              ? 400
              : error.code === "COMPACT_FAILED"
                ? 502
                : 500
      : 500;
    if (status === 500) console.error(report);
    return c.json({ error: report }, status);
  });

  return app;
}
