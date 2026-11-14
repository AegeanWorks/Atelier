import type { Readable, Writable } from "node:stream";

/** JSON-RPC 2.0 error codes the Agent Client Protocol uses. */
export const RPC_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  authRequired: -32000,
  notFound: -32002,
} as const;

/** An error that travels to the other side with its code and optional data, instead of being turned into an internal error. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface PeerHandlers {
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  onNotification: (method: string, params: unknown) => void;
  onClose: () => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One end of a newline-delimited JSON-RPC 2.0 connection. It reads messages from `input`, answers requests through
 * its handlers without waiting for earlier ones to finish, and can send its own requests and notifications.
 * Nothing but protocol messages is ever written to `output`.
 */
export class JsonRpcPeer {
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly handlers: PeerHandlers,
  ) {}

  start(): void {
    this.input.setEncoding("utf8");
    this.input.on("data", (chunk: string) => this.read(chunk));
    this.input.on("end", () => this.close());
    this.input.on("close", () => this.close());
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: unknown): void {
    // JSON.stringify never emits a raw newline, so one message is always exactly one line.
    if (!this.output.destroyed) this.output.write(`${JSON.stringify(message)}\n`);
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length > 0) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.write({ jsonrpc: "2.0", id: null, error: { code: RPC_CODES.parse, message: "Parse error" } });
      return;
    }
    if (!isObject(message)) {
      this.write({ jsonrpc: "2.0", id: null, error: { code: RPC_CODES.invalidRequest, message: "Invalid request" } });
      return;
    }
    const id = message.id;
    if (typeof message.method === "string") {
      if (id === undefined || id === null) this.handlers.onNotification(message.method, message.params);
      else void this.answer(id, message.method, message.params);
      return;
    }
    if (typeof id === "number" && ("result" in message || "error" in message)) {
      this.settle(id, message);
      return;
    }
    this.write({ jsonrpc: "2.0", id: id ?? null, error: { code: RPC_CODES.invalidRequest, message: "Invalid request" } });
  }

  private async answer(id: unknown, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handlers.onRequest(method, params);
      this.write({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (error) {
      if (error instanceof RpcError) {
        this.write({ jsonrpc: "2.0", id, error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } });
      } else {
        this.write({ jsonrpc: "2.0", id, error: { code: RPC_CODES.internal, message: error instanceof Error ? error.message : String(error) } });
      }
    }
  }

  private settle(id: number, message: Record<string, unknown>): void {
    const waiting = this.pending.get(id);
    if (waiting === undefined) return;
    this.pending.delete(id);
    if (isObject(message.error)) {
      const code = typeof message.error.code === "number" ? message.error.code : RPC_CODES.internal;
      waiting.reject(new RpcError(code, typeof message.error.message === "string" ? message.error.message : "Request failed", message.error.data));
    } else {
      waiting.resolve(message.result);
    }
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiting of this.pending.values()) waiting.reject(new Error("The connection closed before the peer answered."));
    this.pending.clear();
    this.handlers.onClose();
  }
}
