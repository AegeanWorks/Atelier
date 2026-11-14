import { Hono } from "hono";
import { AtelierError } from "./config.js";
import { getSession, type DbHandle } from "./db.js";
import { loadConfig } from "./state.js";
import { contextOf, readUsage } from "./usage.js";

export interface UsageRouteDeps {
  db: DbHandle;
}

export function createUsageRoutes(deps: UsageRouteDeps): Hono {
  const app = new Hono();

  app.get("/usage", (c) => {
    const sessionId = c.req.query("session") ?? null;
    if (sessionId !== null && getSession(deps.db, sessionId) === null) {
      throw new AtelierError("NOT_FOUND", "Session not found.", sessionId, "Refresh the conversation list.");
    }
    const summary = readUsage(deps.db, sessionId);
    return c.json({ ...summary, context: contextOf(summary, loadConfig(deps.db.paths)) });
  });

  return app;
}
