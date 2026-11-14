import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { AtelierError, ensureHome } from "./config.js";

export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
}

function git(root: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 15_000, maxBuffer: 1_000_000, windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path).toLowerCase();
  } catch {
    return resolve(path).toLowerCase();
  }
}

function base(root: string, home: string): string {
  const hash = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
  return join(home, "worktrees", hash);
}

export function listWorktrees(root: string): WorktreeEntry[] {
  const result = git(root, ["worktree", "list", "--porcelain"]);
  if (result.status !== 0) throw new AtelierError("WORKTREE_LIST", "Could not list worktrees.", result.stderr.slice(0, 400), "Check that the workspace is a git repository.");
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) current = { path: line.slice("worktree ".length), head: "", branch: null, detached: false };
    else if (line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (line.startsWith("branch ")) current.branch = line.slice("branch refs/heads/".length);
    else if (line === "detached") current.detached = true;
    else if (line.length === 0 && current.path !== undefined) {
      entries.push({ path: current.path, head: current.head ?? "", branch: current.branch ?? null, detached: current.detached ?? false });
      current = {};
    }
  }
  if (current.path !== undefined) entries.push({ path: current.path, head: current.head ?? "", branch: current.branch ?? null, detached: current.detached ?? false });
  return entries;
}

export function addWorktree(root: string, name: string, home = ensureHome().home, branch?: string): { worktree: WorktreeEntry; output: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(name)) throw new AtelierError("WORKTREE_NAME", "Invalid worktree name.", name, "Use letters, digits, dot, underscore or dash.");
  const directory = base(root, home);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  if (existsSync(path)) throw new AtelierError("WORKTREE_EXISTS", "Worktree path already exists.", path, "Choose another name or remove it.");
  const branchName = branch ?? `worktree-${name}`;
  const result = git(root, ["worktree", "add", "-b", branchName, path]);
  if (result.status !== 0) throw new AtelierError("WORKTREE_ADD", "Could not add a worktree.", result.stderr.slice(0, 400), "Check the branch name and repository state.");
  const worktree = listWorktrees(root).find((entry) => canonical(entry.path) === canonical(path));
  if (worktree === undefined) throw new AtelierError("WORKTREE_ADD", "Worktree was added but not listed.", path, "Refresh the worktree list.");
  return { worktree, output: result.stdout };
}

export function removeWorktree(root: string, path: string, home = ensureHome().home): void {
  const directory = base(root, home);
  if (!canonical(path).startsWith(`${canonical(directory)}${sep}`)) throw new AtelierError("WORKTREE_PATH", "Refusing to remove a path outside the atelier worktree root.", path, "Use a path from the worktree list.");
  const result = git(root, ["worktree", "remove", "--force", path]);
  if (result.status !== 0) throw new AtelierError("WORKTREE_REMOVE", "Could not remove a worktree.", result.stderr.slice(0, 400), "Check the worktree path.");
  git(root, ["worktree", "prune"]);
}
