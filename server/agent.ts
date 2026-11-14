import type { DbHandle } from "./db.js";
import { appendMessage, createSession, listMessages } from "./db.js";
import { collectProvider } from "./providers/run.js";
import type { ChatMessage, ChatRequest, StreamEvent } from "./providers/types.js";
import { appendRunStep, appendSessionEvent, createRun, markRun, updateRunStep, type RunRow } from "./runs.js";
import { requestApproval } from "./approvals.js";
import { compactMessages, offloadToolOutput } from "./compaction.js";
import { runHooks, recordHookResults } from "./hooks.js";
import { evaluateRules } from "./rules.js";
import { scrubbedEnv } from "./shellEnv.js";
import { extractImages } from "./images.js";
import { visionProblem } from "./providers/vision.js";
import { McpHub } from "./mcp.js";
import { callMcpTool } from "./mcpEffects.js";
import type { Config, Secrets } from "./state.js";
import { executeTool, toolAction, toolSchemas, type ToolOutcome } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";
import { normalizeTodos, saveTodos, todoSummary } from "./todos.js";
import { previewForApproval } from "./editPreview.js";
import { priceStep } from "./usage.js";
import { DELEGATE_PROFILE, FULL_PROFILE } from "./eval/harness.js";
import type { HarnessProfile } from "./eval/types.js";
import type { ProviderAdapter } from "./providers/types.js";

export interface AgentOutcome {
  status: "finished" | "blocked";
  text: string;
  reason: string | null;
  requestHash: string | null;
  providerId: string;
}

export function toMessages(handle: DbHandle, sessionId: string, limit: number): ChatMessage[] {
  return listMessages(handle, sessionId)
    .slice(-limit)
    .map((message): ChatMessage => {
      if (message.role === "assistant") return { role: "assistant", content: message.text };
      const { text, images } = extractImages(handle.paths, message.text);
      return images.length === 0 ? { role: "user", content: text } : { role: "user", content: text, images };
    });
}


function writeTodos(handle: DbHandle, run: RunRow, input: unknown): ToolOutcome {
  const args = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  try {
    const todos = normalizeTodos(args.todos);
    saveTodos(handle, run.session_id, run.id, todos);
    return { ok: true, output: `Task list updated: ${todoSummary(todos)}`, effectKey: undefined };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error), effectKey: undefined };
  }
}

async function runDelegated(
  handle: DbHandle,
  config: Config,
  secrets: Secrets,
  run: RunRow,
  providerId: string,
  model: string,
  input: unknown,
  callId: string,
  signal: AbortSignal,
  options: { adapter?: ProviderAdapter },
): Promise<ToolOutcome> {
  const args = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const brief = String(args.brief ?? "").trim();
  if (brief.length === 0) return { ok: false, output: "delegate needs a non-empty brief.", effectKey: undefined };
  appendSessionEvent(handle, run.session_id, "access.decision", { runId: run.id, callId, tool: "delegate", action: "read", resource: brief.slice(0, 120), decision: "allow", reason: "read-only delegated brief" });
  const session = createSession(handle, `delegate:${brief.slice(0, 40)}`);
  const subRun = createRun(handle, session.id, run.id, null, run.workspace ?? process.cwd());
  handle.db.prepare("UPDATE runs SET profile_id = 'plan' WHERE id = ?").run(subRun.id);
  subRun.profile_id = "plan";
  appendMessage(handle, session.id, "user", brief, null);
  appendSessionEvent(handle, run.session_id, "delegate.started", { runId: run.id, subRunId: subRun.id, brief: brief.slice(0, 500) });
  const outcome = await runAgent(handle, config, secrets, subRun, providerId, model, signal, { profile: DELEGATE_PROFILE, ...(options.adapter === undefined ? {} : { adapter: options.adapter }) });
  markRun(handle, subRun.id, outcome.status === "finished" ? "finished" : "blocked", { finished: outcome.status === "finished", blockedReason: outcome.status === "finished" ? null : "delegate_blocked", error: outcome.reason });
  appendSessionEvent(handle, run.session_id, "delegate.finished", { runId: run.id, subRunId: subRun.id, ok: outcome.status === "finished", text: outcome.text.slice(0, 2000) });
  return { ok: outcome.status === "finished", output: outcome.text.length > 0 ? outcome.text : `delegate blocked: ${outcome.reason ?? "unknown"}`, effectKey: undefined };
}

