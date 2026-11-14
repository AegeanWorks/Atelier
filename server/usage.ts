import type { DbHandle } from "./db.js";
import { findModel } from "./providers/catalog.js";
import type { ProviderConfig } from "./providers/types.js";
import type { Config } from "./state.js";

const PER_MILLION = 1_000_000;

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number | undefined;
}

export interface UsagePrice {
  costUsd: number;
  priced: boolean;
}

export interface UsageModelTotal {
  providerId: string;
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface UsageSummary {
  sessionId: string | null;
  requests: number;
  replays: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
  unpricedRequests: number;
  invalidEvents: number;
  byModel: UsageModelTotal[];
  /** The latest billed request: its prompt size is how much context the conversation uses right now. */
  last: { providerId: string; model: string; promptTokens: number } | null;
  /** Sub-agent requests already included in the totals above, so spend is not hidden. */
  delegated: { requests: number; costUsd: number };
}

export interface ContextUse {
  providerId: string;
  model: string;
  usedTokens: number;
  windowTokens: number | null;
}

export function priceUsage(provider: ProviderConfig, model: string, usage: TokenUsage): UsagePrice {
  const pricing = findModel(provider, model)?.pricing;
  if (pricing === undefined) return { costUsd: 0, priced: false };
  return {
    costUsd: (usage.promptTokens * pricing.input + usage.completionTokens * pricing.output) / PER_MILLION,
    priced: true,
  };
}

export function priceStep(config: Config, providerId: string, model: string, usage: TokenUsage, replayed: boolean): UsagePrice {
  if (replayed) return { costUsd: 0, priced: true };
  const provider = config.providers.find((entry) => entry.id === providerId);
  return provider === undefined ? { costUsd: 0, priced: false } : priceUsage(provider, model, usage);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

interface UsageEvent {
  providerId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
  priced: boolean;
  replayed: boolean;
}

function parseEvent(data: string): UsageEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.providerId !== "string" || typeof record.model !== "string") return null;
  return {
    providerId: record.providerId,
    model: record.model,
    promptTokens: count(record.promptTokens),
    completionTokens: count(record.completionTokens),
    cachedTokens: count(record.cachedTokens),
    costUsd: count(record.costUsd),
    priced: record.priced === true,
    replayed: record.replayed === true,
  };
}

/** `delegated` holds the events of sub-agent sessions: they add to the totals but never to the conversation's own `last`. */
export function summarizeUsage(sessionId: string | null, data: string[], delegated: string[] = []): UsageSummary {
  const summary: UsageSummary = {
    sessionId,
    requests: 0,
    replays: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    unpricedRequests: 0,
    invalidEvents: 0,
    byModel: [],
    last: null,
    delegated: { requests: 0, costUsd: 0 },
  };
  const models = new Map<string, UsageModelTotal>();
  const sources = [...data.map((raw) => ({ raw, child: false })), ...delegated.map((raw) => ({ raw, child: true }))];
  for (const { raw, child } of sources) {
    const event = parseEvent(raw);
    if (event === null) {
      summary.invalidEvents += 1;
      continue;
    }
    if (event.replayed) {
      summary.replays += 1;
      continue;
    }
    summary.requests += 1;
    if (child) {
      summary.delegated.requests += 1;
      summary.delegated.costUsd += event.costUsd;
    } else {
      summary.last = { providerId: event.providerId, model: event.model, promptTokens: event.promptTokens };
    }
    summary.promptTokens += event.promptTokens;
    summary.completionTokens += event.completionTokens;
    summary.cachedTokens += event.cachedTokens;
    summary.costUsd += event.costUsd;
    if (!event.priced) summary.unpricedRequests += 1;
    const key = `${event.providerId}\u0000${event.model}`;  // aikit:allow-secret[high-entropy-value] -- map key built from ids, not a credential
    const total = models.get(key) ?? { providerId: event.providerId, model: event.model, requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
    total.requests += 1;
    total.promptTokens += event.promptTokens;
    total.completionTokens += event.completionTokens;
    total.costUsd += event.costUsd;
    models.set(key, total);
  }
  summary.byModel = [...models.values()].sort((left, right) => right.costUsd - left.costUsd);
  return summary;
}

/** How full the context window is: the last request's prompt size against the model's window, when it is known. */
export function contextOf(summary: UsageSummary, config: Config): ContextUse | null {
  if (summary.last === null) return null;
  const provider = config.providers.find((entry) => entry.id === summary.last?.providerId);
  const window = provider === undefined ? undefined : findModel(provider, summary.last.model)?.contextWindow;
  return {
    providerId: summary.last.providerId,
    model: summary.last.model,
    usedTokens: summary.last.promptTokens,
    windowTokens: window === undefined ? null : window,
  };
}

export function readUsage(handle: DbHandle, sessionId: string | null): UsageSummary {
  const rows = sessionId === null
    ? handle.db.prepare("SELECT data FROM events WHERE type = 'llm.usage' ORDER BY created ASC, rowid ASC").all()
    : handle.db.prepare("SELECT data FROM events WHERE type = 'llm.usage' AND session_id = ? ORDER BY seq ASC").all(sessionId);
  // The all-conversations view already contains every delegate's events, so only a single conversation adds them.
  const children = sessionId === null
    ? []
    : handle.db
        .prepare(
          "SELECT data FROM events WHERE type = 'llm.usage' AND session_id IN (SELECT DISTINCT session_id FROM runs WHERE parent_run_id IN (SELECT id FROM runs WHERE session_id = ?) AND session_id != ?) ORDER BY created ASC, rowid ASC",
        )
        .all(sessionId, sessionId);
  return summarizeUsage(sessionId, (rows as Array<{ data: string }>).map((row) => row.data), (children as Array<{ data: string }>).map((row) => row.data));
}
