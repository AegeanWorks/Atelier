import { hashRequest } from "./providers/http.js";
import type { DbHandle } from "./db.js";

export interface EffectRow {
  effect_key: string;
  run_id: string;
  tool: string;
  args_hash: string;
  status: "intent" | "applied" | "failed" | "unknown";
  pre_hash: string | null;
  post_hash: string | null;
  result: string | null;
  created: number;
  settled: number | null;
}

export function effectKey(runId: string, callId: string, tool: string, input: unknown, preHash: string | null): string {
  return hashRequest({ runId, callId, tool, input, preHash });
}

export function getEffect(handle: DbHandle, key: string): EffectRow | null {
  const row = handle.db
    .prepare("SELECT effect_key, run_id, tool, args_hash, status, pre_hash, post_hash, result, created, settled FROM effects WHERE effect_key = ?")
    .get(key) as EffectRow | undefined;
  return row ?? null;
}

export function beginEffect(
  handle: DbHandle,
  entry: { effectKey: string; runId: string; tool: string; argsHash: string; preHash: string | null },
): EffectRow {
  handle.db
    .prepare("INSERT OR IGNORE INTO effects (effect_key, run_id, tool, args_hash, status, pre_hash, created) VALUES (?, ?, ?, ?, 'intent', ?, ?)")
    .run(entry.effectKey, entry.runId, entry.tool, entry.argsHash, entry.preHash, Date.now());
  const row = getEffect(handle, entry.effectKey);
  if (row === null) throw new Error("effect intent was not stored");
  return row;
}

export function finishEffect(
  handle: DbHandle,
  key: string,
  status: "applied" | "failed" | "unknown",
  result: string,
  postHash: string | null,
): void {
  handle.db
    .prepare("UPDATE effects SET status = ?, result = ?, post_hash = ?, settled = ? WHERE effect_key = ?")
    .run(status, result, postHash, Date.now(), key);
}
