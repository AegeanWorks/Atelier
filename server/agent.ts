import type { DbHandle } from "./db.js";
import { appendMessage, createSession, listEvents, listMessages } from "./db.js";
import { collectProvider } from "./providers/run.js";
import type { ChatMessage, ChatRequest, StreamEvent } from "./providers/types.js";
import { appendRunStep, appendSessionEvent, createRun, markRun, updateRunStep, type RunRow } from "./runs.js";
import { requestApproval } from "./approvals.js";
import { compactMessages, droppedWindow, offloadToolOutput } from "./compaction.js";
import { runHooks, recordHookResults } from "./hooks.js";
import { publishLive } from "./liveStream.js";
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
import { budgetForModel, findModel } from "./providers/catalog.js";
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
  // The agent is the one reader that needs the tool turns: a resumed run has to see what its
  // tools already did, or it re-does the work blind.
  return listMessages(handle, sessionId, { includeTools: true })
    .slice(-limit)
    .map((message): ChatMessage => {
      if (message.role === "tool") {
        // A tool result keeps its call id, so the provider can pair it with the request.
        return { role: "tool", content: message.text, ...(message.tool_call_id === null ? {} : { toolCallId: message.tool_call_id }) };
      }
      const { text, images } = extractImages(handle.paths, message.text);
      if (message.role === "assistant") {
        const calls = message.tool_calls === null ? null : (JSON.parse(message.tool_calls) as ChatMessage["toolCalls"]);
        return {
          role: "assistant",
          content: text,
          ...(calls === null || calls === undefined || calls.length === 0 ? {} : { toolCalls: calls }),
        };
      }
      return images.length === 0 ? { role: "user", content: text } : { role: "user", content: text, images };
    });
}


/**
 * Large tool outputs this run offloaded to disk, newest last. They stay readable, so a
 * compacted head names them instead of losing the fact that the output can be re-read.
 */
function listArtifacts(handle: DbHandle, sessionId: string, runId: string): string[] {
  return listEvents(handle, sessionId)
    .filter((event) => event.type === "artifact.offloaded")
    .flatMap((event) => {
      try {
        const data = JSON.parse(event.data) as { path?: unknown; runId?: unknown };
        if (data.runId !== runId) return [];
        return typeof data.path === "string" ? [data.path] : [];
      } catch {
        return [];
      }
    });
}

/** Compaction is worth a model call only when the window is genuinely over budget. */
function compactionWorthSummarising(messages: ChatMessage[], budget: number): boolean {
  return droppedWindow(messages, budget).length > 0;
}

/**
 * Summarise the window compaction is about to drop, with the same model the run is using.
 *
 * Returns null on any failure: an unsummarisable window degrades to the mechanical summary
 * rather than blocking the run, and a fixture adapter is skipped entirely so eval rungs keep
 * their fixed response sequence.
 */
async function summariseWindow(
  handle: DbHandle,
  config: Config,
  secrets: Secrets,
  providerId: string,
  model: string,
  messages: ChatMessage[],
  budget: number,
  signal: AbortSignal,
  adapter: ProviderAdapter | undefined,
): Promise<string | null> {
  if (adapter !== undefined) return null;
  const dropped = droppedWindow(messages, budget);
  if (dropped.length === 0) return null;
  const body = dropped
    .map((message) => `${message.name ?? message.role}: ${message.content.replace(/\s+/g, " ").trim().slice(0, 600)}`)
    .join("\n")
    .slice(-24_000);
  try {
    const result = await collectProvider(handle, config, secrets, providerId, {
      model,
      messages: [
        { role: "system", content: "Summarise the conversation below for an agent that must keep working. Keep names, paths, decisions, numbers and open tasks. Be terse; no preamble." },
        { role: "user", content: body },
      ],
      maxTokens: 900,
    }, AbortSignal.any([signal, AbortSignal.timeout(30_000)]), { memo: false });
    if (result.events.some((event) => event.type === "error")) return null;
    const text = result.text.trim();
    return text.length === 0 ? null : text;
  } catch {
    return null;
  }
}

