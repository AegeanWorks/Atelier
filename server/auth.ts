import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import type { Context, MiddlewareHandler, Next } from "hono";
import { getCookie } from "hono/cookie";
import { AtelierError, type AtelierPaths } from "./config.js";

export interface AuthConfig {
  token: string;
  csrf: string;
}

export function loadOrCreateToken(paths: AtelierPaths): string {
  try {
    const existing = readFileSync(paths.token, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // Missing token is the first-run path.
  }
  const token = randomBytes(32).toString("hex");
  try {
    const fd = openSync(paths.token, "wx", 0o600);
    try {
      writeSync(fd, token);
    } finally {
      closeSync(fd);
    }
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = readFileSync(paths.token, "utf8").trim();
      if (existing.length >= 32) return existing;
    }
    throw new AtelierError(
      "TOKEN_WRITE",
      `Could not write the runtime token at ${paths.token}.`,
      error instanceof Error ? error.message : String(error),
      "Check permissions on the atelier home directory, then retry.",
    );
  }
}

export function createAuth(paths: AtelierPaths): AuthConfig {
  return { token: loadOrCreateToken(paths), csrf: randomBytes(24).toString("hex") };
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearer(c: Context): string | null {
  const header = c.req.header("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim();
}

export type AuthMode = "bearer" | "cookie";

export function requireAuth(auth: AuthConfig): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const mode: AuthMode | null = sameSecret(bearer(c) ?? "", auth.token)
      ? "bearer"
      : sameSecret(getCookie(c, "atelier_session") ?? "", auth.token)
        ? "cookie"
        : null;
    if (mode === null) {
      return c.json({ error: { code: "UNAUTHORIZED", what: "Missing or invalid atelier token." } }, 401);
    }
    const method = c.req.method.toUpperCase();
    if (mode === "cookie" && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      const header = c.req.header("x-atelier-csrf") ?? "";
      const cookie = getCookie(c, "atelier_csrf") ?? "";
      if (!sameSecret(header, cookie) || cookie.length === 0) {
        return c.json({ error: { code: "CSRF", what: "Missing or invalid CSRF token." } }, 403);
      }
    }
    c.set("authMode", mode);
    await next();
  };
}

export function isAuthorized(auth: AuthConfig, header: string | undefined): boolean {
  if (!header?.toLowerCase().startsWith("bearer ")) return false;
  return sameSecret(header.slice(7).trim(), auth.token);
}
