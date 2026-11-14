#!/usr/bin/env node
import { atelierHome, fetchJson, readToken } from "./runtime.mjs";

const port = Number(process.env.ATELIER_PORT ?? 4317);
const base = `http://127.0.0.1:${port}`;
try {
  const token = readToken(atelierHome());
  const health = await fetchJson(base, token, "/api/health");
  console.log(JSON.stringify(health, null, 2));
  process.exit(health.ok === true ? 0 : 1);
} catch (error) {
  console.error(`What: atelier health check failed.`);
  console.error(`Why: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Fix: start atelier with `npm run dev` or `npm start`, then retry.");
  process.exit(1);
}
