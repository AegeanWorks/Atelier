import { AtelierError } from "../config.js";

export interface SseFrame {
  event: string;
  data: string;
  id: string | null;
}

function parseFrame(raw: string): SseFrame | null {
  const lines = raw.split("\n");
  let event = "message";
  let id: string | null = null;
  const data: string[] = [];
  for (const line of lines) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n"), id };
}

async function readWithStall(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stallMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new AtelierError("PROVIDER_STALL", "Provider stream stalled.", `No bytes arrived for ${stallMs} ms.`, "Retry or switch providers."));
        }, stallMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  options: { stallMs?: number; signal?: AbortSignal } = {},
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (options.signal?.aborted) throw new AtelierError("PROVIDER_ABORTED", "Provider stream aborted.", "The client or caller cancelled the request.", "Retry when ready.");
      const { done, value } = options.stallMs === undefined
        ? await reader.read()
        : await readWithStall(reader, options.stallMs);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary === -1) break;
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseFrame(raw);
        if (frame !== null) yield frame;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const frame = parseFrame(buffer);
      if (frame !== null) yield frame;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be closed.
    }
  }
}

export function sseResponse(frame: SseFrame): string {
  return `event: ${frame.event}\ndata: ${frame.data}\n\n`;
}
