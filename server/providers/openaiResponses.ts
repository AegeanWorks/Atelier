import { AtelierError } from "../config.js";
import type { ModelInfo, ProviderAdapter, StreamEvent } from "./types.js";
import { fetchWithRetry, joinUrl, responseError } from "./http.js";
import { parseSse } from "./sse.js";
import { openaiResponsesContent } from "./images.js";

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

interface ResponseCall {
  id: string;
  name: string;
  args: string;
}

export const openaiResponses: ProviderAdapter = {
  protocol: "openai-responses",
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
    const input: Array<Record<string, unknown>> = [];
    for (const message of request.messages) {
      if (message.role === "assistant") {
        if (message.content.length > 0) input.push({ role: "assistant", content: message.content });
        for (const call of message.toolCalls ?? []) {
          input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.input ?? {}) });
        }
        continue;
      }
      if (message.role === "tool") {
        input.push({ type: "function_call_output", call_id: message.toolCallId ?? "", output: message.content });
        continue;
      }
      input.push({ role: message.role, content: openaiResponsesContent(message) });
    }
    const body: Record<string, unknown> = {
      model: request.model,
      input,
      stream: true,
    };
    if (request.tools !== undefined) {
      body.tools = request.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters }));
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_output_tokens = request.maxTokens;
    const response = await fetchWithRetry(
      joinUrl(context.baseUrl, "/responses"),
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
    const calls = new Map<string, ResponseCall>();
    let reason = "stop";
    for await (const frame of parseSse(response.body, { signal, stallMs: 60_000 })) {
      const event = parseJson(frame.data);
      if (event === null) continue;
      const type = typeof event.type === "string" ? event.type : frame.event;
      if (type === "response.output_text.delta" && typeof event.delta === "string") yield { type: "text-delta", text: event.delta };
      else if (type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") yield { type: "reasoning-delta", text: event.delta };
      else if (type === "response.output_item.added") {
        const item = event.item as { id?: unknown; type?: unknown; name?: unknown; call_id?: unknown } | undefined;
        if (item?.type === "function_call" && typeof item.id === "string") {
          calls.set(item.id, { id: typeof item.call_id === "string" ? item.call_id : item.id, name: typeof item.name === "string" ? item.name : "", args: "" });
        }
      } else if (type === "response.function_call_arguments.delta") {
        const id = typeof event.item_id === "string" ? event.item_id : "";
        const current = calls.get(id);
        if (current !== undefined && typeof event.delta === "string") {
          current.args += event.delta;
          yield { type: "tool-arg-delta", id: current.id, name: current.name, delta: event.delta };
        }
      } else if (type === "response.completed") {
        const responseBody = event.response as { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }; status?: string } | undefined;
        const usage = responseBody?.usage;
        if (usage !== undefined) {
          yield {
            type: "usage",
            promptTokens: usage.input_tokens ?? 0,
            completionTokens: usage.output_tokens ?? 0,
            cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,  // aikit:allow-secret[high-entropy-value] -- token usage counter, not a credential
          };
        }
        reason = responseBody?.status ?? "completed";
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
