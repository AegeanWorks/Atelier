import { copyFileSync, existsSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { AtelierError, assertDiskSpace, type AtelierPaths } from "./config.js";
import { catalogFor } from "./providers/catalog.js";
import type { ModelInfo, Protocol, ProviderConfig, ProviderStatus } from "./providers/types.js";

export const CONFIG_SCHEMA = 1;
export const SECRETS_SCHEMA = 1;

const protocolSchema = z.enum(["openai-chat", "openai-responses", "anthropic-messages", "gemini"]);

const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutput: z.number().int().positive().optional(),
  tools: z.boolean().optional(),
  vision: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  pricing: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }).optional(),
});

const providerSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/, "provider id must be lowercase letters, digits, '-' or '_'"),
  name: z.string().trim().min(1).max(80),
  protocol: protocolSchema,
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "apiKeyEnv must be an environment variable name").optional(),
  headers: z.record(z.string(), z.string()).optional(),
  defaultModel: z.string().min(1).optional(),
  fallbackId: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  models: z.array(modelSchema).optional(),
});

const rolesSchema = z.object({
  executor: z.string().nullable(),
  manager: z.string().nullable(),
  auditor: z.string().nullable(),
  compactor: z.string().nullable(),
});

export const mcpServerSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/, "mcp server id must be lowercase letters, digits, '-' or '_'"),
  name: z.string().trim().min(1).max(80),
  transport: z.enum(["stdio", "http", "sse"]).default("stdio"),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
}).superRefine((value, context) => {
  if (value.transport === "stdio" && value.command === undefined) {
    context.addIssue({ code: "custom", message: "stdio MCP server needs a command", path: ["command"] });
  }
  if ((value.transport === "http" || value.transport === "sse") && value.url === undefined) {
    context.addIssue({ code: "custom", message: `${value.transport} MCP server needs a url`, path: ["url"] });
  }
});

export const hookSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/, "hook id must be lowercase letters, digits, '-' or '_'"),
  event: z.enum(["pre_tool", "post_tool"]),
  match: z.string().max(200).default(".*").refine((value) => {
    try {
      new RegExp(value);
      return true;
    } catch {
      return false;
    }
  }, "match must be a valid regular expression over the tool name"),
  command: z.string().trim().min(1).max(2000),
  timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
});

export const ruleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/, "rule id must be lowercase letters, digits, '-' or '_'"),
  action: z.enum(["exec", "edit"]),
  match: z.string().min(1).max(500),
  decision: z.enum(["allow", "deny"]),
});

const configSchema = z.object({
  schema: z.literal(CONFIG_SCHEMA),
  providers: z.array(providerSchema),
  roles: rolesSchema,
  defaults: z.object({ provider: z.string().nullable(), model: z.string().nullable() }),
  mcpServers: z.array(mcpServerSchema).optional().default([]),
  hooks: z.array(hookSchema).optional().default([]),
  rules: z.array(ruleSchema).optional().default([]),
  shellEnvPassthrough: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "a variable name")).max(100).optional().default([]),
});

const secretsSchema = z.object({
  schema: z.literal(SECRETS_SCHEMA),
  keys: z.record(z.string(), z.string()),
});

export type Config = z.infer<typeof configSchema>;
export type Secrets = z.infer<typeof secretsSchema>;

export function defaultConfig(): Config {
  return {
    schema: CONFIG_SCHEMA,
    providers: [],
    roles: { executor: null, manager: null, auditor: null, compactor: null },
    defaults: { provider: null, model: null },
    mcpServers: [],
    hooks: [],
    rules: [],
    shellEnvPassthrough: [],
  };
}

function defaultSecrets(): Secrets {
  return { schema: SECRETS_SCHEMA, keys: {} };
}

function fsyncDirectory(path: string): void {
  try {
    const fd = openSync(dirname(path), "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is unavailable on Windows; file fsync + rename remains.
  }
}

export function writeJsonAtomic(path: string, value: unknown, options: { mode?: number; backup?: boolean } = {}): void {
  assertDiskSpace(dirname(path));
  const temp = `${path}.tmp_${process.pid}_${Date.now()}`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  let fd: number | null = null;
  try {
    fd = openSync(temp, "w", options.mode ?? 0o600);
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (options.backup && existsSync(path)) copyFileSync(path, `${path}.bak`);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        renameSync(temp, path);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!["EPERM", "EBUSY", "EACCES"].includes(code ?? "") || attempt === 4) throw error;
        sleepSync(20 * 2 ** attempt);
      }
    }
    fsyncDirectory(path);
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The descriptor is already closed by a successful write.
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // The rename consumed the temp file.
    }
  }
}

