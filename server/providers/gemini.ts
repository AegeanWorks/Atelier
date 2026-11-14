import { AtelierError } from "../config.js";
import type { ChatMessage, ModelInfo, ProviderAdapter, StreamEvent } from "./types.js";
import { fetchWithRetry, joinUrl, responseError } from "./http.js";
import { parseSse } from "./sse.js";
import { geminiParts } from "./images.js";

function parseJson(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function keyOrThrow(apiKey: string | null): string {
  if (apiKey === null) throw new AtelierError("PROVIDER_KEY", "Gemini key is missing.", "No key was found in the environment or secrets store.", "Set GEMINI_API_KEY or save the key in Settings.");
  return apiKey;
}

type GeminiPart = Record<string, unknown>;
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

function contents(messages: ChatMessage[]): { system: string; contents: GeminiContent[] } {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const output: GeminiContent[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (message.content.length > 0) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) parts.push({ functionCall: { name: call.name, args: call.input ?? {} } });
      if (parts.length === 0) continue;
      output.push({ role: "model", parts });
      continue;
    }
    if (message.role === "tool") {
      output.push({ role: "user", parts: [{ functionResponse: { name: message.name ?? "", response: { result: message.content } } }] });
      continue;
    }
    output.push({ role: "user", parts: geminiParts(message) });
  }
  return { system, contents: output };
}

export const gemini: ProviderAdapter = {
  protocol: "gemini",
  async listModels(context, signal): Promise<ModelInfo[]> {
    const response = await fetchWithRetry(
      joinUrl(context.baseUrl, "/models"),
      { headers: { "x-goog-api-key": keyOrThrow(context.apiKey), ...context.config.headers } },
      { signal, timeoutMs: context.config.timeoutMs ?? 30_000 },
    );
    if (!response.ok) throw await responseError(response);
    const body = (await response.json()) as {
      models?: Array<{ name?: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number; supportedGenerationMethods?: string[] }>;
    };
    return (body.models ?? [])
      .filter((model) => typeof model.name === "string" && (model.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((model) => ({
        id: (model.name as string).replace(/^models\//, ""),
        name: model.displayName ?? (model.name as string),
        contextWindow: model.inputTokenLimit,
        maxOutput: model.outputTokenLimit,
        tools: true,
        vision: true,
      }));
  },
  async *stream(context, request, signal): AsyncIterable<StreamEvent> {
    const normalised = contents(request.messages);
    const body: Record<string, unknown> = {
      contents: normalised.contents,
      generationConfig: {
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
      },
    };
    if (normalised.system.length > 0) body.systemInstruction = { parts: [{ text: normalised.system }] };
    if (request.tools !== undefined) {
      body.tools = [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }];
    }
    const path = `models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`;
    const response = await fetchWithRetry(
      joinUrl(context.baseUrl, path),
      {
        method: "POST",
        headers: {
          "x-goog-api-key": keyOrThrow(context.apiKey),
          "content-type": "application/json",
          ...context.config.headers,
        },
        body: JSON.stringify(body),
      },
      { signal, timeoutMs: context.config.timeoutMs ?? 30_000, stallMs: 60_000 },
    );
    if (!response.ok) throw await responseError(response);
    if (response.body === null) throw new AtelierError("PROVIDER_STREAM", "Gemini returned no body.", "The response was empty.", "Retry or switch providers.");
    let reason = "STOP";
    for await (const frame of parseSse(response.body, { signal, stallMs: 60_000 })) {
      const chunk = parseJson(frame.data);
      if (chunk === null) continue;
      const usage = chunk.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number } | undefined;
      if (usage !== undefined) {
        yield {
          type: "usage",
          promptTokens: usage.promptTokenCount ?? 0,
          completionTokens: usage.candidatesTokenCount ?? 0,
          cachedTokens: usage.cachedContentTokenCount ?? 0,
        };
      }
      const candidates = chunk.candidates as Array<{ content?: { parts?: Array<Record<string, unknown>> }; finishReason?: string }> | undefined;
      const candidate = candidates?.[0];
      if (candidate?.finishReason !== undefined) reason = candidate.finishReason;
      const parts = candidate?.content?.parts ?? [];
      for (const part of parts) {
        if (typeof part.text === "string" && part.text.length > 0) yield { type: "text-delta", text: part.text };
        const call = part.functionCall as { name?: unknown; args?: unknown } | undefined;
        if (typeof call?.name === "string") {
          yield {
            type: "tool-call",
            id: `gemini_${call.name}`,
            name: call.name,
            input: typeof call.args === "object" && call.args !== null ? call.args : {},
          };
        }
      }
    }
    yield { type: "finish", reason };
  },
};
