import { AtelierError } from "../config.js";
import type { ChatMessage, ModelInfo, ProviderAdapter, StreamEvent } from "./types.js";
import { fetchWithRetry, joinUrl, responseError } from "./http.js";
import { parseSse } from "./sse.js";
import { anthropicContent } from "./images.js";

function parseJson(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function keyOrThrow(apiKey: string | null): string {
  if (apiKey === null) throw new AtelierError("PROVIDER_KEY", "Anthropic key is missing.", "No key was found in the environment or secrets store.", "Set ANTHROPIC_API_KEY or save the key in Settings.");
  return apiKey;
}

function messagesPath(baseUrl: string): string {
  return joinUrl(baseUrl.endsWith("/v1") ? baseUrl : joinUrl(baseUrl, "/v1"), "/messages");
}

function modelsPath(baseUrl: string): string {
  return joinUrl(baseUrl.endsWith("/v1") ? baseUrl : joinUrl(baseUrl, "/v1"), "/models");
}

type ContentBlock = Record<string, unknown>;
interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

function normaliseMessages(messages: ChatMessage[]): { system: string; messages: AnthropicMessage[] } {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const output: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      const blocks: ContentBlock[] = [];
      if (message.content.length > 0) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input ?? {} });
      }
      if (blocks.length === 0) continue;
      output.push({ role: "assistant", content: blocks });
      continue;
    }
    if (message.role === "tool") {
      const block: ContentBlock = { type: "tool_result", tool_use_id: message.toolCallId ?? "", content: message.content };
      const last = output[output.length - 1];
      if (last !== undefined && last.role === "user" && Array.isArray(last.content)) last.content.push(block);
      else output.push({ role: "user", content: [block] });
      continue;
    }
    output.push({ role: "user", content: anthropicContent(message) });
  }
  return { system, messages: output };
}

export const anthropicMessages: ProviderAdapter = {
  protocol: "anthropic-messages",
  async listModels(context, signal): Promise<ModelInfo[]> {
    const response = await fetchWithRetry(
      modelsPath(context.baseUrl),
      {
        headers: {
          "x-api-key": keyOrThrow(context.apiKey),
          "anthropic-version": "2023-06-01",
          ...context.config.headers,
        },
      },
      { signal, timeoutMs: context.config.timeoutMs ?? 30_000 },
    );
    if (!response.ok) throw await responseError(response);
    const body = (await response.json()) as { data?: Array<{ id?: string; display_name?: string; type?: string }> };
    return (body.data ?? [])
      .filter((entry) => typeof entry.id === "string")
      .map((entry) => ({ id: entry.id as string, name: entry.display_name ?? (entry.id as string), tools: true, vision: true }));
  },
  async *stream(context, request, signal): AsyncIterable<StreamEvent> {
    const normalised = normaliseMessages(request.messages);
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? 4096,
      stream: true,
      messages: normalised.messages,
    };
    if (normalised.system.length > 0) body.system = normalised.system;
    if (request.tools !== undefined) {
      body.tools = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    const response = await fetchWithRetry(
      messagesPath(context.baseUrl),
      {
        method: "POST",
        headers: {
          "x-api-key": keyOrThrow(context.apiKey),
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          ...context.config.headers,
        },
        body: JSON.stringify(body),
      },
      { signal, timeoutMs: context.config.timeoutMs ?? 30_000, stallMs: 60_000 },
    );
    if (!response.ok) throw await responseError(response);
    if (response.body === null) throw new AtelierError("PROVIDER_STREAM", "Anthropic returned no body.", "The response was empty.", "Retry or switch providers.");
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let promptTokens = 0;
    let reason = "end_turn";
    for await (const frame of parseSse(response.body, { signal, stallMs: 60_000 })) {
      const event = parseJson(frame.data);
      if (event === null) continue;
      const type = typeof event.type === "string" ? event.type : frame.event;
      if (type === "message_start") {
        const message = event.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined;
        promptTokens = message?.usage?.input_tokens ?? 0;
        const cached = (message?.usage?.cache_read_input_tokens ?? 0) + (message?.usage?.cache_creation_input_tokens ?? 0);
        if (cached > 0) yield { type: "usage", promptTokens, completionTokens: 0, cachedTokens: cached };
      } else if (type === "content_block_start") {
        const index = typeof event.index === "number" ? event.index : 0;
        const block = event.content_block as { type?: string; id?: string; name?: string } | undefined;
        if (block?.type === "tool_use") calls.set(index, { id: block.id ?? `tool_${index}`, name: block.name ?? "", args: "" });
      } else if (type === "content_block_delta") {
        const index = typeof event.index === "number" ? event.index : 0;
        const delta = event.delta as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") yield { type: "text-delta", text: delta.text };
        if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") yield { type: "reasoning-delta", text: delta.thinking };
        if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const current = calls.get(index);
          if (current !== undefined) {
            current.args += delta.partial_json;
            yield { type: "tool-arg-delta", id: current.id, name: current.name, delta: delta.partial_json };
          }
        }
      } else if (type === "message_delta") {
        const delta = event.delta as { stop_reason?: string } | undefined;
        if (typeof delta?.stop_reason === "string") reason = delta.stop_reason;
        const usage = event.usage as { output_tokens?: number } | undefined;
        if (usage?.output_tokens !== undefined) yield { type: "usage", promptTokens, completionTokens: usage.output_tokens };
      }
    }
    for (const call of calls.values()) {
      if (call.name.length === 0) continue;
      let input: unknown = {};
      try {
        input = call.args.length > 0 ? JSON.parse(call.args) : {};
      } catch {
        input = { raw: call.args };
      }
      yield { type: "tool-call", id: call.id, name: call.name, input };
    }
    yield { type: "finish", reason };
  },
};
