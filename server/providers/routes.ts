import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { AtelierError, type AtelierPaths } from "../config.js";
import type { DbHandle } from "../db.js";
import {
  loadConfig,
  loadSecrets,
  hookSchema,
  mcpServerSchema,
  ruleSchema,
  providerStatuses,
  removeProvider,
  saveConfig,
  saveSecrets,
  upsertProvider,
  validateProvider,
} from "../state.js";
import { catalogFor } from "./catalog.js";
import { listModels, findProvider, probeModels } from "./registry.js";
import { collectProvider, replayMemo, saveMemo, streamProvider } from "./run.js";
import type { ChatRequest, ProviderConfig, StreamEvent } from "./types.js";

const providerInput = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/).optional(),
  name: z.string().trim().min(1).max(80),
  protocol: z.enum(["openai-chat", "openai-responses", "anthropic-messages", "gemini"]),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1).max(20_000).optional(),
  apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  defaultModel: z.string().min(1).optional(),
  fallbackId: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().min(1000).max(120_000).optional(),
});

const providerUpdate = providerInput.extend({ clearKey: z.boolean().optional() });

const chatRequest = z.object({
  model: z.string().min(1),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant", "tool"]),
      content: z.string(),
      toolCallId: z.string().optional(),
      name: z.string().optional(),
      toolCalls: z.array(z.object({ id: z.string(), name: z.string(), input: z.unknown() })).optional(),
    }),
  ).min(1),
  tools: z.array(z.object({ name: z.string().min(1), description: z.string(), parameters: z.record(z.string(), z.unknown()) })).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(200_000).optional(),
});

const configInput = z.object({
  roles: z.object({
    executor: z.string().nullable(),
    manager: z.string().nullable(),
    auditor: z.string().nullable(),
    compactor: z.string().nullable(),
  }).partial().optional(),
  defaults: z.object({ provider: z.string().nullable(), model: z.string().nullable() }).partial().optional(),
  mcpServers: z.array(mcpServerSchema).optional(),
  hooks: z.array(hookSchema).optional(),
  rules: z.array(ruleSchema).optional(),
});

function idFrom(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "provider";
}

function pick<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

export interface ProviderRouteDeps {
  paths: AtelierPaths;
  db: DbHandle;
}

