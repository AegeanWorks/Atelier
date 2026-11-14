import { createHash } from "node:crypto";
import { AtelierError } from "../config.js";

export interface RetryOptions {
  timeoutMs?: number;
  stallMs?: number;
  retries?: number;
  signal?: AbortSignal;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function hashRequest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function backoffMs(attempt: number): number {
  const base = Math.min(2000, 200 * 2 ** attempt);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onAbort = (): void => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const combined = combineSignals(options.signal, timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: combined.signal });
      combined.cancel();
      if (response.status === 429 || response.status === 529 || response.status >= 500) {
        if (attempt < retries) {
          await delay(backoffMs(attempt));
          continue;
        }
      }
      return response;
    } catch (error) {
      combined.cancel();
      lastError = error;
      if (attempt >= retries) break;
      await delay(backoffMs(attempt));
    }
  }
  throw new AtelierError(
    "PROVIDER_UNREACHABLE",
    "Provider request failed after retries.",
    lastError instanceof Error ? lastError.message : String(lastError),
    "Check the provider URL and network, then retry.",
  );
}

export async function responseError(response: Response): Promise<AtelierError> {
  const text = await response.text().catch(() => "");
  return new AtelierError(
    `PROVIDER_HTTP_${response.status}`,
    `Provider returned HTTP ${response.status}.`,
    text.slice(0, 400) || response.statusText,
    response.status === 401 || response.status === 403
      ? "Check the provider key; keys are read from the environment or the 0600 secrets store."
      : "Retry, or switch to another provider in Settings.",
  );
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function withHeaders(context: { headers?: Record<string, string> }, extra: Record<string, string>): Record<string, string> {
  return { ...context.headers, ...extra };
}
