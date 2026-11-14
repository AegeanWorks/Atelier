#!/usr/bin/env node
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchJson, readToken, startServer, stopServer, tokenPath, waitFor } from "./runtime.mjs";

const home = mkdtempSync(join(tmpdir(), "atelier-crash-"));
let server;
const lines = [];
try {
  server = startServer({ home, port: 0 });
  const base = await server.url;
  await waitFor(() => existsSync(tokenPath(home)));
  const token = readToken(home);
  const created = await fetchJson(base, token, "/api/sessions", {
    method: "POST",
    body: JSON.stringify({ title: "Crash" }),
  });
  await fetchJson(base, token, `/api/sessions/${created.session.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: "must survive", clientId: "crash-1" }),
  });
  await stopServer(server.child);
  lines.push("PASS kill: server terminated mid-session");

  server = startServer({ home, port: 0 });
  const restarted = await server.url;
  const token2 = readToken(home);
  const messages = await fetchJson(restarted, token2, `/api/sessions/${created.session.id}/messages`);
  if (messages.messages.length !== 1) throw new Error("message was lost after restart");
  lines.push("PASS recover: session and message survived");

  const db = new Database(join(home, "atelier.db"), { readonly: true });
  const check = String(db.pragma("quick_check", { simple: true }));
  db.close();
  if (check !== "ok") throw new Error(`quick_check failed: ${check}`);
  lines.push("PASS integrity: quick_check ok");
  lines.push("OK: crash test complete");
  console.log(lines.join("\n"));
  process.exitCode = 0;
} catch (error) {
  console.error("What: atelier crash test failed.");
  console.error(`Why: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Fix: inspect the server output and `atelier doctor`.");
  process.exitCode = 1;
} finally {
  if (server) await stopServer(server.child);
  rmSync(home, { recursive: true, force: true });
}
