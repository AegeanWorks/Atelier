import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addWorktree, listWorktrees, removeWorktree } from "../../server/worktrees";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(root: string, args: string[]): void {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("git worktrees", () => {
  it("adds, lists and removes a worktree under the atelier home", () => {
    const root = tempDir("atelier-worktree-repo-");
    const home = tempDir("atelier-worktree-home-");
    git(root, ["init"]);
    git(root, ["config", "user.name", "test"]);
    git(root, ["config", "user.email", "test@example.com"]);
    writeFileSync(join(root, "README.md"), "hello\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "init"]);
    const added = addWorktree(root, "feature", home);
    expect(added.worktree.path).toContain("worktrees");
    expect(existsSync(join(added.worktree.path, "README.md"))).toBe(true);
    expect(listWorktrees(root).some((entry) => entry.path === added.worktree.path)).toBe(true);
    removeWorktree(root, added.worktree.path, home);
    expect(existsSync(added.worktree.path)).toBe(false);
    expect(listWorktrees(root)).toHaveLength(1);
  });
});
