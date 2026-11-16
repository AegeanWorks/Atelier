import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHome } from "../../server/config";
import { createSession, openDatabase } from "../../server/db";
import { createRun } from "../../server/runs";
import { executeTool } from "../../server/tools";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function workspace(files: Record<string, string>): string {
  const dir = tempDir("atelier-search-ws-");
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("workspace search and editing tools", () => {
  it("finds text with the built-in search even when ripgrep is unavailable", async () => {
    const dir = workspace({
      "src/a.ts": "export const needle = 1;\n",
      "src/b.ts": "export const NEEdle = 2;\n",
      "node_modules/dep/index.js": "needle should be skipped\n",
    });
    const paths = ensureHome(tempDir("atelier-search-home-"));
    const db = openDatabase(paths);
    try {
      const run = createRun(db, createSession(db, "Search").id, null, null, dir);
      const result = await executeTool(db, run, "build", { id: "s1", name: "ripgrep", input: { query: "needle", fixed: true } });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("src/a.ts:1:");
      expect(result.output).not.toContain("src/b.ts");
      expect(result.output).not.toContain("node_modules");
      const insensitive = await executeTool(db, run, "build", { id: "s2", name: "ripgrep", input: { query: "needle", fixed: true, ignoreCase: true } });
      expect(insensitive.ok).toBe(true);
      expect(insensitive.output).toContain("src/b.ts:1:");
    } finally {
      db.close();
    }
  });

  it("filters by glob and reports an invalid pattern cleanly", async () => {
    const dir = workspace({ "src/a.ts": "alpha\n", "src/a.test.ts": "alpha\n", "docs/readme.md": "alpha\n" });
    const paths = ensureHome(tempDir("atelier-search-home-"));
    const db = openDatabase(paths);
    try {
      const run = createRun(db, createSession(db, "Glob").id, null, null, dir);
      const globbed = await executeTool(db, run, "build", { id: "g1", name: "glob", input: { pattern: "src/**/*.ts" } });
      expect(globbed.output.split("\n").sort()).toEqual(["src/a.test.ts", "src/a.ts"]);
      const included = await executeTool(db, run, "build", { id: "s3", name: "ripgrep", input: { query: "alpha", include: "src/**/*.test.ts" } });
      expect(included.output).toContain("src/a.test.ts");
      expect(included.output).not.toContain("docs/readme.md");
      const invalid = await executeTool(db, run, "build", { id: "s4", name: "ripgrep", input: { query: "(" } });
      expect(invalid.ok).toBe(false);
      expect(invalid.output).toContain("invalid");
    } finally {
      db.close();
    }
  });

  it("replaces every occurrence only with replaceAll", async () => {
    const dir = workspace({ "count.txt": "one one one\n" });
    const paths = ensureHome(tempDir("atelier-edit-home-"));
    const db = openDatabase(paths);
    try {
      const run = createRun(db, createSession(db, "Edit").id, null, null, dir);
      // The read ledger requires a file to be read before this run edits it.
      await executeTool(db, run, "build", { id: "r1", name: "read_file", input: { path: "count.txt" } });
      const ambiguous = await executeTool(db, run, "build", { id: "e1", name: "edit_file", input: { path: "count.txt", oldString: "one", newString: "two" } });
      expect(ambiguous.ok).toBe(false);
      expect(ambiguous.output).toContain("exactly one match");
      const all = await executeTool(db, run, "build", { id: "e2", name: "edit_file", input: { path: "count.txt", oldString: "one", newString: "two", replaceAll: true } });
      expect(all.ok).toBe(true);
      expect(all.output).toContain("3 replacement(s)");
      expect(readFileSync(join(dir, "count.txt"), "utf8")).toBe("two two two\n");
    } finally {
      db.close();
    }
  });

  it("applies multi_edit atomically and writes nothing on failure", async () => {
    const dir = workspace({ "multi.txt": "alpha beta gamma\n" });
    const paths = ensureHome(tempDir("atelier-multi-home-"));
    const db = openDatabase(paths);
    try {
      const run = createRun(db, createSession(db, "Multi").id, null, null, dir);
      await executeTool(db, run, "build", { id: "r1", name: "read_file", input: { path: "multi.txt" } });
      const ok = await executeTool(db, run, "build", {
        id: "m1",
        name: "multi_edit",
        input: { path: "multi.txt", edits: [{ oldString: "alpha", newString: "ALPHA" }, { oldString: "gamma", newString: "GAMMA" }] },
      });
      expect(ok.ok).toBe(true);
      expect(readFileSync(join(dir, "multi.txt"), "utf8")).toBe("ALPHA beta GAMMA\n");
      const failing = await executeTool(db, run, "build", {
        id: "m2",
        name: "multi_edit",
        input: { path: "multi.txt", edits: [{ oldString: "ALPHA", newString: "x" }, { oldString: "missing", newString: "y" }] },
      });
      expect(failing.ok).toBe(false);
      expect(failing.output).toContain("Edit 2");
      expect(readFileSync(join(dir, "multi.txt"), "utf8")).toBe("ALPHA beta GAMMA\n");
    } finally {
      db.close();
    }
  });

  it("honours an explicit bash timeout", async () => {
    const dir = workspace({ "notes.txt": "ok\n" });
    const paths = ensureHome(tempDir("atelier-bash-home-"));
    const db = openDatabase(paths);
    try {
      const run = createRun(db, createSession(db, "Bash").id, null, null, dir);
      const command = process.platform === "win32" ? "ping -n 6 127.0.0.1 >nul" : "sleep 5";
      const started = Date.now();
      const result = await executeTool(db, run, "build", { id: "b1", name: "bash", input: { command, timeoutMs: 1000 } });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("timed out after 1000 ms");
      expect(Date.now() - started).toBeLessThan(4500);
    } finally {
      db.close();
    }
  });
});
