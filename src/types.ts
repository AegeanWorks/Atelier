export interface Session {
  id: string;
  title: string;
  created: number;
  updated: number;
  pinned: number;
  archived: number;
}

export interface Message {
  id: string;
  session_id: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  client_id: string | null;
  created: number;
}

export interface Profile {
  id: string;
  label: string;
  tools: string[];
}

export interface Recovery {
  startedAt: number;
  finishedAt: number;
  actionCount: number;
  result: "clean" | "recovered" | "blocked";
  actions: string[];
}

export type Protocol = "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini";

export interface ProviderStatus {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  defaultModel: string | null;
  modelCount: number;
  key: { set: boolean; source: "env" | "secret" | "missing" };
}

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface HookConfig {
  id: string;
  event: "pre_tool" | "post_tool";
  match: string;
  command: string;
  timeoutMs?: number;
}

export interface RuleConfig {
  id: string;
  action: "exec" | "edit";
  match: string;
  decision: "allow" | "ask" | "deny";
}

export interface ConfigView {
  providers: ProviderStatus[];
  roles: {
    executor: string | null;
    manager: string | null;
    auditor: string | null;
    compactor: string | null;
  };
  defaults: { provider: string | null; model: string | null };
  mcpServers?: McpServerConfig[];
  hooks?: HookConfig[];
  rules?: RuleConfig[];
}

export interface Boot {
  version: string;
  workspace: string;
  sessions: Session[];
  profiles: Profile[];
  providers: ProviderStatus[];
  recovery: Recovery;
}

export interface Approval {
  id: string;
  run_id: string;
  session_id: string;
  call_id: string;
  tool: string;
  action: string;
  resource: string;
  reason: string;
  preview: string | null;
  status: "pending" | "approved" | "denied" | "expired";
  created: number;
}

export interface CheckpointEntry {
  commit: string;
  createdAt: number;
  message: string;
  path: string;
}

export type RunStatus = "running" | "blocked" | "finished" | "error" | "resuming";

export interface Run {
  id: string;
  session_id: string;
  status: RunStatus;
  parent_run_id: string | null;
  fork_id: string | null;
  profile_id: string | null;
  blocked_reason: string | null;
  recovery_attempts: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  workspace: string | null;
  created: number;
  updated: number;
}

export interface RunStep {
  id: string;
  run_id: string;
  seq: number;
  kind: string;
  status: string;
  input_json: string | null;
  output_ref: string | null;
  created: number;
}

export interface AuditFinding {
  level: "L1" | "L2" | "L3";
  code: string;
  message: string;
}

export interface AuditReport {
  runId: string;
  clean: boolean;
  findings: AuditFinding[];
}

export interface RunDetail {
  run: Run;
  steps: RunStep[];
}

export type PlanStatus = "draft" | "active" | "done" | "archived";

export interface Plan {
  id: string;
  session_id: string;
  title: string;
  body: string;
  status: PlanStatus;
  source_run_id: string | null;
  created: number;
  updated: number;
}

export interface PlanRevision {
  id: string;
  plan_id: string;
  title: string;
  body: string;
  status: PlanStatus;
  created: number;
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
  last?: { providerId: string; model: string; promptTokens: number } | null;
  delegated?: { requests: number; costUsd: number };
  context?: { providerId: string; model: string; usedTokens: number; windowTokens: number | null } | null;
}
