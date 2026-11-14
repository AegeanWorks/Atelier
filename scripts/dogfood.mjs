#!/usr/bin/env node
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchJson,
  readToken,
  startServer,
  stopServer,
  tokenPath,
  waitFor,
} from "./runtime.mjs";

const home = mkdtempSync(join(tmpdir(), "atelier-dogfood-"));
let server;
try {
  server = startServer({ home, port: 0 });
  const base = await server.url;
  await waitFor(() => existsSync(tokenPath(home)));
  const token = readToken(home);

  const boot = await fetchJson(base, token, "/api/boot");
  const created = await fetchJson(base, token, "/api/sessions", {
    method: "POST",
    body: JSON.stringify({ title: "Dogfood" }),
  });
  const sent = await fetchJson(base, token, `/api/sessions/${created.session.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: "read fixture/app.py and fix it", clientId: "dogfood-1" }),
  });
  const messages = await fetchJson(base, token, `/api/sessions/${created.session.id}/messages`);
  if (messages.messages.length !== 1 || sent.message.id !== messages.messages[0]?.id) {
    throw new Error("message round-trip did not match");
  }

  await stopServer(server.child);
  server = startServer({ home, port: 0 });
  const restarted = await server.url;
  const token2 = readToken(home);
  const boot2 = await fetchJson(restarted, token2, "/api/boot");
  if (!boot2.sessions.some((session) => session.id === created.session.id)) {
    throw new Error("session did not survive the restart");
  }

  const db = new Database(join(home, "atelier.db"), { readonly: true });
  const check = String(db.pragma("quick_check", { simple: true }));
  db.close();
  if (check !== "ok") throw new Error(`quick_check failed: ${check}`);

  console.log(`SEED: 1`);
  console.log(`SESSION: ${created.session.id}`);
  console.log(`WORLD-DELTA: sessions=${boot.sessions.length}->${boot2.sessions.length}`);
  console.log(`WORLD-DELTA: messages=0->${messages.messages.length}`);
  console.log("OK: dogfood complete (create, message, kill, restart, recover)");
  process.exitCode = 0;
} catch (error) {
  console.error("What: atelier dogfood failed.");
  console.error(`Why: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Fix: run `npm run dev`, then retry; the full server output is above.");
  process.exitCode = 1;
} finally {
  if (server) await stopServer(server.child);
  rmSync(home, { recursive: true, force: true });
}
