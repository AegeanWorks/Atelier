import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtelierError } from "../../server/config";
import { checkpointPath, listCheckpoints, restoreCheckpoint, restoreDirectory } from "../../server/checkpoints";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("shadow-git checkpoints", () => {
  it("snapshots and restores a file before an edit", () => {
    const home = tempDir("atelier-checkpoint-home-");
    const workspace = tempDir("atelier-checkpoint-ws-");
    writeFileSync(join(workspace, "a.txt"), "original\n");
    const checkpoint = checkpointPath(workspace, "a.txt", "test", home);
    expect(checkpoint?.commit).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(workspace, "a.txt"), "changed\n");
    const entries = listCheckpoints(workspace, 20, home);
    expect(entries[0]?.path).toBe("a.txt");
    restoreCheckpoint(workspace, checkpoint?.commit ?? "", "a.txt", home);
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("original\n");
  });

  it("restores a deleted file", () => {
    const home = tempDir("atelier-checkpoint-home-");
    const workspace = tempDir("atelier-checkpoint-ws-");
    writeFileSync(join(workspace, "gone.txt"), "keep\n");
    const checkpoint = checkpointPath(workspace, "gone.txt", "delete test", home);
    rmSync(join(workspace, "gone.txt"));
    restoreCheckpoint(workspace, checkpoint?.commit ?? "", "gone.txt", home);
    expect(readFileSync(join(workspace, "gone.txt"), "utf8")).toBe("keep\n");
  });

  it("restores only the latest checkpoint under a directory prefix", () => {
    const home = tempDir("atelier-checkpoint-home-");
    const workspace = tempDir("atelier-checkpoint-ws-");
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "a.txt"), "a0\n");
    writeFileSync(join(workspace, "src", "b.txt"), "b0\n");
    writeFileSync(join(workspace, "other.txt"), "o0\n");
    checkpointPath(workspace, "src/a.txt", "test", home);
    checkpointPath(workspace, "src/b.txt", "test", home);
    checkpointPath(workspace, "other.txt", "test", home);
    writeFileSync(join(workspace, "src", "a.txt"), "a1\n");
    writeFileSync(join(workspace, "src", "b.txt"), "b1\n");
    writeFileSync(join(workspace, "other.txt"), "o1\n");

    const scoped = restoreDirectory(workspace, "src", home);
    expect(scoped.restored).toBe(2);
    expect(readFileSync(join(workspace, "src", "a.txt"), "utf8")).toBe("a0\n");
    expect(readFileSync(join(workspace, "src", "b.txt"), "utf8")).toBe("b0\n");
    expect(readFileSync(join(workspace, "other.txt"), "utf8")).toBe("o1\n");

    const root = restoreDirectory(workspace, "", home);
    expect(root.restored).toBe(3);
    expect(readFileSync(join(workspace, "other.txt"), "utf8")).toBe("o0\n");
  });

  it("recreates a deleted subtree from its checkpoints", () => {
    const home = tempDir("atelier-checkpoint-home-");
    const workspace = tempDir("atelier-checkpoint-ws-");
    mkdirSync(join(workspace, "deep", "nested"), { recursive: true });
    writeFileSync(join(workspace, "deep", "nested", "c.txt"), "c0\n");
    checkpointPath(workspace, "deep/nested/c.txt", "test", home);
    rmSync(join(workspace, "deep"), { recursive: true, force: true });
    const result = restoreDirectory(workspace, "deep", home);
    expect(result.restored).toBe(1);
    expect(readFileSync(join(workspace, "deep", "nested", "c.txt"), "utf8")).toBe("c0\n");
  });

  it("refuses a directory outside the workspace or inside .git", () => {
    const home = tempDir("atelier-checkpoint-home-");
    const workspace = tempDir("atelier-checkpoint-ws-");
    expect(() => restoreDirectory(workspace, "../outside", home)).toThrow(AtelierError);
    expect(() => restoreDirectory(workspace, ".git", home)).toThrow(AtelierError);
  });

  it("undo twice is undo then redo: the newest checkpoint after a restore holds the state it replaced", () => {
    const home = tempDir("atelier-checkpoint-home-");
    const workspace = tempDir("atelier-checkpoint-ws-");
    const file = join(workspace, "a.txt");
    writeFileSync(file, "before\n");
    checkpointPath(workspace, "a.txt", "edit_file", home);
    writeFileSync(file, "after\n");
    // what /undo does: restore the newest entry
    const first = listCheckpoints(workspace, 20, home)[0];
    restoreCheckpoint(workspace, first?.commit ?? "", first?.path ?? "", home);
    expect(readFileSync(file, "utf8")).toBe("before\n");
    // run /undo again: the newest entry is the snapshot taken just before that restore
    const second = listCheckpoints(workspace, 20, home)[0];
    expect(second?.commit).not.toBe(first?.commit);
    restoreCheckpoint(workspace, second?.commit ?? "", second?.path ?? "", home);
    expect(readFileSync(file, "utf8")).toBe("after\n");
  });
});
