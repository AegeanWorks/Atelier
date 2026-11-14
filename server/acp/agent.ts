import { statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { alwaysAllowRule } from "../../src/rules.js";
import { attachMentionedFiles } from "../attachments.js";
import { AtelierError } from "../config.js";
import { createSession, getSession, listEvents, type DbHandle } from "../db.js";
import { attachImages, saveImage } from "../images.js";
import { subscribeLive } from "../liveStream.js";
import { resolveApproval } from "../approvals.js";
import { isProtectedConfigPath } from "../rules.js";
import { startSessionRun, stopSessionRun, whenRunsSettled } from "../runner.js";
import { loadConfig, saveConfig } from "../state.js";
import { blockMessage, convertPrompt, stopReasonFor, toolKind, toolTitle, type StopReason } from "./mapping.js";
import { JsonRpcPeer, RPC_CODES, RpcError } from "./rpc.js";

export interface AcpDeps {
  db: DbHandle;
  version: string;
  /** How often a running turn looks for new run events. */
  pollMs?: number;
  /** Starts a run for a prompt. The default stores the message and executes through the normal runner. */
  startRun?: (sessionId: string, prompt: string, workspace: string, mode: "plan" | "build") => void;
}

interface SessionState {
  workspace: string;
  running: boolean;
  cancel: (() => void) | null;
}

interface RunEvent {
  seq: number;
  type: string;
  data: string;
}

type Outcome = { outcome: string; optionId?: string };

const PROTOCOL_VERSION = 1;

function field(params: unknown, name: string): unknown {
  return typeof params === "object" && params !== null ? (params as Record<string, unknown>)[name] : undefined;
}

function textOf(output: string): unknown[] {
  return output.length === 0 ? [] : [{ type: "content", content: { type: "text", text: output } }];
}

/**
 * The agent side of the Agent Client Protocol for atelier: it maps one ACP session onto one conversation and one
 * turn onto one run. Text is streamed from the live channel, tool activity and approvals are read from the durable
 * run events, and permission questions go to the client instead of the browser. Returns when the connection closes.
 */
export function serveAcp(input: Readable, output: Writable, deps: AcpDeps): Promise<void> {
  const { db } = deps;
  const pollMs = deps.pollMs ?? 100;
  const sessions = new Map<string, SessionState>();
  let initialized = false;
  let peer: JsonRpcPeer;

  const startRun =
    deps.startRun ??
    ((sessionId: string, prompt: string, workspace: string, mode: "plan" | "build"): void => {
      try {
        startSessionRun(db, sessionId, prompt, null, workspace, mode);
      } catch (error) {
        if (error instanceof AtelierError && error.code === "RUN_ACTIVE") throw new RpcError(RPC_CODES.invalidRequest, "A turn is already running for this session.");
        throw error;
      }
    });

  const update = (sessionId: string, body: Record<string, unknown>): void => peer.notify("session/update", { sessionId, update: body });

  function initialize(params: unknown): unknown {
    if (typeof params !== "object" || params === null) throw new RpcError(RPC_CODES.invalidParams, "initialize needs an object.");
    initialized = true;
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: true, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
      agentInfo: { name: "atelier", title: "Atelier", version: deps.version },
      authMethods: [],
    };
  }

  function newSession(params: unknown): unknown {
    const cwd = field(params, "cwd");
    if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new RpcError(RPC_CODES.invalidParams, "cwd must be an absolute path.");
    let isDirectory = false;
    try {
      isDirectory = statSync(cwd).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) throw new RpcError(RPC_CODES.invalidParams, "cwd must be an existing directory.");
    const session = createSession(db, `ACP: ${basename(cwd)}`.slice(0, 80));
    sessions.set(session.id, { workspace: cwd, running: false, cancel: null });
    return { sessionId: session.id };
  }

  function sessionFor(params: unknown): { id: string; state: SessionState } {
    const id = field(params, "sessionId");
    if (typeof id !== "string") throw new RpcError(RPC_CODES.invalidParams, "sessionId is required.");
    const state = sessions.get(id);
    if (state === undefined || getSession(db, id) === null) throw new RpcError(RPC_CODES.notFound, "Session not found.", { sessionId: id });
    return { id, state };
  }

  async function prompt(params: unknown): Promise<unknown> {
    const { id, state } = sessionFor(params);
    if (state.running) throw new RpcError(RPC_CODES.invalidRequest, "A turn is already running for this session.");
    const converted = convertPrompt(field(params, "prompt"), state.workspace);
    let ids: string[];
    try {
      ids = converted.images.map((image) => saveImage(db.paths, image.mediaType, image.data));
    } catch (error) {
      throw new RpcError(RPC_CODES.invalidParams, error instanceof AtelierError ? error.message : "An image could not be read.");
    }
    const text = attachImages(db.paths, attachMentionedFiles(state.workspace, converted.text), ids);
    return { stopReason: await runTurn(id, state, text) };
  }

  function latestSeq(sessionId: string): number {
    const row = db.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?").get(sessionId) as { seq: number };
    return row.seq;
  }

  async function runTurn(sessionId: string, state: SessionState, text: string): Promise<StopReason> {
    let cancelNow: () => void = () => undefined;
    const cancelled = new Promise<Outcome>((resolve) => {
      cancelNow = () => resolve({ outcome: "cancelled" });
    });
    state.running = true;
    state.cancel = cancelNow;
    let lastSeq = latestSeq(sessionId);
    let streamed = false;
    const announced = new Set<string>();
    const off = subscribeLive(sessionId, (event) => {
      streamed = true;
      update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: `${event.runId}:${event.step}`, content: { type: "text", text: event.text } });
    });

    const askClient = async (event: Record<string, unknown>): Promise<void> => {
      const approvalId = String(event.approvalId);
      const callId = String(event.callId);
      const tool = String(event.tool);
      const action = String(event.action);
      const resource = String(event.resource);
      const reason = String(event.reason ?? "");
      const preview = typeof event.preview === "string" && event.preview.length > 0 ? event.preview : null;
      const title = toolTitle(tool, resource);
      const kind = toolKind(tool);
      announced.add(callId);
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: callId, title, kind, status: "pending", content: preview === null ? [] : textOf(`\`\`\`diff\n${preview}\n\`\`\``) });
      const config = loadConfig(db.paths);
      const always = isProtectedConfigPath(resource) || reason.startsWith("permission rule") ? null : alwaysAllowRule({ action, resource }, config.rules);
      const options = [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        ...(always === null ? [] : [{ optionId: "always", name: "Always allow this", kind: "allow_always" }]),
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ];
      const answer = await Promise.race([
        peer.request("session/request_permission", { sessionId, toolCall: { toolCallId: callId, title, kind, status: "pending" }, options }).then(
          (value) => (field(value, "outcome") ?? { outcome: "cancelled" }) as Outcome,
          (): Outcome => ({ outcome: "cancelled" }),
        ),
        cancelled,
      ]);
      const chosen = answer.outcome === "selected" ? answer.optionId : undefined;
      const allowed = chosen === "allow" || (chosen === "always" && always !== null);
      if (chosen === "always" && always !== null) saveConfig(db.paths, { ...loadConfig(db.paths), rules: [...config.rules, always] });
      try {
        resolveApproval(db, approvalId, allowed ? "allow" : "deny", allowed ? "allowed by the ACP client" : "refused by the ACP client", String(event.runId));
      } catch {
        // already expired or resolved, for example because the turn was cancelled
      }
      if (allowed) update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "in_progress" });
    };

    const onEvent = async (event: RunEvent): Promise<StopReason | undefined> => {
      const data = JSON.parse(event.data) as Record<string, unknown>;
      if (event.type === "approval.request") {
        await askClient(data);
      } else if (event.type === "tool.result") {
        const callId = String(data.callId);
        const status = data.ok === true ? "completed" : "failed";
        const content = textOf(String(data.output ?? ""));
        if (announced.has(callId)) {
          update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: callId, status, content });
        } else {
          announced.add(callId);
          update(sessionId, { sessionUpdate: "tool_call", toolCallId: callId, title: toolTitle(String(data.name), String(data.detail ?? "")), kind: toolKind(String(data.name)), status, content });
        }
      } else if (event.type === "run.finished") {
        if (!streamed && typeof data.text === "string" && data.text.length > 0) update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: data.text } });
        return "end_turn";
      } else if (event.type === "run.blocked") {
        const reason = String(data.reason ?? "the run was blocked");
        const stop = stopReasonFor(reason);
        if (stop !== null) return stop;
        throw new RpcError(RPC_CODES.internal, blockMessage(reason), { reason });
      }
      return undefined;
    };

    try {
      startRun(sessionId, text, state.workspace, "build");
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        for (const event of listEvents(db, sessionId, lastSeq)) {
          lastSeq = event.seq;
          const done = await onEvent(event);
          if (done !== undefined) return done;
        }
      }
    } finally {
      off();
      state.running = false;
      state.cancel = null;
    }
  }

  async function onRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "initialize") return initialize(params);
    if (!initialized) throw new RpcError(RPC_CODES.invalidRequest, "Send initialize first.");
    if (method === "session/new") return newSession(params);
    if (method === "session/prompt") return prompt(params);
    if (method === "session/cancel") {
      cancelSession(params);
      return {};
    }
    throw new RpcError(RPC_CODES.methodNotFound, `Method not found: ${method}`);
  }

  function cancelSession(params: unknown): void {
    const id = field(params, "sessionId");
    const state = typeof id === "string" ? sessions.get(id) : undefined;
    if (state === undefined || typeof id !== "string") return;
    state.cancel?.();
    stopSessionRun(db, id);
  }

  return new Promise<void>((resolve) => {
    peer = new JsonRpcPeer(input, output, {
      onRequest,
      onNotification: (method, params) => {
        if (method === "session/cancel") cancelSession(params);
      },
      onClose: () => {
        for (const id of sessions.keys()) stopSessionRun(db, id);
        // A stopped run is still unwinding (it releases its lease); the caller closes the database once this resolves.
        void whenRunsSettled().then(resolve, resolve);
      },
    });
    peer.start();
  });
}
