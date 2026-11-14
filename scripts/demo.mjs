#!/usr/bin/env node
import { atelierHome, fetchJson, readToken } from "./runtime.mjs";

const port = Number(process.env.ATELIER_PORT ?? 4317);
const base = `http://127.0.0.1:${port}`;
try {
  const token = readToken(atelierHome());
  const boot = await fetchJson(base, token, "/api/boot");
  const created = await fetchJson(base, token, "/api/sessions", {
    method: "POST",
    body: JSON.stringify({ title: "Scripted demo" }),
  });
  const message = await fetchJson(base, token, `/api/sessions/${created.session.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: "hello from the scripted demo", clientId: "demo-1" }),
  });
  const messages = await fetchJson(base, token, `/api/sessions/${created.session.id}/messages`);
  console.log(`SEED: 1`);
  console.log(`WORLD-DELTA: session=${boot.sessions.length}->${boot.sessions.length + 1}`);
  console.log(`WORLD-DELTA: messages=0->${messages.messages.length}`);
  console.log(`OK: scripted demo complete (${message.message.id})`);
  process.exit(0);
} catch (error) {
  console.error("What: the scripted demo failed.");
  console.error(`Why: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Fix: start atelier, then run `npm run demo`.");
  process.exit(1);
}
