import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicMessages } from "../../server/providers/anthropic";
import { gemini } from "../../server/providers/gemini";
import { openaiChat } from "../../server/providers/openaiChat";
import { openaiResponses } from "../../server/providers/openaiResponses";
import type { ProviderContext, StreamEvent } from "../../server/providers/types";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function context(baseUrl: string): ProviderContext {
  return {
    config: { id: "test", name: "Test", protocol: "openai-chat", baseUrl },
    apiKey: "test-key",
    baseUrl,
  };
}

function stubFetch(chunks: string[]): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(streamOf(chunks), { status: 200, headers: { "content-type": "text/event-stream" } })));
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const result: StreamEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider adapters", () => {
  it("parses OpenAI Chat text, tool calls and usage", async () => {
    stubFetch([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const events = await collect(openaiChat.stream(context("http://127.0.0.1:1/v1"), { model: "m", messages: [{ role: "user", content: "hi" }] }, new AbortController().signal));
    expect(events.filter((event) => event.type === "text-delta").map((event) => (event.type === "text-delta" ? event.text : "")).join("")).toBe("Hello");
    expect(events).toContainEqual({ type: "tool-call", id: "call_1", name: "read_file", input: { path: "a.txt" } });
    expect(events).toContainEqual({ type: "usage", promptTokens: 5, completionTokens: 3, cachedTokens: 0 });
    expect(events).toContainEqual({ type: "finish", reason: "tool_calls" });
  });

  it("parses Anthropic text, thinking, tool input and usage", async () => {
    stubFetch([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_1","name":"read_file"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.txt\\"}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    const events = await collect(anthropicMessages.stream(context("http://127.0.0.1:1"), { model: "m", messages: [{ role: "user", content: "hi" }] }, new AbortController().signal));
    expect(events).toContainEqual({ type: "text-delta", text: "Hi" });
    expect(events).toContainEqual({ type: "reasoning-delta", text: "plan" });
    expect(events).toContainEqual({ type: "tool-call", id: "tool_1", name: "read_file", input: { path: "a.txt" } });
    expect(events).toContainEqual({ type: "finish", reason: "tool_use" });
  });

  it("parses Gemini text, function calls and usage", async () => {
    stubFetch([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":1}}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a.txt"}}}]},"finishReason":"STOP"}]}\n\n',
    ]);
    const events = await collect(gemini.stream(context("http://127.0.0.1:1/v1beta"), { model: "gemini-test", messages: [{ role: "user", content: "hi" }] }, new AbortController().signal));
    expect(events).toContainEqual({ type: "text-delta", text: "Hi" });
    expect(events).toContainEqual({ type: "tool-call", id: "gemini_read_file", name: "read_file", input: { path: "a.txt" } });
    expect(events).toContainEqual({ type: "usage", promptTokens: 4, completionTokens: 1, cachedTokens: 0 });
    expect(events).toContainEqual({ type: "finish", reason: "STOP" });
  });

  it("parses OpenAI Responses text, tool arguments and usage", async () => {
    stubFetch([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"item_1","type":"function_call","name":"read_file","call_id":"call_1"}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"item_1","delta":"{\\"path\\":\\"a.txt\\"}"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":2}}}\n\n',
    ]);
    const events = await collect(openaiResponses.stream(context("http://127.0.0.1:1/v1"), { model: "m", messages: [{ role: "user", content: "hi" }] }, new AbortController().signal));
    expect(events).toContainEqual({ type: "text-delta", text: "Hi" });
    expect(events).toContainEqual({ type: "tool-call", id: "call_1", name: "read_file", input: { path: "a.txt" } });
    expect(events).toContainEqual({ type: "usage", promptTokens: 5, completionTokens: 2, cachedTokens: 0 });
  });
});
