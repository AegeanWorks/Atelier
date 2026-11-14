#!/usr/bin/env node
import { spawn } from "node:child_process";
import { ROOT, VITE, delay, startServer, stopServer } from "./runtime.mjs";

const server = startServer({ port: Number(process.env.ATELIER_PORT ?? 4317) });
const vite = spawn(process.execPath, [VITE, "--host", "127.0.0.1", "--port", "5173"], {
  cwd: ROOT,
  stdio: "inherit",
});

let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await stopServer(server.child);
  vite.kill();
  await delay(100);
  process.exit(code);
}

server.url
  .then((url) => {
    console.log(`atelier API ${url}`);
    console.log("atelier UI  http://127.0.0.1:5173/ (or the next free port)");
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    void stop(1);
  });

server.child.on("exit", (code) => {
  if (!stopping) {
    console.error(`atelier API exited with ${code}`);
    void stop(code ?? 1);
  }
});
vite.on("exit", (code) => {
  if (!stopping) {
    console.error(`vite exited with ${code}`);
    void stop(code ?? 1);
  }
});

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
