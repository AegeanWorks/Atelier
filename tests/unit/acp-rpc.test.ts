import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { JsonRpcPeer, RpcError } from "../../server/acp/rpc";

interface Harness {
  peer: JsonRpcPeer;
  send: (message: unknown) => void;
  raw: (text: string) => void;
  received: () => unknown[];
}

function harness(handlers: { onRequest?: (method: string, params: unknown) => Promise<unknown>; onNotification?: (method: string, params: unknown) => void } = {}): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    lines.push(...parts);
  });
  const peer = new JsonRpcPeer(input, output, {
    onRequest: handlers.onRequest ?? (async () => ({})),
    onNotification: handlers.onNotification ?? (() => undefined),
    onClose: () => undefined,
  });
  peer.start();
  return {
    peer,
    send: (message) => input.write(`${JSON.stringify(message)}\n`),
    raw: (text) => input.write(text),
    received: () => lines.map((line) => JSON.parse(line) as unknown),
  };
}

/** Let the event loop run until the condition holds. It waits for a state, never for a duration, so it cannot flake under load. */
async function until(condition: () => boolean, label = "the condition"): Promise<void> {
  for (let turns = 0; turns < 5000; turns += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`gave up waiting for ${label}`);
}

/** A few more turns of the event loop, to show that something does NOT happen. */
async function settle(): Promise<void> {
  for (let turns = 0; turns < 25; turns += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("JsonRpcPeer: requests the peer receives", () => {
  it("answers a request with the handler's result, correlated by id", async () => {
    const h = harness({ onRequest: async (method, params) => ({ echoed: method, params }) });
    h.send({ jsonrpc: "2.0", id: 7, method: "ping", params: { a: 1 } });
    await until(() => h.received().length >= 1, "the reply");
    expect(h.received()).toEqual([{ jsonrpc: "2.0", id: 7, result: { echoed: "ping", params: { a: 1 } } }]);
  });

  it("turns an RpcError into a JSON-RPC error with its code and data", async () => {
    const h = harness({
      onRequest: async () => {
        throw new RpcError(-32002, "Resource not found", { sessionId: "s1" });
      },
    });
    h.send({ jsonrpc: "2.0", id: "abc", method: "x" });
    await until(() => h.received().length >= 1, "the error reply");
    expect(h.received()).toEqual([{ jsonrpc: "2.0", id: "abc", error: { code: -32002, message: "Resource not found", data: { sessionId: "s1" } } }]);
  });

  it("reports an unexpected exception as an internal error without leaking a stack", async () => {
    const h = harness({
      onRequest: async () => {
        throw new Error("boom");
      },
    });
    h.send({ jsonrpc: "2.0", id: 1, method: "x" });
    await until(() => h.received().length >= 1, "the error reply");
    const [reply] = h.received() as Array<{ error: { code: number; message: string; data?: unknown } }>;
    expect(reply?.error.code).toBe(-32603);
    expect(reply?.error.message).toBe("boom");
    expect(JSON.stringify(reply)).not.toContain("at ");
  });

  it("keeps serving while a slow request is still pending", async () => {
    let release: () => void = () => undefined;
    const h = harness({
      onRequest: async (method) => {
        if (method === "slow") await new Promise<void>((resolve) => (release = resolve));
        return { method };
      },
    });
    h.send({ jsonrpc: "2.0", id: 1, method: "slow" });
    h.send({ jsonrpc: "2.0", id: 2, method: "fast" });
    await until(() => h.received().length >= 1, "the fast reply");
    expect(h.received()).toEqual([{ jsonrpc: "2.0", id: 2, result: { method: "fast" } }]);
    release();
    await until(() => h.received().length >= 2, "the slow reply");
    expect(h.received()).toHaveLength(2);
  });

  it("handles several messages in one chunk and one message split across chunks", async () => {
    const h = harness({ onRequest: async (method) => ({ method }) });
    h.raw(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "a" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "b" })}\n`);
    const text = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "c" });
    h.raw(text.slice(0, 10));
    await until(() => h.received().length >= 2, "the first two replies");
    expect(h.received()).toHaveLength(2);
    h.raw(`${text.slice(10)}\n`);
    await until(() => h.received().length >= 3, "the third reply");
    expect(h.received().map((message) => (message as { id: number }).id).sort()).toEqual([1, 2, 3]);
  });

  it("replies to garbage with a parse error and keeps going", async () => {
    const h = harness({ onRequest: async () => ({ ok: true }) });
    h.raw("this is not json\n");
    h.send({ jsonrpc: "2.0", id: 5, method: "x" });
    await until(() => h.received().length >= 2, "both replies");
    const replies = h.received() as Array<{ id: unknown; error?: { code: number } }>;
    expect(replies[0]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(replies[1]).toMatchObject({ id: 5 });
  });

  it("rejects a message that is valid JSON but not a request, notification or response", async () => {
    const h = harness();
    h.send({ hello: "world", id: 9 });
    await until(() => h.received().length >= 1, "the error reply");
    expect(h.received()[0]).toMatchObject({ id: 9, error: { code: -32600 } });
  });

  it("passes a notification to its handler and sends nothing back", async () => {
    const seen: Array<[string, unknown]> = [];
    const h = harness({ onNotification: (method, params) => void seen.push([method, params]) });
    h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } });
    await until(() => seen.length >= 1, "the notification");
    await settle();
    expect(seen).toEqual([["session/cancel", { sessionId: "s" }]]);
    expect(h.received()).toEqual([]);
  });
});

describe("JsonRpcPeer: what it sends", () => {
  it("writes a notification as one line with no id", async () => {
    const h = harness();
    h.peer.notify("session/update", { sessionId: "s", text: "line one\nline two" });
    await until(() => h.received().length >= 1, "the notification");
    expect(h.received()).toEqual([{ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", text: "line one\nline two" } }]);
  });

  it("sends a request and resolves it with the matching response, even out of order", async () => {
    const h = harness();
    const first = h.peer.request("one", { n: 1 });
    const second = h.peer.request("two", { n: 2 });
    await until(() => h.received().length >= 2, "both requests");
    const sent = h.received() as Array<{ id: number; method: string }>;
    expect(sent.map((message) => message.method)).toEqual(["one", "two"]);
    h.send({ jsonrpc: "2.0", id: sent[1]?.id, result: { answer: "second" } });
    h.send({ jsonrpc: "2.0", id: sent[0]?.id, result: { answer: "first" } });
    expect(await first).toEqual({ answer: "first" });
    expect(await second).toEqual({ answer: "second" });
  });

  it("rejects a request when the peer answers with an error", async () => {
    const h = harness();
    const pending = h.peer.request("x", {});
    await until(() => h.received().length >= 1, "the request");
    const [sent] = h.received() as Array<{ id: number }>;
    h.send({ jsonrpc: "2.0", id: sent?.id, error: { code: -32601, message: "nope" } });
    await expect(pending).rejects.toMatchObject({ code: -32601, message: "nope" });
  });

  it("fails pending requests and reports the close when the input ends", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let closed = false;
    const peer = new JsonRpcPeer(input, output, { onRequest: async () => ({}), onNotification: () => undefined, onClose: () => void (closed = true) });
    peer.start();
    const pending = peer.request("x", {});
    input.end();
    await expect(pending).rejects.toMatchObject({ message: expect.stringMatching(/closed/i) });
    expect(closed).toBe(true);
  });
});

describe("JsonRpcPeer: closing", () => {
  it("reports the close once even though the stream emits both end and close", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let calls = 0;
    new JsonRpcPeer(input, output, { onRequest: async () => ({}), onNotification: () => undefined, onClose: () => void (calls += 1) }).start();
    input.end();
    await until(() => calls >= 1, "the close");
    input.destroy();
    await settle();
    expect(calls).toBe(1);
  });
});
