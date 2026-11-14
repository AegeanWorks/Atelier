import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { AtelierError } from "./config.js";
import { atomicWrite, hashFile, resolveInside } from "./tools.js";
import { checkpointPath } from "./checkpoints.js";

const SKIP = new Set(["node_modules", ".git", "dist", "dist-server", "coverage", "shots", ".atelier"]);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

export interface WorkspaceFile {
  path: string;
  content: string;
  hash: string;
  size: number;
}

export function listTree(root: string, path = ".", depth = 2): TreeEntry[] {
  const base = resolveInside(root, path);
  const entries: TreeEntry[] = [];
  const walk = (directory: string, level: number): void => {
    if (level > depth || entries.length >= 500) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.name.startsWith(".tmp_")) continue;
      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute).split("\\").join("/");
      if (entry.isDirectory()) {
        entries.push({ name: entry.name, path: rel, type: "directory" });
        walk(absolute, level + 1);
      } else {
        entries.push({ name: entry.name, path: rel, type: "file", size: statSync(absolute).size });
      }
      if (entries.length >= 500) return;
    }
  };
  walk(base, 1);
  return entries.sort((left, right) => (left.type === right.type ? left.path.localeCompare(right.path) : left.type === "directory" ? -1 : 1));
}

/** Relative file paths for the @-mention picker; skips heavy directories and stops at `limit`. */
export function listWorkspaceFiles(root: string, limit = 5000): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      if (SKIP.has(entry.name) || entry.name.startsWith(".tmp_")) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(relative(root, absolute).split("\\").join("/"));
    }
  };
  walk(root);
  return files;
}

export function readWorkspaceFile(root: string, path: string): WorkspaceFile {
  const absolute = resolveInside(root, path);
  if (!existsSync(absolute)) throw new AtelierError("FILE_MISSING", `File not found: ${path}.`, "The path does not exist.", "Refresh the tree.");
  const stat = statSync(absolute);
  if (!stat.isFile()) throw new AtelierError("FILE_TYPE", `${path} is not a file.`, "Directories cannot be opened as text.", "Choose a file.");
  if (stat.size > MAX_FILE_BYTES) throw new AtelierError("FILE_LARGE", `${path} is too large to open.`, `${stat.size} bytes exceeds ${MAX_FILE_BYTES}.`, "Use a terminal or an external viewer.");
  const content = readFileSync(absolute, "utf8");
  return { path, content, hash: hashFile(absolute) ?? "", size: stat.size };
}

export function writeWorkspaceFile(root: string, path: string, content: string, expectedHash?: string, home?: string): WorkspaceFile {
  const absolute = resolveInside(root, path);
  const current = hashFile(absolute);
  if (expectedHash !== undefined && current !== expectedHash) {
    throw new AtelierError("FILE_CONFLICT", `${path} changed on disk.`, "The hash no longer matches the editor buffer.", "Reload the file and merge your changes.");
  }
  checkpointPath(root, path, "workspace write", home);
  atomicWrite(absolute, content);
  return { path, content, hash: hashFile(absolute) ?? "", size: Buffer.byteLength(content, "utf8") };
}

export function createWorkspaceFile(root: string, path: string, content = ""): WorkspaceFile {
  const absolute = resolveInside(root, path);
  if (existsSync(absolute)) throw new AtelierError("FILE_EXISTS", `${path} already exists.`, "Create a different path or open the existing file.", "Choose another name.");
  atomicWrite(absolute, content);
  return { path, content, hash: hashFile(absolute) ?? "", size: Buffer.byteLength(content, "utf8") };
}

export function deleteWorkspaceFile(root: string, path: string, home?: string): void {
  const absolute = resolveInside(root, path);
  if (!existsSync(absolute)) throw new AtelierError("FILE_MISSING", `${path} does not exist.`, "Nothing to delete.", "Refresh the tree.");
  checkpointPath(root, path, "workspace delete", home);
  unlinkSync(absolute);
}

export function renameWorkspaceFile(root: string, from: string, to: string, home?: string): void {
  const source = resolveInside(root, from);
  const target = resolveInside(root, to);
  if (!existsSync(source)) throw new AtelierError("FILE_MISSING", `${from} does not exist.`, "Nothing to rename.", "Refresh the tree.");
  if (existsSync(target)) throw new AtelierError("FILE_EXISTS", `${to} already exists.`, "The target path is occupied.", "Choose another name.");
  checkpointPath(root, from, "workspace rename", home);
  renameSync(source, target);
}

export function searchWorkspace(root: string, query: string): string {
  if (query.trim().length === 0) return "";
  const result = spawnSync("rg", ["-n", "--max-count", "50", query, root], { encoding: "utf8", timeout: 10_000, maxBuffer: 1_000_000 });
  if (result.status === 1) return "";
  if (result.status !== 0) throw new AtelierError("SEARCH_FAILED", "Workspace search failed.", (result.stderr ?? "").slice(0, 400), "Narrow the query.");
  return result.stdout;
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 1_000_000 });
  if (result.status !== 0) throw new AtelierError("GIT_FAILED", `git ${args[0]} failed.`, (result.stderr ?? "").slice(0, 400), "Check that the workspace is a git repository.");
  return result.stdout;
}

export interface GitChange {
  status: string;
  index: string;
  worktree: string;
  path: string;
}

export function gitStatus(root: string): { raw: string; branch: string; changes: GitChange[] } {
  const raw = git(root, ["status", "--porcelain=v1", "-b"]);
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const branch = lines[0]?.replace(/^##\s*/, "") ?? "unknown";
  const changes = lines.slice(1).map((line) => ({
    status: line.slice(0, 2).trim(),
    index: line[0] ?? " ",
    worktree: line[1] ?? " ",
    path: line.slice(3),
  }));
  return { raw, branch, changes };
}

export function gitDiff(root: string, path?: string, staged = false): string {
  const args = ["diff", "-U3"];
  if (staged) args.push("--cached");
  if (path !== undefined) args.push("--", path);
  return git(root, args);
}

export function gitStage(root: string, path: string): void {
  git(root, ["add", "--", path]);
}

export function gitUnstage(root: string, path: string): void {
  git(root, ["restore", "--staged", "--", path]);
}

export function gitCommit(root: string, message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) throw new AtelierError("COMMIT_MESSAGE", "Commit message is empty.", "A commit needs a subject.", "Write a message and retry.");
  return git(root, ["commit", "-m", trimmed]);
}

export function gitLog(root: string, limit = 20): string {
  return git(root, ["log", "--oneline", "-n", String(limit)]);
}