export function createProviderRoutes(deps: ProviderRouteDeps): Hono {
  const app = new Hono();

  app.get("/providers", (c) => {
    const config = loadConfig(deps.paths);
    const secrets = loadSecrets(deps.paths);
    return c.json({ providers: providerStatuses(config, secrets) });
  });

  app.post("/providers", async (c) => {
    const parsed = providerInput.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new AtelierError("PROVIDER_INVALID", "Provider payload is invalid.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send name, protocol and baseUrl; id is derived when omitted.");
    }
    const config = loadConfig(deps.paths);
    const secrets = loadSecrets(deps.paths);
    const id = parsed.data.id ?? idFrom(parsed.data.name);
    const provider: ProviderConfig = {
      id,
      name: parsed.data.name,
      protocol: parsed.data.protocol,
      baseUrl: parsed.data.baseUrl,
      ...(parsed.data.apiKeyEnv === undefined ? {} : { apiKeyEnv: parsed.data.apiKeyEnv }),
      ...(parsed.data.defaultModel === undefined ? {} : { defaultModel: parsed.data.defaultModel }),
      ...(parsed.data.fallbackId === undefined ? {} : { fallbackId: parsed.data.fallbackId }),
      ...(parsed.data.headers === undefined ? {} : { headers: parsed.data.headers }),
      ...(parsed.data.timeoutMs === undefined ? {} : { timeoutMs: parsed.data.timeoutMs }),
    };
    validateProvider(provider);
    saveConfig(deps.paths, upsertProvider(config, provider));
    if (parsed.data.apiKey !== undefined) {
      secrets.keys[id] = parsed.data.apiKey;
      saveSecrets(deps.paths, secrets);
    }
    const updated = loadConfig(deps.paths);
    const updatedSecrets = loadSecrets(deps.paths);
    return c.json({ provider: providerStatuses(updated, updatedSecrets).find((entry) => entry.id === id) ?? null }, 201);
  });

  app.put("/providers/:id", async (c) => {
    const id = c.req.param("id");
    const config = loadConfig(deps.paths);
    const secrets = loadSecrets(deps.paths);
    const existing = findProvider(config, id);
    const parsed = providerUpdate.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new AtelierError("PROVIDER_INVALID", "Provider payload is invalid.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send name, protocol and baseUrl; apiKey and clearKey are optional.");
    }
    const provider: ProviderConfig = {
      id,
      name: parsed.data.name,
      protocol: parsed.data.protocol,
      baseUrl: parsed.data.baseUrl,
      ...(parsed.data.apiKeyEnv === undefined ? (existing.apiKeyEnv === undefined ? {} : { apiKeyEnv: existing.apiKeyEnv }) : { apiKeyEnv: parsed.data.apiKeyEnv }),
      ...(parsed.data.defaultModel === undefined ? (existing.defaultModel === undefined ? {} : { defaultModel: existing.defaultModel }) : { defaultModel: parsed.data.defaultModel }),
      ...(parsed.data.fallbackId === undefined ? (existing.fallbackId === undefined ? {} : { fallbackId: existing.fallbackId }) : { fallbackId: parsed.data.fallbackId }),
      ...(parsed.data.headers === undefined ? (existing.headers === undefined ? {} : { headers: existing.headers }) : { headers: parsed.data.headers }),
      ...(parsed.data.timeoutMs === undefined ? (existing.timeoutMs === undefined ? {} : { timeoutMs: existing.timeoutMs }) : { timeoutMs: parsed.data.timeoutMs }),
    };
    validateProvider(provider);
    saveConfig(deps.paths, upsertProvider(config, provider));
    if (parsed.data.apiKey !== undefined) {
      secrets.keys[id] = parsed.data.apiKey;
      saveSecrets(deps.paths, secrets);
    } else if (parsed.data.clearKey === true) {
      delete secrets.keys[id];
      saveSecrets(deps.paths, secrets);
    }
    const updated = loadConfig(deps.paths);
    const updatedSecrets = loadSecrets(deps.paths);
    return c.json({ provider: providerStatuses(updated, updatedSecrets).find((entry) => entry.id === id) ?? null });
  });

  app.delete("/providers/:id", (c) => {
    const config = loadConfig(deps.paths);
    const secrets = loadSecrets(deps.paths);
    saveConfig(deps.paths, removeProvider(config, c.req.param("id")));
    delete secrets.keys[c.req.param("id")];
    saveSecrets(deps.paths, secrets);
    return c.json({ ok: true });
  });

  app.post("/providers/:id/test", async (c) => {
    const config = loadConfig(deps.paths);
    const secrets = loadSecrets(deps.paths);
    const provider = findProvider(config, c.req.param("id"));
    const started = performance.now();
    try {
      const models = await probeModels(provider, secrets, c.req.raw.signal);
      return c.json({ ok: true, modelCount: models.length, models: models.slice(0, 20), latencyMs: Math.round(performance.now() - started) });
    } catch (error) {
      const detail = error instanceof AtelierError
        ? { code: error.code, what: error.message, why: error.why, fix: error.fix }
        : { code: "PROVIDER_TEST", what: error instanceof Error ? error.message : String(error), why: "The provider did not answer.", fix: "Check the URL and key, then retry." };
      return c.json({ ok: false, error: detail, latencyMs: Math.round(performance.now() - started) }, 502);
    }
  });

  app.get("/models", async (c) => {
    const config = loadConfig(deps.paths);
    const secrets = loadSecrets(deps.paths);
    const providerId = c.req.query("provider");
    if (providerId === undefined) {
      return c.json({
        models: config.providers.flatMap((provider) =>
          catalogFor(provider).map((model) => ({ ...model, providerId: provider.id, protocol: provider.protocol })),
        ),
      });
    }
    const provider = findProvider(config, providerId);
    const models = await listModels(provider, secrets, c.req.raw.signal);
    return c.json({ models, providerId });
  });

  app.get("/config", (c) => {
    const config = loadConfig(deps.paths);
    const secrets = loadSecrets(deps.paths);
    return c.json({ providers: providerStatuses(config, secrets), roles: config.roles, defaults: config.defaults, mcpServers: config.mcpServers, hooks: config.hooks, rules: config.rules });
  });

  app.put("/config", async (c) => {
    const parsed = configInput.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new AtelierError("CONFIG_INVALID", "Config payload is invalid.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send roles and defaults with known provider ids.");
    }
    const config = loadConfig(deps.paths);
    const ids = new Set(config.providers.map((provider) => provider.id));
    const roles = {
      executor: pick(parsed.data.roles?.executor, config.roles.executor),
      manager: pick(parsed.data.roles?.manager, config.roles.manager),
      auditor: pick(parsed.data.roles?.auditor, config.roles.auditor),
      compactor: pick(parsed.data.roles?.compactor, config.roles.compactor),
    };
    for (const id of Object.values(roles)) {
      if (id !== null && !ids.has(id)) throw new AtelierError("CONFIG_PROVIDER", "Role names an unknown provider.", String(id), "Add the provider first.");
    }
    const defaults = {
      provider: pick(parsed.data.defaults?.provider, config.defaults.provider),
      model: pick(parsed.data.defaults?.model, config.defaults.model),
    };
    if (defaults.provider !== null && !ids.has(defaults.provider)) {
      throw new AtelierError("CONFIG_PROVIDER", "Default provider is unknown.", defaults.provider, "Add the provider first.");
    }
    const mcpServers = pick(parsed.data.mcpServers, config.mcpServers);
    const hooks = pick(parsed.data.hooks, config.hooks);
    const rules = pick(parsed.data.rules, config.rules);
    saveConfig(deps.paths, { ...config, roles, defaults, mcpServers, hooks, rules });
    return c.json({ roles, defaults, mcpServers, hooks, rules });
  });

  app.post("/providers/:id/complete", async (c) => {
    const parsed = chatRequest.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new AtelierError("CHAT_INVALID", "Chat request is invalid.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send model and messages.");
    }
    const config = loadConfig(deps.paths);
    const secrets = loadSecrets(deps.paths);
    const result = await collectProvider(deps.db, config, secrets, c.req.param("id"), parsed.data as ChatRequest, c.req.raw.signal);
    return c.json(result);
  });

  app.post("/providers/:id/stream", async (c) => {
    const parsed = chatRequest.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new AtelierError("CHAT_INVALID", "Chat request is invalid.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send model and messages.");
    }
    const config = loadConfig(deps.paths);
    const secrets = loadSecrets(deps.paths);
    const providerId = c.req.param("id");
    const request = parsed.data as ChatRequest;
    return streamSSE(c, async (stream) => {
      const memo = replayMemo(deps.db, providerId, request);
      if (memo !== null) {
        for (const event of memo.events) await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        return;
      }
      const events: StreamEvent[] = [];
      let active = providerId;
      try {
        for await (const event of streamProvider(config, secrets, providerId, request, c.req.raw.signal)) {
          events.push(event);
          if (event.type === "provider.failover") active = event.to;
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        }
      } catch (error) {
        const event: StreamEvent = error instanceof AtelierError
          ? { type: "error", message: error.message, code: error.code }
          : { type: "error", message: error instanceof Error ? error.message : String(error) };
        events.push(event);
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      }
      saveMemo(deps.db, active, request, events);
    });
  });

  return app;
}
