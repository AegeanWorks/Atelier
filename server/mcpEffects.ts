import type { DbHandle } from "./db.js";
import { beginEffect, effectKey, finishEffect } from "./effects.js";
import type { McpHub } from "./mcp.js";
import { hashRequest } from "./providers/http.js";
import type { RunRow } from "./runs.js";

export interface McpToolOutcome {
  ok: boolean;
  output: string;
  effectKey?: string | undefined;
}

export async function callMcpTool(
  handle: DbHandle,
  run: RunRow,
  hub: McpHub,
  call: { id: string; name: string; input: unknown },
): Promise<McpToolOutcome> {
  const key = effectKey(run.id, call.id, call.name, call.input, null);
  const existing = beginEffect(handle, {
    effectKey: key,
    runId: run.id,
    tool: call.name,
    argsHash: hashRequest(call.input),
    preHash: null,
  });
  if (existing.status === "applied" && existing.result !== null) {
    return { ok: true, output: existing.result, effectKey: key };
  }
  const result = await hub.call(call.name, call.input);
  finishEffect(handle, key, result.ok ? "applied" : "failed", result.output, null);
  return { ok: result.ok, output: result.output, effectKey: key };
}