/**
 * Persist one tool result so a later run on the same conversation can see what was done.
 *
 * This writes the message projection only. It deliberately emits no `text.ended` event: the
 * durable record of a tool call is the `tool.result` event, and a second prose event per call
 * would make the transcript show tool output as if the assistant had written it.
 */
function recordToolTurn(handle: DbHandle, sessionId: string, callId: string, name: string, output: string): void {
  try {
    appendMessage(handle, sessionId, "tool", output, `${callId}:${name}`.slice(0, 100), { toolCallId: callId });
  } catch {
    // History is an optimisation for the next run; losing it must never fail this one.
  }
}

/** How many times one model step may be attempted before the run gives up. */
const STEP_ATTEMPTS = 3;

/** Errors worth another attempt: the provider or the network was briefly unavailable. */
export function isTransient(message: string): boolean {
  return /rate.?limit|\b429\b|\b5\d\d\b|overloaded|temporar|timeout|timed out|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(message);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * One model step, retried on a transient provider or network failure.
 *
 * The provider layer already retries the HTTP call; this heals the case that reaches the loop as
 * an `error` event, which used to block the whole run. A non-transient error, an exhausted
 * retry budget or an abort still returns the failing result so the loop can end honestly.
 */
async function collectStep(
  handle: DbHandle,
  sessionId: string,
  config: Config,
  secrets: Secrets,
  providerId: string,
  request: ChatRequest,
  signal: AbortSignal,
  options: { adapter?: ProviderAdapter; onEvent?: (event: StreamEvent) => void },
): Promise<Awaited<ReturnType<typeof collectProvider>>> {
  let last: Awaited<ReturnType<typeof collectProvider>> | null = null;
  for (let attempt = 0; attempt < STEP_ATTEMPTS; attempt += 1) {
    if (signal.aborted) break;
    last = await collectProvider(handle, config, secrets, providerId, request, signal, options);
    const failure = last.events.find((event) => event.type === "error");
    if (failure === undefined || failure.type !== "error") return last;
    // A replayed or adapter-backed step is deterministic: retrying it just repeats the failure.
    if (options.adapter !== undefined || last.replayed || !isTransient(failure.message)) return last;
    if (attempt === STEP_ATTEMPTS - 1) return last;
    appendSessionEvent(handle, sessionId, "provider.retry", { attempt: attempt + 1, reason: failure.message.slice(0, 200) });
    // Jittered exponential backoff, so several runs do not retry in lockstep.
    await abortableDelay(200 * 2 ** attempt + Math.floor(Math.random() * 100), signal);
  }
  return last ?? collectProvider(handle, config, secrets, providerId, request, signal, options);
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
  options: { profile?: HarnessProfile; maxBudgetUsd?: number; adapter?: ProviderAdapter; approve?: (call: { id: string; name: string; input: unknown }, resource: string, action: string, explicitAsk: boolean) => boolean | Promise<boolean> } = {},
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
  // A model's declared output ceiling, when the catalog knows it; readers of `maxTokens` then
  // size the answer instead of falling back to whatever the provider defaults to.
  const outputLimit = providerConfig === undefined ? null : findModel(providerConfig, model)?.maxOutput ?? null;
  let lastSignature = "";
  let repeats = 0;
  let lastHash: string | null = null;
  let lastProvider = providerId;
  let lastCompaction = "";

  try {
  let spentUsd = 0;
  let unpriced = false;
  for (let stepIndex = 0; stepIndex < profile.maxSteps; stepIndex += 1) {
    const step = appendRunStep(handle, run.id, "llm_request", "running", { providerId, model, step: stepIndex }, null);
    const system = messages[0]?.role === "system" ? messages[0] : null;
    const conversation = system === null ? messages : messages.slice(1);
    // A profile may pin a budget (evals do, for comparability); a live run derives it from
    // the model's own window, so a 200k model is not compacted at a 24k constant.
    const contextBudget = profile.contextTokens ?? budgetForModel(
      config.providers.find((entry) => entry.id === providerId) ?? { id: providerId, name: providerId, protocol: "openai-chat", baseUrl: "" },
      model,
    );
    // Offloaded tool outputs stay readable on disk; name them in the compacted head so a
    // dropped message does not take with it the fact that the output can be read again.
    const artifacts = listArtifacts(handle, run.session_id, run.id);
    let modelSummary: string | null = null;
    if (profile.compaction === "summary" && compactionWorthSummarising(conversation, contextBudget)) {
      modelSummary = await summariseWindow(handle, config, secrets, providerId, model, conversation, contextBudget, signal, options.adapter);
    }
    const compacted = profile.compaction === "summary"
      ? compactMessages(conversation, contextBudget, { modelSummary, artifacts })
      : { messages: conversation, stats: { beforeTokens: 0, afterTokens: 0, droppedMessages: 0, summaryTokens: 0 } };
    const context = { messages: system === null ? compacted.messages : [system, ...compacted.messages], stats: compacted.stats };
    if (context.stats.droppedMessages > 0) {
      const signature = `${context.stats.beforeTokens}:${context.stats.afterTokens}:${context.stats.droppedMessages}`;
      if (signature !== lastCompaction) {
        lastCompaction = signature;
        appendSessionEvent(handle, run.session_id, "context.compacted", { runId: run.id, step: stepIndex, ...context.stats });
      }
    }
    const request: ChatRequest = {
      model,
      messages: context.messages,
      tools,
      // The model's own output ceiling when the catalog knows it; otherwise the provider default.
      ...(outputLimit === null ? {} : { maxTokens: outputLimit }),
    };
    const result = await collectStep(handle, run.session_id, config, secrets, providerId, request, signal, {
      ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
      onEvent: (event) => {
        if (event.type === "text-delta") publishLive(run.session_id, { type: "text.delta", runId: run.id, step: stepIndex, text: event.text });
      },
    });
    lastHash = result.requestHash;
    lastProvider = result.providerId;
    if (result.usage !== null || result.replayed) {
      const usage = result.usage ?? { promptTokens: 0, completionTokens: 0 };
      const price = priceStep(config, result.providerId, model, usage, result.replayed);
      spentUsd += price.costUsd;
      if (!price.priced) unpriced = true;
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
    // A final answer is never thrown away for its cost; the budget only stops a run that wants to keep going.
    if (options.maxBudgetUsd !== undefined) {
      if (unpriced) return { status: "blocked", text: "", reason: "budget unpriced", requestHash: lastHash, providerId: lastProvider };
      if (spentUsd >= options.maxBudgetUsd) return { status: "blocked", text: "", reason: "budget reached", requestHash: lastHash, providerId: lastProvider };
    }
    const requested = calls.map((call) => ({ id: call.id, name: call.name, input: call.input }));
    messages.push({ role: "assistant", content: result.text, toolCalls: requested });
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
      let askedBy: string | null = null;
      if (approvalNeeded && hookVeto === null && !mcpAllowed && (action === "exec" || action === "edit")) {
        const verdict = evaluateRules(config.rules ?? [], action, resource);
        if (verdict.decision === "deny") {
          ruleDeny = `Denied by permission rule ${verdict.ruleId}.`;
          appendSessionEvent(handle, run.session_id, "access.decision", { runId: run.id, callId: call.id, tool: call.name, action, resource, decision: "deny", reason: `denied by rule ${verdict.ruleId}` });
        } else if (verdict.decision === "ask" && verdict.ruleId !== null) {
          askedBy = verdict.ruleId;
        } else if (verdict.decision === "allow") {
          ruleAllowed = true;
          appendSessionEvent(handle, run.session_id, "access.decision", { runId: run.id, callId: call.id, tool: call.name, action, resource, decision: "allow", reason: `allowed by rule ${verdict.ruleId}` });
        }
      }
      let denied = false;
      if (approvalNeeded && hookVeto === null && ruleDeny === null && !ruleAllowed) {
        let reason = askedBy === null ? `${call.name} requires approval in build mode` : `permission rule ${askedBy} asks before ${call.name} runs`;
        let allowed: boolean;
        if (options.approve !== undefined) {
          allowed = await options.approve({ id: call.id, name: call.name, input: call.input }, resource, action ?? "edit", askedBy !== null);
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
      recordToolTurn(handle, run.session_id, call.id, call.name, bounded.content);
    }
  }
  return { status: "blocked", text: "", reason: "step cap reached", requestHash: lastHash, providerId: lastProvider };
  } finally {
    mcp.close();
  }
}
