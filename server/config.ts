import { mkdirSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const MIN_FREE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_PORT = 4317;
export const DEFAULT_HOST = "127.0.0.1";

export class AtelierError extends Error {
  readonly code: string;
  readonly why: string;
  readonly fix: string;
  readonly exitCode: number;

  constructor(code: string, what: string, why: string, fix: string, exitCode = 1) {
    super(what);
    this.name = "AtelierError";
    this.code = code;
    this.why = why;
    this.fix = fix;
    this.exitCode = exitCode;
  }
}

export interface AtelierPaths {
  home: string;
  db: string;
  config: string;
  secrets: string;
  runtime: string;
  lock: string;
  token: string;
  blobs: string;
  traces: string;
  checkpoints: string;
  plans: string;
  evalDir: string;
  verifyDir: string;
  screenshots: string;
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ATELIER_HOME?.trim();
  return resolve(configured && configured.length > 0 ? configured : join(homedir(), ".atelier"));
}

export function ensureHome(home: string = resolveHome()): AtelierPaths {
  if (typeof home !== "string" || home.trim().length === 0) {
    throw new AtelierError("HOME_INVALID", "The state directory is not a path.", `Got ${typeof home === "string" ? "an empty string" : typeof home} instead of a directory path.`, "Pass a directory path or set ATELIER_HOME.");
  }
  const paths: AtelierPaths = {
    home,
    db: join(home, "atelier.db"),
    config: join(home, "config.json"),
    secrets: join(home, "secrets.json"),
    runtime: join(home, "runtime"),
    lock: join(home, "runtime", "server.lock"),
    token: join(home, "runtime", "token"),
    blobs: join(home, "blobs"),
    traces: join(home, "traces"),
    checkpoints: join(home, "checkpoints"),
    plans: join(home, "plans"),
    evalDir: join(home, "eval"),
    verifyDir: join(home, "verify"),
    screenshots: join(home, "screenshots"),
  };
  for (const directory of [
    paths.home,
    paths.runtime,
    paths.blobs,
    paths.traces,
    paths.checkpoints,
    paths.plans,
    paths.evalDir,
    paths.verifyDir,
    paths.screenshots,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  return paths;
}

export interface DiskSpace {
  ok: boolean;
  freeBytes: number | null;
  requiredBytes: number;
  unknown: boolean;
}

export function checkDiskSpace(path: string, requiredBytes = MIN_FREE_BYTES): DiskSpace {
  try {
    const stats = statfsSync(path);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return {
      ok: freeBytes >= requiredBytes,
      freeBytes,
      requiredBytes,
      unknown: false,
    };
  } catch {
    return { ok: true, freeBytes: null, requiredBytes, unknown: true };
  }
}

export function assertDiskSpace(path: string, requiredBytes = MIN_FREE_BYTES): void {
  const space = checkDiskSpace(path, requiredBytes);
  if (space.ok) return;
  throw new AtelierError(
    "ENOSPC_PREFLIGHT",
    `Not enough free space in ${path}.`,
    `At least ${Math.ceil(requiredBytes / 1024 / 1024)} MB is required; ${Math.floor((space.freeBytes ?? 0) / 1024 / 1024)} MB is free.`,
    "Free disk space, then run `atelier doctor`.",
  );
}

export function parseInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new AtelierError("USAGE", `${name} must be an integer.`, `Received '${value}'.`, `Pass ${name} a whole number.`, 2);
  }
  return parsed;
}

export function parsePort(value: string | undefined): number {
  const port = parseInteger(value, DEFAULT_PORT, "--port");
  if (port < 0 || port > 65535) {
    throw new AtelierError("USAGE", "--port must be between 0 and 65535.", `Received ${port}.`, "Pass a valid port.", 2);
  }
  return port;
}
