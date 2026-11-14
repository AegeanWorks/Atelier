import { AtelierError } from "../config.js";
import { getLlmMemo, putLlmMemo, type DbHandle } from "../db.js";
import type { Config, Secrets } from "../state.js";
import { adapterFor, findProvider, providerContext } from "./registry.js";
import { hashRequest } from "./http.js";
import type { ChatRequest, ProviderAdapter, StreamEvent } from "./types.js";

export interface RunResult {
  events: StreamEvent[];
  text: string;
  usage: { promptTokens: number; completionTokens: number; cachedTokens?: number | undefined } | null;
  providerId: string;
  requestHash: string;
  replayed: boolean;
  latencyMs: number;
}

function errorEvent(error: unknown): StreamEvent {
  if (error instanceof AtelierError) return { type: "error", message: error.message, code: error.code };
  return { type: "error", message: error instanceof Error ? error.message : String(error) };
}

export async function* streamProvider(
  config: Config,
  secrets: Secrets,
  providerId: string,
  request: ChatRequest,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
  adapter?: ProviderAdapter,
): AsyncGenerator<StreamEvent> {
  const provider = findProvider(config, providerId);
  try {
    yield* (adapter ?? adapterFor(provider.protocol)).stream(providerContext(provider, secrets, env), request, signal);
    return;
  } catch (error) {
    if (adapter !== undefined || provider.fallbackId === undefined || provider.fallbackId === providerId) throw error;
    const fallback = findProvider(config, provider.fallbackId);
    yield {
      type: "provider.failover",
      from: provider.id,
      to: fallback.id,
      reason: error instanceof Error ? error.message : String(error),
    };
    yield* adapterFor(fallback.protocol).stream(providerContext(fallback, secrets, env), request, signal);
  }
}

export function memoKey(providerId: string, request: ChatRequest): string {
  return hashRequest({ providerId, request });
}

export function replayMemo(handle: DbHandle, providerId: string, request: ChatRequest): RunResult | null {
  const requestHash = memoKey(providerId, request);
  const row = getLlmMemo(handle, requestHash);
  if (row === null) return null;
  const events = JSON.parse(row.response_json) as StreamEvent[];
  const usage = row.usage_json === null ? null : (JSON.parse(row.usage_json) as RunResult["usage"]);
  const text = events.filter((event) => event.type === "text-delta").map((event) => (event.type === "text-delta" ? event.text : "")).join("");
  return {
    events: [{ type: "memo.replay", requestHash }, ...events],
    text,
    usage,
    providerId: row.provider_id,
    requestHash,
    replayed: true,
    latencyMs: 0,
  };
}

export function saveMemo(handle: DbHandle, providerId: string, request: ChatRequest, events: StreamEvent[]): void {
  if (!events.some((event) => event.type === "finish")) return;
  const usage = [...events].reverse().find((event) => event.type === "usage") ?? null;
  putLlmMemo(handle, {
    requestHash: memoKey(providerId, request),
    providerId,
    model: request.model,
    request,
    events,
    usage,
  });
}

export async function collectProvider(
  handle: DbHandle,
  config: Config,
  secrets: Secrets,
  providerId: string,
  request: ChatRequest,
  signal: AbortSignal,
  options: { replay?: boolean; memo?: boolean; env?: NodeJS.ProcessEnv; adapter?: ProviderAdapter } = {},
): Promise<RunResult> {
  const started = performance.now();
  const memory = options.memo ?? options.adapter === undefined;
  if (options.replay !== false && memory) {
    const memo = replayMemo(handle, providerId, request);
    if (memo !== null) return { ...memo, latencyMs: Math.round(performance.now() - started) };
  }
  const events: StreamEvent[] = [];
  let activeProvider = providerId;
  try {
    for await (const event of streamProvider(config, secrets, providerId, request, signal, options.env, options.adapter)) {
      events.push(event);
      if (event.type === "provider.failover") activeProvider = event.to;
    }
  } catch (error) {
    events.push(errorEvent(error));
  }
  if (memory) saveMemo(handle, activeProvider, request, events);
  const text = events.filter((event) => event.type === "text-delta").map((event) => (event.type === "text-delta" ? event.text : "")).join("");
  const usage = [...events].reverse().find((event) => event.type === "usage");
  return {
    events,
    text,
    usage: usage === undefined || usage.type !== "usage" ? null : { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, cachedTokens: usage.cachedTokens },
    providerId: activeProvider,
    requestHash: memoKey(providerId, request),
    replayed: false,
    latencyMs: Math.round(performance.now() - started),
  };
}
