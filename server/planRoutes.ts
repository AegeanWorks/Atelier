import { Hono } from "hono";
import { z } from "zod";
import { AtelierError } from "./config.js";
import { getSession, type DbHandle } from "./db.js";
import { createPlan, deletePlan, getPlan, listPlanRevisions, listPlans, PLAN_STATUSES, restorePlanRevision, updatePlan } from "./plans.js";

const statusSchema = z.enum(PLAN_STATUSES);

const createInput = z.object({
  sessionId: z.string().min(1),
  title: z.string().trim().max(120).optional(),
  body: z.string().trim().min(1).max(100_000),
});

const updateInput = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  body: z.string().trim().min(1).max(100_000).optional(),
  status: statusSchema.optional(),
});

export interface PlanRouteDeps {
  db: DbHandle;
}

function requireSession(db: DbHandle, id: string): void {
  if (getSession(db, id) === null) {
    throw new AtelierError("NOT_FOUND", "Session not found.", id, "Refresh the conversation list.");
  }
}

export function createPlanRoutes(deps: PlanRouteDeps): Hono {
  const app = new Hono();

  app.get("/plans", (c) => {
    const sessionId = c.req.query("session") ?? null;
    if (sessionId !== null) requireSession(deps.db, sessionId);
    return c.json({ plans: listPlans(deps.db, sessionId) });
  });

  app.post("/plans", async (c) => {
    const parsed = createInput.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new AtelierError("BAD_REQUEST", "Invalid plan payload.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send `{ sessionId, title?, body }`.");
    }
    requireSession(deps.db, parsed.data.sessionId);
    const plan = createPlan(deps.db, {
      sessionId: parsed.data.sessionId,
      title: parsed.data.title,
      body: parsed.data.body,
    });
    return c.json({ plan }, 201);
  });

  app.get("/plans/:id", (c) => {
    const plan = getPlan(deps.db, c.req.param("id"));
    if (plan === null) throw new AtelierError("NOT_FOUND", "Plan not found.", c.req.param("id"), "Refresh the plan list.");
    return c.json({ plan });
  });

  app.get("/plans/:id/revisions", (c) => {
    const plan = getPlan(deps.db, c.req.param("id"));
    if (plan === null) throw new AtelierError("NOT_FOUND", "Plan not found.", c.req.param("id"), "Refresh the plan list.");
    return c.json({ revisions: listPlanRevisions(deps.db, plan.id) });
  });

  app.post("/plans/:id/revisions/:revisionId/restore", (c) => {
    return c.json({ plan: restorePlanRevision(deps.db, c.req.param("id"), c.req.param("revisionId")) });
  });

  app.patch("/plans/:id", async (c) => {
    const parsed = updateInput.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new AtelierError("BAD_REQUEST", "Invalid plan payload.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send `{ title?, body?, status? }`.");
    }
    return c.json({ plan: updatePlan(deps.db, c.req.param("id"), parsed.data) });
  });

  app.delete("/plans/:id", (c) => {
    deletePlan(deps.db, c.req.param("id"));
    return c.json({ ok: true });
  });

  return app;
}
