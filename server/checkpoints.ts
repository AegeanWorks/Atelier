import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { AtelierError, ensureHome } from "./config.js";

export interface CheckpointEntry {
  commit: string;
  createdAt: number;
  message: string;
  path: string;
}

const SKIP = new Set(["node_modules", ".git", "dist", "dist-server", "coverage", ".atelier"]);
const META = "checkpoints.jsonl";

function inside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

function shadowDir(workspace: string, home: string): string {
  const hash = createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 16);
  const directory = join(home, "checkpoints", hash);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function safePath(workspace: string, path: string): string {
  const absolute = resolve(workspace, path);
  if (!inside(workspace, absolute)) throw new AtelierError("CHECKPOINT_PATH", "Checkpoint path escapes the workspace.", path, "Use a repository-relative path.");
  const rel = relative(workspace, absolute).split(/[\\/]/);
  if (rel.includes(".git")) throw new AtelierError("CHECKPOINT_PATH", "Checkpoint path targets .git.", path, "Do not checkpoint git internals.");
  if (rel.some((part) => SKIP.has(part))) return "";
  return relative(workspace, absolute).split("\\").join("/");
}

function writeObject(directory: string, content: string): string {
  const body = Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(content)}\0`), Buffer.from(content)]);
  const hash = createHash("sha1").update(body).digest("hex");
  const path = join(directory, "objects", hash.slice(0, 2), hash.slice(2));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, deflateSync(body));
  return hash;
}

function readObject(directory: string, hash: string): string {
  const path = join(directory, "objects", hash.slice(0, 2), hash.slice(2));
  if (!existsSync(path)) throw new AtelierError("CHECKPOINT_MISSING", "Checkpoint object is missing.", hash, "Use an object from the checkpoint list.");
  const body = inflateSync(readFileSync(path));
  const nul = body.indexOf(0);
  if (nul < 0) throw new AtelierError("CHECKPOINT_CORRUPT", "Checkpoint object is malformed.", hash, "Delete the shadow checkpoint store.");
  return body.subarray(nul + 1).toString("utf8");
}

function writeAtomic(path: string, content: string): void {
  const temp = `${path}.tmp_${process.pid}_${Date.now()}`;
  const fd = openSync(temp, "w");
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }
}

export function checkpointPath(workspace: string, path: string, reason: string, home = ensureHome().home): CheckpointEntry | null {
  const relativePath = safePath(workspace, path);
  if (relativePath.length === 0) return null;
  if (!existsSync(resolve(workspace, relativePath))) return null;
  const directory = shadowDir(workspace, home);
  const content = readFileSync(resolve(workspace, relativePath), "utf8");
  const commit = writeObject(directory, content);
  const entry: CheckpointEntry = {
    commit,
    createdAt: Date.now(),
    message: `atelier-checkpoint ${reason.replace(/\s+/g, " ").slice(0, 120)} ${relativePath}`,
    path: relativePath,
  };
  appendFileSync(join(directory, META), `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export function listCheckpoints(workspace: string, limit = 20, home = ensureHome().home): CheckpointEntry[] {
  const file = join(shadowDir(workspace, home), META);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line) as CheckpointEntry;
        return typeof entry.commit === "string" && typeof entry.path === "string" ? [entry] : [];
      } catch {
        return [];
      }
    })
    .slice(-limit)
    .reverse();
}

function safeDirectory(workspace: string, path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (normalized.length === 0 || normalized === ".") return "";
  const absolute = resolve(workspace, normalized);
  if (!inside(workspace, absolute)) throw new AtelierError("CHECKPOINT_PATH", "Checkpoint path escapes the workspace.", path, "Use a repository-relative path.");
  const rel = relative(workspace, absolute).split(/[\\/]/);
  if (rel.includes(".git")) throw new AtelierError("CHECKPOINT_PATH", "Checkpoint path targets .git.", path, "Do not checkpoint git internals.");
  if (rel.some((part) => SKIP.has(part))) throw new AtelierError("CHECKPOINT_PATH", "Checkpoint path is excluded.", path, "Use a tracked workspace directory.");
  return rel.join("/");
}

export interface RestoreDirectoryResult {
  directory: string;
  restored: number;
  paths: string[];
}

export function restoreDirectory(workspace: string, directory: string, home = ensureHome().home): RestoreDirectoryResult {
  const prefix = safeDirectory(workspace, directory);
  const latest = new Map<string, CheckpointEntry>();
  for (const entry of listCheckpoints(workspace, Number.MAX_SAFE_INTEGER, home)) {
    if (prefix.length > 0 && !entry.path.startsWith(`${prefix}/`)) continue;
    if (!latest.has(entry.path)) latest.set(entry.path, entry);
  }
  const store = shadowDir(workspace, home);
  const plan = [...latest.values()].map((entry) => ({ entry, content: readObject(store, entry.commit) }));
  const paths: string[] = [];
  for (const { entry, content } of plan) {
    checkpointPath(workspace, entry.path, "pre-restore", home);
    mkdirSync(dirname(resolve(workspace, entry.path)), { recursive: true });
    writeAtomic(resolve(workspace, entry.path), content);
    paths.push(entry.path);
  }
  return { directory: prefix, restored: paths.length, paths };
}

export function restoreCheckpoint(workspace: string, commit: string, path: string, home = ensureHome().home): CheckpointEntry {
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new AtelierError("CHECKPOINT_COMMIT", "Invalid checkpoint object.", commit, "Use the full hash from the checkpoint list.");
  const relativePath = safePath(workspace, path);
  if (relativePath.length === 0) throw new AtelierError("CHECKPOINT_PATH", "Invalid checkpoint path.", path, "Use a repository-relative path.");
  const directory = shadowDir(workspace, home);
  checkpointPath(workspace, relativePath, "pre-restore", home);
  writeAtomic(resolve(workspace, relativePath), readObject(directory, commit));
  return { commit, createdAt: Date.now(), message: `restored ${relativePath}`, path: relativePath };
}
