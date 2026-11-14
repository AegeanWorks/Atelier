import { AtelierError } from "../config.js";
import type { ModelInfo, ProviderAdapter, StreamEvent } from "./types.js";
import { fetchWithRetry, joinUrl, responseError } from "./http.js";
import { parseSse } from "./sse.js";
import { openaiChatContent } from "./images.js";

interface OpenAiToolCall {
  id: string;
  name: string;
  args: string;
}

function parseJson(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function keyOrThrow(apiKey: string | null): string {
  if (apiKey === null) throw new AtelierError("PROVIDER_KEY", "Provider key is missing.", "No key was found in the environment or secrets store.", "Set the provider's environment variable or save its key in Settings.");
  return apiKey;
}

export const openaiChat: ProviderAdapter = {
  protocol: "openai-chat",
  async listModels(context, signal): Promise<ModelInfo[]> {
    const response = await fetchWithRetry(
      joinUrl(context.baseUrl, "/models"),
      { headers: { authorization: `Bearer ${keyOrThrow(context.apiKey)}`, ...context.config.headers } },
      { signal, timeoutMs: context.config.timeoutMs ?? 30_000 },
    );
    if (!response.ok) throw await responseError(response);
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).filter((entry) => typeof entry.id === "string").map((entry) => ({ id: entry.id as string, name: entry.id as string, tools: true }));
  },
  async *stream(context, request, signal): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((message) => {
        if (message.role === "assistant") {
          const calls = message.toolCalls ?? [];
          return {
            role: "assistant",
            content: message.content.length > 0 ? message.content : calls.length > 0 ? null : "",
            ...(calls.length === 0
              ? {}
              : {
                  tool_calls: calls.map((call) => ({
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
                  })),
                }),
          };
        }
        return {
          role: message.role,
          content: openaiChatContent(message),
          ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
          ...(message.name === undefined ? {} : { name: message.name }),
        };
      }),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.tools !== undefined) {
      body.tools = request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    const response = await fetchWithRetry(
      joinUrl(context.baseUrl, "/chat/completions"),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${keyOrThrow(context.apiKey)}`,
          "content-type": "application/json",
          ...context.config.headers,
        },
        body: JSON.stringify(body),
      },
      { signal, timeoutMs: context.config.timeoutMs ?? 30_000, stallMs: 60_000 },
    );
    if (!response.ok) throw await responseError(response);
    if (response.body === null) throw new AtelierError("PROVIDER_STREAM", "Provider returned no body.", "The response was empty.", "Retry or switch providers.");
    const calls = new Map<number, OpenAiToolCall>();
    let reason = "stop";
    for await (const frame of parseSse(response.body, { signal, stallMs: 60_000 })) {
      if (frame.data === "[DONE]") break;
      const chunk = parseJson(frame.data);
      if (chunk === null) continue;
      const usage = chunk.usage as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined;
      if (usage !== undefined) {
        yield {
          type: "usage",
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,  // aikit:allow-secret[high-entropy-value] -- token usage counter, not a credential
          cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,  // aikit:allow-secret[high-entropy-value] -- token usage counter, not a credential
        };
      }
      const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      if (choice === undefined) continue;
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (typeof delta?.content === "string" && delta.content.length > 0) yield { type: "text-delta", text: delta.content };
      if (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0) yield { type: "reasoning-delta", text: delta.reasoning_content };
      const toolCalls = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
      if (toolCalls !== undefined) {
        for (const call of toolCalls) {
          const index = typeof call.index === "number" ? call.index : 0;
          const current = calls.get(index) ?? { id: `call_${index}`, name: "", args: "" };
          if (typeof call.id === "string" && call.id.length > 0) current.id = call.id;
          const fn = call.function as { name?: unknown; arguments?: unknown } | undefined;
          if (typeof fn?.name === "string" && fn.name.length > 0) current.name = fn.name;
          if (typeof fn?.arguments === "string" && fn.arguments.length > 0) {
            current.args += fn.arguments;
            yield { type: "tool-arg-delta", id: current.id, name: current.name, delta: fn.arguments };
          }
          calls.set(index, current);
        }
      }
      if (typeof choice.finish_reason === "string") reason = choice.finish_reason;
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
