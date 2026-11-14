import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtelierError } from "../../server/config";
import { execInWorkspace } from "../../server/terminal";
import {
  createWorkspaceFile,
  deleteWorkspaceFile,
  gitCommit,
  gitDiff,
  gitStage,
  gitStatus,
  listTree,
  readWorkspaceFile,
  renameWorkspaceFile,
  writeWorkspaceFile,
} from "../../server/workspace";

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "atelier-workspace-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workspace files", () => {
  it("lists, reads, writes, creates, renames and deletes", () => {
    const root = tempWorkspace();
    writeFileSync(join(root, "hello.txt"), "hello\n", "utf8");
    createWorkspaceFile(root, "new.txt", "new");
    expect(listTree(root).some((entry) => entry.path === "hello.txt")).toBe(true);
    const file = readWorkspaceFile(root, "hello.txt");
    expect(file.content).toBe("hello\n");
    const written = writeWorkspaceFile(root, "hello.txt", "changed\n", file.hash);
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("changed\n");
    expect(() => writeWorkspaceFile(root, "hello.txt", "stale", file.hash)).toThrow(AtelierError);
    renameWorkspaceFile(root, "new.txt", "renamed.txt");
    expect(existsSync(join(root, "renamed.txt"))).toBe(true);
    deleteWorkspaceFile(root, "renamed.txt");
    expect(existsSync(join(root, "renamed.txt"))).toBe(false);
    expect(written.hash.length).toBe(64);
  });

  it("rejects traversal outside the workspace", () => {
    const root = tempWorkspace();
    expect(() => readWorkspaceFile(root, "../outside.txt")).toThrow(AtelierError);
  });
});

describe("workspace git", () => {
  it("reports, diffs, stages and commits", () => {
    const root = tempWorkspace();
    spawnSync("git", ["init"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
    writeFileSync(join(root, "app.txt"), "one\n", "utf8");
    spawnSync("git", ["add", "app.txt"], { cwd: root });
    spawnSync("git", ["commit", "-m", "init"], { cwd: root });

    writeFileSync(join(root, "app.txt"), "two\n", "utf8");
    const status = gitStatus(root);
    expect(status.changes.some((change) => change.path === "app.txt")).toBe(true);
    expect(gitDiff(root, "app.txt")).toContain("-one");
    gitStage(root, "app.txt");
    const output = gitCommit(root, "feat: change app");
    expect(output.length).toBeGreaterThan(0);
    expect(gitStatus(root).changes).toHaveLength(0);
  });
});

describe("terminal", () => {
  it("runs a command in the workspace with an exit code", async () => {
    const root = tempWorkspace();
    const result = await execInWorkspace(root, `node -e "console.log('hi')"`);
    expect(result.output).toContain("hi");
    expect(result.exitCode).toBe(0);
  });
});