function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function loadWithRecovery<T>(
  path: string,
  schema: z.ZodType<T>,
  fallback: () => T,
  code: string,
  options: { mode?: number; backup?: boolean } = {},
): T {
  try {
    if (!existsSync(path)) {
      const initial = fallback();
      writeJsonAtomic(path, initial, options);
      return initial;
    }
    const parsed = readJson(path);
    const version = typeof parsed === "object" && parsed !== null ? (parsed as { schema?: unknown }).schema : undefined;
    if (typeof version === "number" && version > 1) {
      throw new AtelierError(
        `${code}_NEWER`,
        `${path} was written by a newer version.`,
        `This build supports schema 1; the file declares ${version}.`,
        "Use the newer atelier build, or move the file aside deliberately; it is never auto-overwritten.",
      );
    }
    const result = schema.safeParse(parsed);
    if (!result.success) throw new Error(result.error.issues[0]?.message ?? "invalid schema");
    return result.data;
  } catch (error) {
    if (error instanceof AtelierError && error.code.endsWith("_NEWER")) throw error;
    const stamp = Date.now();
    if (existsSync(path)) {
      try {
        renameSync(path, `${path}.corrupt-${stamp}`);
      } catch {
        // The file may be locked; the fallback still keeps the server alive.
      }
    }
    if (existsSync(`${path}.bak`)) {
      try {
        const backup = readJson(`${path}.bak`);
        const result = schema.safeParse(backup);
        if (result.success) {
          writeJsonAtomic(path, result.data, options);
          return result.data;
        }
      } catch {
        // A corrupt backup falls through to defaults.
      }
    }
    const restored = fallback();
    writeJsonAtomic(path, restored, options);
    return restored;
  }
}

export function loadConfig(paths: AtelierPaths): Config {
  return loadWithRecovery(paths.config, configSchema, defaultConfig, "CONFIG", { backup: true });
}

export function saveConfig(paths: AtelierPaths, config: Config): void {
  writeJsonAtomic(paths.config, config, { backup: true });
}

export function loadSecrets(paths: AtelierPaths): Secrets {
  return loadWithRecovery(paths.secrets, secretsSchema, defaultSecrets, "SECRETS", { mode: 0o600, backup: true });
}

export function saveSecrets(paths: AtelierPaths, secrets: Secrets): void {
  writeJsonAtomic(paths.secrets, secrets, { mode: 0o600, backup: true });
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

export function validateProvider(provider: ProviderConfig): void {
  const parsed = providerSchema.safeParse(provider);
  if (!parsed.success) {
    throw new AtelierError(
      "PROVIDER_INVALID",
      "Provider configuration is invalid.",
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      "Use the Settings panel or POST /api/providers with a valid protocol, baseUrl and id.",
    );
  }
  let url: URL;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    throw new AtelierError("PROVIDER_URL", "Provider baseUrl is not a URL.", provider.baseUrl, "Use https:// or a loopback http:// URL.");
  }
  if (url.username || url.password) {
    throw new AtelierError("PROVIDER_URL", "Provider baseUrl must not embed credentials.", provider.baseUrl, "Put the key in the environment or secrets store.");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new AtelierError(
      "PROVIDER_URL",
      "Plaintext HTTP is only allowed for loopback providers.",
      `${url.hostname} is not loopback.`,
      "Use https://, or bind a local provider to 127.0.0.1.",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AtelierError("PROVIDER_URL", "Unsupported provider URL scheme.", url.protocol, "Use https:// or loopback http://.");
  }
}

export function resolveApiKey(
  provider: ProviderConfig,
  secrets: Secrets,
  env: NodeJS.ProcessEnv = process.env,
): { key: string | null; source: "env" | "secret" | "missing" } {
  if (provider.apiKeyEnv !== undefined) {
    const value = env[provider.apiKeyEnv];
    if (typeof value === "string" && value.trim().length > 0) return { key: value, source: "env" };
  }
  const stored = secrets.keys[provider.id];
  if (typeof stored === "string" && stored.trim().length > 0) return { key: stored, source: "secret" };
  return { key: null, source: "missing" };
}

export function providerStatuses(config: Config, secrets: Secrets, env: NodeJS.ProcessEnv = process.env): ProviderStatus[] {
  return config.providers.map((provider) => {
    const key = resolveApiKey(provider, secrets, env);
    return {
      id: provider.id,
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel ?? catalogFor(provider)[0]?.id ?? null,
      modelCount: catalogFor(provider).length,
      key: { set: key.key !== null, source: key.source },
    };
  });
}

export function upsertProvider(config: Config, provider: ProviderConfig): Config {
  validateProvider(provider);
  const providers = config.providers.filter((entry) => entry.id !== provider.id);
  providers.push(provider);
  return { ...config, providers };
}

export function removeProvider(config: Config, id: string): Config {
  return {
    ...config,
    providers: config.providers.filter((provider) => provider.id !== id),
    roles: {
      executor: config.roles.executor === id ? null : config.roles.executor,
      manager: config.roles.manager === id ? null : config.roles.manager,
      auditor: config.roles.auditor === id ? null : config.roles.auditor,
      compactor: config.roles.compactor === id ? null : config.roles.compactor,
    },
    defaults: config.defaults.provider === id ? { provider: null, model: null } : config.defaults,
  };
}

export function modelForProvider(provider: ProviderConfig): ModelInfo[] {
  return provider.models ?? [];
}

export function normalizeProtocol(value: string): Protocol {
  if (value === "openai-chat" || value === "openai-responses" || value === "anthropic-messages" || value === "gemini") {
    return value;
  }
  throw new AtelierError("PROVIDER_PROTOCOL", "Unknown provider protocol.", value, "Use openai-chat, openai-responses, anthropic-messages or gemini.");
}
