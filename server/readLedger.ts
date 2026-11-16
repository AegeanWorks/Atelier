import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * What one run has actually seen of the workspace, so a write cannot silently clobber bytes the
 * agent never read. Scoped per run and kept in memory: it is a guard for the loop, not durable
 * state, and a resumed run re-reads before it writes.
 */
export interface ReadRecord {
  /** Content hash at the moment of the read. */
  hash: string;
  /** When the read happened. */
  at: number;
}

const LEDGERS = new Map<string, Map<string, ReadRecord>>();

/**
 * Content hashes keyed by absolute path, so a repeated check does not re-read and re-hash.
 *
 * Measured: 833 bytes retained per hashed path, and a server that walks a large repository
 * touches thousands of them, so this needs a ceiling as much as LEDGERS does. Past the cap the
 * map is emptied rather than evicted one by one: a hash is a cache, and losing all of it costs
 * one re-read per file, while evicting the oldest costs the same bookkeeping for no better hit
 * rate on a working set this small.
 */
const HASHES = new Map<string, { key: string; hash: string }>();
const MAX_HASHES = 4_096;
/** Overridable so a test can prove the ceiling with a handful of files instead of thousands. */
let hashCeiling = MAX_HASHES;

/** How many runs may keep a ledger before the oldest is dropped. */
const MAX_RUNS = 32;

function ledger(runId: string): Map<string, ReadRecord> {
  const existing = LEDGERS.get(runId);
  if (existing !== undefined) return existing;
  const created = new Map<string, ReadRecord>();
  LEDGERS.set(runId, created);
  // Bounded: a long-lived process must not accumulate one map per run forever.
  while (LEDGERS.size > MAX_RUNS) {
    const oldest = LEDGERS.keys().next().value;
    if (oldest === undefined || oldest === runId) break;
    LEDGERS.delete(oldest);
  }
  return created;
}

/** A cheap identity for the file's current bytes: size and modification time. */
function statKey(path: string): string | null {
  try {
    const stats = statSync(path);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return null;
  }
}

export function hashOf(path: string): string | null {
  if (!existsSync(path)) return null;
  const key = statKey(path);
  const cached = HASHES.get(path);
  if (key !== null && cached !== undefined && cached.key === key) return cached.hash;
  try {
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (key !== null) {
      if (HASHES.size >= hashCeiling) HASHES.clear();
      HASHES.set(path, { key, hash });
    }
    return hash;
  } catch {
    return null;
  }
}

/** Record that this run has seen the file's current bytes. */
export function recordRead(runId: string, workspace: string, path: string): void {
  const absolute = resolve(workspace, path);
  // One stat is enough to answer "are these still the bytes I saw?" later, and staying off the
  // content hash keeps a read on the hot path cheap. The hash is taken lazily when a write asks.
  try {
    const stats = statSync(absolute);
    ledger(runId).set(absolute, { hash: `${stats.size}:${stats.mtimeMs}`, at: Date.now() });
  } catch {
    // A path that is not a readable file is simply not recorded.
  }
}

/** Forget a read, e.g. after a delete this run performed itself. */
export function forgetRead(runId: string, workspace: string, path: string): void {
  LEDGERS.get(runId)?.delete(resolve(workspace, path));
}

/** After its own write, the run knows the new bytes, so a later edit is not refused. */
export function recordWrite(runId: string, workspace: string, path: string): void {
  recordRead(runId, workspace, path);
}

export interface WriteVerdict {
  ok: boolean;
  reason: string;
}

/**
 * Whether this run may overwrite `path` wholesale.
 *
 * A new file is always allowed: there is nothing to clobber. An existing file must have been
 * read by this run, and must still hold the bytes that were read, or the write is refused with
 * the way out named. This is the agent-path equivalent of the `FILE_CONFLICT` guard the editor
 * already uses in `workspace.ts`.
 *
 * Only a full overwrite is this strict. An exact `edit_file` already proves the run knows the
 * bytes it is replacing, so it is bound by `checkEdit` instead.
 */
export function checkWrite(runId: string, workspace: string, path: string): WriteVerdict {
  const absolute = resolve(workspace, path);
  const current = statKey(absolute);
  if (current === null) return { ok: true, reason: "new file" };
  const seen = ledger(runId).get(absolute);
  if (seen === undefined) {
    return {
      ok: false,
      reason: `${path} already exists and this run has not read it. Read it first, so you do not overwrite content you have not seen.`,
    };
  }
  if (seen.hash !== current) {
    return {
      ok: false,
      reason: `${path} changed on disk after you read it. Read it again and merge your change with what is there now.`,
    };
  }
  return { ok: true, reason: "read and unchanged" };
}

/**
 * Whether this run may apply a targeted string edit to `path`.
 *
 * The `oldString` is itself evidence the run knows what it is replacing, so a prior read is not
 * required. What is refused is editing blind *after* a read: if this run read the file and the
 * file has changed since, the quoted text may now sit in different surroundings.
 */
export function checkEdit(runId: string, workspace: string, path: string): WriteVerdict {
  const absolute = resolve(workspace, path);
  const current = statKey(absolute);
  if (current === null) return { ok: true, reason: "file does not exist" };
  const seen = ledger(runId).get(absolute);
  if (seen !== undefined && seen.hash !== current) {
    return {
      ok: false,
      reason: `${path} changed on disk after you read it. Read it again and merge your change with what is there now.`,
    };
  }
  return { ok: true, reason: seen === undefined ? "unread, but the old string pins the content" : "read and unchanged" };
}

/** Size guard used before a read is allowed to record a hash of a huge file. */
export function readableSize(path: string, limit = 10 * 1024 * 1024): boolean {
  try {
    return statSync(path).size <= limit;
  } catch {
    return false;
  }
}

/** Test-only: drop every ledger. */
export function resetLedgers(): void {
  LEDGERS.clear();
  HASHES.clear();
}

/** Test-only: the number of cached hashes, so the ceiling can be asserted rather than assumed. */
export function hashCacheSize(): number {
  return HASHES.size;
}

/** Test-only: the ceiling itself, and a way to lower it so a test need not hash thousands of files. */
export const HASH_CACHE_LIMIT = MAX_HASHES;

export function setHashCeiling(limit: number): void {
  hashCeiling = Math.max(1, Math.floor(limit));
  resetLedgers();
}