export async function runAgent(
  handle: DbHandle,
  config: Config,
  secrets: Secrets,
  run: RunRow,
  providerId: string,
  model: string,
  signal: AbortSignal,
  options: { profile?: HarnessProfile; adapter?: ProviderAdapter; approve?: (call: { id: string; name: string; input: unknown }, resource: string, action: string) => boolean | Promise<boolean> } = {},
): Promise<AgentOutcome> {
  const profile = options.profile ?? FULL_PROFILE;
  const mode = run.profile_id === "plan" || profile.permissions === "plan-readonly" ? "plan" : "build";
  const workspace = run.workspace ?? process.cwd();
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(workspace) },
    ...toMessages(handle, run.session_id, profile.contextMessages),
  ];
  const providerConfig = config.providers.find((entry) => entry.id === providerId);
  const imageProblem = providerConfig === undefined ? null : visionProblem(providerConfig, model, messages);
  if (imageProblem !== null) return { status: "blocked", text: "", reason: imageProblem, requestHash: null, providerId };
  const mcp = profile.toolNames.includes("mcp") ? await McpHub.open(config.mcpServers ?? [], scrubbedEnv(process.env, { providers: config.providers, passthrough: config.shellEnvPassthrough })) : new McpHub([], []);
  const tools = [...toolSchemas(profile.toolNames), ...mcp.schemas()];
  let lastSignature = "";
  let repeats = 0;
  let lastHash: string | null = null;
  let lastProvider = providerId;
  let lastCompaction = "";

  try {
  for (let stepIndex = 0; stepIndex < profile.maxSteps; stepIndex += 1) {
    const step = appendRunStep(handle, run.id, "llm_request", "running", { providerId, model, step: stepIndex }, null);
    const system = messages[0]?.role === "system" ? messages[0] : null;
    const conversation = system === null ? messages : messages.slice(1);
    const compacted = profile.compaction === "summary"
      ? compactMessages(conversation, profile.contextTokens)
      : { messages: conversation, stats: { beforeTokens: 0, afterTokens: 0, droppedMessages: 0, summaryTokens: 0 } };
    const context = { messages: system === null ? compacted.messages : [system, ...compacted.messages], stats: compacted.stats };
    if (context.stats.droppedMessages > 0) {
      const signature = `${context.stats.beforeTokens}:${context.stats.afterTokens}:${context.stats.droppedMessages}`;
      if (signature !== lastCompaction) {
        lastCompaction = signature;
        appendSessionEvent(handle, run.session_id, "context.compacted", { runId: run.id, step: stepIndex, ...context.stats });
      }
    }
    const request: ChatRequest = { model, messages: context.messages, tools };
    const result = await collectProvider(handle, config, secrets, providerId, request, signal, options.adapter === undefined ? {} : { adapter: options.adapter });
    lastHash = result.requestHash;
    lastProvider = result.providerId;
    if (result.usage !== null || result.replayed) {
      const usage = result.usage ?? { promptTokens: 0, completionTokens: 0 };
      const price = priceStep(config, result.providerId, model, usage, result.replayed);
      appendSessionEvent(handle, run.session_id, "llm.usage", {
        runId: run.id,
        step: stepIndex,
        providerId: result.providerId,
        model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,  // aikit:allow-secret[high-entropy-value] -- token usage counter, not a credential
        cachedTokens: usage.cachedTokens ?? 0,
        costUsd: price.costUsd,
        priced: price.priced,
        replayed: result.replayed,
        latencyMs: result.latencyMs,
      });
    }
    const finish = result.events.some((event) => event.type === "finish");
    const error = result.events.find((event) => event.type === "error");
    updateRunStep(handle, step.id, error === undefined ? "done" : "failed", result.requestHash);
    if (error !== undefined) {
      return { status: "blocked", text: "", reason: error.type === "error" ? error.message : "provider error", requestHash: lastHash, providerId: lastProvider };
    }
    const calls = result.events.filter((event): event is Extract<StreamEvent, { type: "tool-call" }> => event.type === "tool-call");
    if (calls.length === 0) {
      if (!finish) return { status: "blocked", text: "", reason: "provider returned no finish event", requestHash: lastHash, providerId: lastProvider };
      if (result.text.length === 0) return { status: "blocked", text: "", reason: "provider returned empty text", requestHash: lastHash, providerId: lastProvider };
      return { status: "finished", text: result.text, reason: null, requestHash: lastHash, providerId: lastProvider };
    }
    messages.push({
      role: "assistant",
      content: result.text,
      toolCalls: calls.map((call) => ({ id: call.id, name: call.name, input: call.input })),
    });
    for (const call of calls) {
      const signature = `${call.name}:${JSON.stringify(call.input)}`;
      repeats = signature === lastSignature ? repeats + 1 : 0;
      lastSignature = signature;
      if (repeats >= profile.doomLoopLimit - 1) {
        return { status: "blocked", text: "", reason: "doom loop: identical tool call repeated", requestHash: lastHash, providerId: lastProvider };
      }
      const enabled = new Set(profile.toolNames);
      const callInput = typeof call.input === "object" && call.input !== null ? call.input as Record<string, unknown> : {};
      const mcpAllowed = enabled.has("mcp") && call.name.startsWith("mcp__") && mcp.has(call.name);
      const allowed = enabled.has(call.name) || mcpAllowed;
      const resource = call.name === "bash" ? String(callInput.command ?? "") : mcpAllowed ? `${call.name} ${JSON.stringify(callInput).slice(0, 200)}` : String(callInput.path ?? call.name);
      const action = toolAction(call.name);
      const needsApproval = action === "edit" || action === "exec";
      const approvalNeeded = allowed && mode === "build" && (needsApproval || mcpAllowed);
      let hookVeto: string | null = null;
      const hookList = config.hooks ?? [];
      const hookCall = { tool: call.name, input: call.input, runId: run.id, sessionId: run.session_id, callId: call.id };
      if (allowed && hookList.length > 0) {
        const pre = await runHooks(workspace, hookList, "pre_tool", hookCall);
        recordHookResults(handle, hookCall, pre.results);
        if (pre.blocked) {
          hookVeto = `Blocked by hook ${pre.hookId}: ${pre.reason}`;
          appendSessionEvent(handle, run.session_id, "access.decision", { runId: run.id, callId: call.id, tool: call.name, action: action ?? "edit", resource, decision: "deny", reason: `hook ${pre.hookId} vetoed this call` });
        }
      }
      let ruleDeny: string | null = null;
      let ruleAllowed = false;
      if (approvalNeeded && hookVeto === null && !mcpAllowed && (action === "exec" || action === "edit")) {
        const verdict = evaluateRules(config.rules ?? [], action, resource);
        if (verdict.decision === "deny") {
          ruleDeny = `Denied by permission rule ${verdict.ruleId}.`;
          appendSessionEvent(handle, run.session_id, "access.decision", { runId: run.id, callId: call.id, tool: call.name, action, resource, decision: "deny", reason: `denied by rule ${verdict.ruleId}` });
        } else if (verdict.decision === "allow") {
          ruleAllowed = true;
          appendSessionEvent(handle, run.session_id, "access.decision", { runId: run.id, callId: call.id, tool: call.name, action, resource, decision: "allow", reason: `allowed by rule ${verdict.ruleId}` });
        }
      }
      let denied = false;
      if (approvalNeeded && hookVeto === null && ruleDeny === null && !ruleAllowed) {
        let reason = `${call.name} requires approval in build mode`;
        let allowed: boolean;
        if (options.approve !== undefined) {
          allowed = await options.approve({ id: call.id, name: call.name, input: call.input }, resource, action ?? "edit");
        } else {
          const preview = action === "edit" ? previewForApproval(workspace, call.name, call.input) : null;
          const decision = await requestApproval(handle, run, call, action ?? "edit", resource, reason, signal, undefined, preview === null || preview.diff.length === 0 ? null : preview.diff);
          allowed = decision.verdict === "allow";
          if (!allowed) reason = decision.reason;
        }
        if (!allowed) {
          denied = true;
          appendSessionEvent(handle, run.session_id, "access.decision", {
            runId: run.id,
            callId: call.id,
            tool: call.name,
            action: action ?? "edit",
            resource,
            decision: "deny",
            reason: `approval denied: ${reason}`,
          });
        }
      }
      if (!denied && mcpAllowed) {
        appendSessionEvent(handle, run.session_id, "access.decision", { runId: run.id, callId: call.id, tool: call.name, action: "exec", resource, decision: "allow", reason: "namespaced MCP tool" });
      }
      const outcome = hookVeto !== null
        ? { ok: false, output: hookVeto, effectKey: undefined }
        : ruleDeny !== null
        ? { ok: false, output: ruleDeny, effectKey: undefined }
        : denied
        ? { ok: false, output: `Tool ${call.name} was denied by approval.`, effectKey: undefined }
        : !allowed
        ? (() => {
            const input = typeof call.input === "object" && call.input !== null ? call.input as Record<string, unknown> : {};
            appendSessionEvent(handle, run.session_id, "access.decision", {
              runId: run.id,
              callId: call.id,
              tool: call.name,
              action: action ?? "read",
              resource: String(input.path ?? input.command ?? call.name),
              decision: "deny",
              reason: `disabled by harness profile ${profile.id}`,
            });
            return { ok: false, output: `Tool ${call.name} is disabled by harness profile ${profile.id}.`, effectKey: undefined };
          })()
        : call.name === "todo_write"
          ? writeTodos(handle, run, call.input)
          : call.name === "delegate"
            ? await runDelegated(handle, config, secrets, run, providerId, model, call.input, call.id, signal, options)
            : mcpAllowed
              ? await callMcpTool(handle, run, mcp, call)
              : await executeTool(handle, run, mode, { id: call.id, name: call.name, input: call.input });
      if (allowed && hookVeto === null && hookList.length > 0) {
        const post = await runHooks(workspace, hookList, "post_tool", { ...hookCall, outcome: { ok: outcome.ok, output: outcome.output } });
        recordHookResults(handle, { ...hookCall, outcome: { ok: outcome.ok, output: outcome.output } }, post.results);
      }
      const toolStep = appendRunStep(handle, run.id, "tool", outcome.ok ? "done" : "failed", { name: call.name, input: call.input }, outcome.effectKey ?? null);
      appendSessionEvent(handle, run.session_id, "tool.result", {
        runId: run.id,
        callId: call.id,
        name: call.name,
        ok: outcome.ok,
        detail: resource.slice(0, 300),
        output: outcome.output.slice(0, 4000),
        step: toolStep.seq,
      });
      const bounded = offloadToolOutput(handle, run, call.id, outcome.output);
      if (bounded.path !== null) {
        appendSessionEvent(handle, run.session_id, "artifact.offloaded", { runId: run.id, callId: call.id, name: call.name, path: bounded.path, bytes: outcome.output.length });
      }
      messages.push({ role: "tool", content: bounded.content, toolCallId: call.id, name: call.name });
    }
  }
  return { status: "blocked", text: "", reason: "step cap reached", requestHash: lastHash, providerId: lastProvider };
  } finally {
    mcp.close();
  }
}
