import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { anthropicMessages } from "../../server/providers/anthropic";
import { gemini } from "../../server/providers/gemini";
import { openaiChat } from "../../server/providers/openaiChat";
import { openaiResponses } from "../../server/providers/openaiResponses";
import type { ChatMessage, ChatRequest, ProviderAdapter, ProviderContext } from "../../server/providers/types";

const servers: Server[] = [];

const conversation: ChatMessage[] = [
  { role: "system", content: "sys rules" },
  { role: "user", content: "read notes.txt" },
  { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", input: { path: "notes.txt" } }] },
  { role: "tool", content: "1: hello", toolCallId: "call_1", name: "read_file" },
];

const request: ChatRequest = { model: "test-model", messages: conversation };

async function capture(adapter: ProviderAdapter, sseBody: string, baseSuffix = "/v1"): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  const server = createServer((incoming, response) => {
    let payload = "";
    incoming.on("data", (chunk) => {
      payload += chunk.toString();
    });
    incoming.on("end", () => {
      body = JSON.parse(payload) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sseBody);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${address.port}${baseSuffix}`;
  const context: ProviderContext = { config: { id: "t", name: "T", protocol: adapter.protocol, baseUrl }, apiKey: "sk-test", baseUrl };
  for await (const _event of adapter.stream(context, request, new AbortController().signal)) {
    // Drain the stream so the request completes.
  }
  return body;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("provider tool-call wire format", () => {
  it("sends assistant tool_calls and tool results to OpenAI chat", async () => {
    const body = await capture(
      openaiChat,
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "sys rules" });
    const assistant = messages[2] as { role: string; content: null; tool_calls: Array<Record<string, unknown>> };
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls[0]).toMatchObject({ id: "call_1", type: "function", function: { name: "read_file" } });
    expect(messages[3]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "1: hello" });
  });

  it("sends Anthropic tool_use blocks and merged tool_result blocks", async () => {
    const body = await capture(
      anthropicMessages,
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    );
    expect(body.system).toBe("sys rules");
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]).toEqual({ role: "user", content: "read notes.txt" });
    const assistant = messages[1] as { role: string; content: Array<Record<string, unknown>> };
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toEqual([{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "notes.txt" } }]);
    const result = messages[2] as { role: string; content: Array<Record<string, unknown>> };
    expect(result.role).toBe("user");
    expect(result.content[0]).toEqual({ type: "tool_result", tool_use_id: "call_1", content: "1: hello" });
  });

  it("sends Gemini functionCall and functionResponse parts", async () => {
    const body = await capture(gemini, 'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n', "/v1beta");
    expect(body.systemInstruction).toEqual({ parts: [{ text: "sys rules" }] });
    const contents = body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "read notes.txt" }] });
    expect(contents[1]?.role).toBe("model");
    expect(contents[1]?.parts[0]).toEqual({ functionCall: { name: "read_file", args: { path: "notes.txt" } } });
    expect(contents[2]).toEqual({ role: "user", parts: [{ functionResponse: { name: "read_file", response: { result: "1: hello" } } }] });
  });

  it("sends OpenAI Responses function_call and function_call_output items", async () => {
    const body = await capture(
      openaiResponses,
      'data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    );
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({ role: "system", content: "sys rules" });
    expect(input[1]).toEqual({ role: "user", content: "read notes.txt" });
    expect(input[2]).toMatchObject({ type: "function_call", call_id: "call_1", name: "read_file" });
    expect(input[3]).toEqual({ type: "function_call_output", call_id: "call_1", output: "1: hello" });
  });
});
