export type Protocol = "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini";

export interface ModelInfo {
  id: string;
  name?: string | undefined;
  contextWindow?: number | undefined;
  maxOutput?: number | undefined;
  tools?: boolean | undefined;
  vision?: boolean | undefined;
  reasoning?: boolean | undefined;
  pricing?: { input: number; output: number } | undefined;
}

export interface ProviderConfig {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKeyEnv?: string | undefined;
  headers?: Record<string, string> | undefined;
  defaultModel?: string | undefined;
  fallbackId?: string | undefined;
  timeoutMs?: number | undefined;
  models?: ModelInfo[] | undefined;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCallRef {
  id: string;
  name: string;
  input: unknown;
}

export interface ImagePart {
  mediaType: string;
  /** Base64 bytes without a data: prefix. */
  data: string;
}

export interface ChatMessage {
  images?: ImagePart[] | undefined;
  role: ChatRole;
  content: string;
  toolCallId?: string | undefined;
  name?: string | undefined;
  toolCalls?: ToolCallRef[] | undefined;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[] | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
}

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-arg-delta"; id: string; name: string; delta: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "usage"; promptTokens: number; completionTokens: number; cachedTokens?: number | undefined }
  | { type: "finish"; reason: string }
  | { type: "provider.failover"; from: string; to: string; reason: string }
  | { type: "memo.replay"; requestHash: string }
  | { type: "error"; message: string; code?: string | undefined };

export interface ProviderContext {
  config: ProviderConfig;
  apiKey: string | null;
  baseUrl: string;
}

export interface ProviderAdapter {
  protocol: Protocol;
  listModels(context: ProviderContext, signal: AbortSignal): Promise<ModelInfo[]>;
  stream(context: ProviderContext, request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}

export interface ProviderStatus {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  defaultModel: string | null;
  modelCount: number;
  key: { set: boolean; source: "env" | "secret" | "missing" };
}
