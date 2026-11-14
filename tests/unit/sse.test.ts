import { describe, expect, it } from "vitest";
import { parseSse } from "../../server/providers/sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]) {
  const frames = [];
  for await (const frame of parseSse(streamOf(chunks))) frames.push(frame);
  return frames;
}

describe("SSE parser", () => {
  it("parses event, data and id fields", async () => {
    const frames = await collect(["event: delta\nid: 7\ndata: {\"text\":\"hi\"}\n\n"]);
    expect(frames).toEqual([{ event: "delta", id: "7", data: "{\"text\":\"hi\"}" }]);
  });

  it("joins multiline data and ignores comments", async () => {
    const frames = await collect([": keepalive\n\ndata: one\ndata: two\n\n"]);
    expect(frames).toEqual([{ event: "message", id: null, data: "one\ntwo" }]);
  });

  it("handles CRLF split across chunks", async () => {
    const frames = await collect(["data: a\r", "\n\r\ndata: b\r\n\r\n"]);
    expect(frames.map((frame) => frame.data)).toEqual(["a", "b"]);
  });

  it("returns no frame for a comment-only block", async () => {
    const frames = await collect([": ping\n\n"]);
    expect(frames).toEqual([]);
  });
});
