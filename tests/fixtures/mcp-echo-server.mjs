#!/usr/bin/env node
let buffer = "";
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "echo-fixture", version: "1.0.0" } } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: "Echoes text back.", inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } }] } });
    } else if (message.method === "tools/call") {
      const text = String(message.params?.arguments?.text ?? "");
      if (text === "__die__") process.exit(0);
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `echo:${text}` }], isError: text === "fail" } });
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
    }
  }
});
