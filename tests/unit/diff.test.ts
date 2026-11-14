import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffLines, renderDiff } from "../../server/diff";
import { previewEdit } from "../../server/editPreview";

const dirs: string[] = [];

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "atelier-diff-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("unified diff", () => {
  it("counts additions and removals for a replacement", () => {
    const diff = diffLines("a\nb\nc\n", "a\nB\nc\n");
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.lines.filter((line) => line.kind === "context").map((line) => line.text)).toEqual(["a", "c"]);
  });

  it("reports nothing for identical text", () => {
    const diff = diffLines("same\ntext\n", "same\ntext\n");
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.lines.every((line) => line.kind === "context")).toBe(true);
  });

  it("renders headers and signs", () => {
    const text = renderDiff("src/a.ts", diffLines("one\n", "two\n"));
    expect(text).toContain("--- a/src/a.ts");
    expect(text).toContain("+++ b/src/a.ts");
    expect(text).toContain("-one");
    expect(text).toContain("+two");
  });

  it("limits context around a change in a long file", () => {
    const before = Array.from({ length: 40 }, (_value, index) => `line-${index}`).join("\n");
    const after = before.replace("line-20", "line-20-changed");
    const diff = diffLines(before, after, 3);
    const rendered = renderDiff("big.txt", diff);
    expect(diff.lines.length).toBeLessThan(20);
    expect(rendered).toContain("line-20-changed");
    expect(rendered).not.toContain("line-0");
  });
});

describe("edit preview", () => {
  it("previews an edit_file change without writing", () => {
    const dir = workspace({ "src/a.ts": "const a = 1;\nconst b = 2;\n" });
    const preview = previewEdit(dir, "edit_file", { path: "src/a.ts", oldString: "const b = 2;", newString: "const b = 3;" });
    expect(preview).not.toBeNull();
    expect(preview?.path).toBe("src/a.ts");
    expect(preview?.added).toBe(1);
    expect(preview?.removed).toBe(1);
    expect(preview?.diff).toContain("-const b = 2;");
    expect(preview?.diff).toContain("+const b = 3;");
  });

  it("previews multi_edit as one diff and marks a new file", () => {
    const dir = workspace({ "multi.txt": "alpha\nbeta\n" });
    const preview = previewEdit(dir, "multi_edit", {
      path: "multi.txt",
      edits: [{ oldString: "alpha", newString: "ALPHA" }, { oldString: "beta", newString: "BETA" }],
    });
    expect(preview?.added).toBe(2);
    expect(preview?.removed).toBe(2);
    const created = previewEdit(dir, "write_file", { path: "new.txt", content: "hello\n" });
    expect(created?.created).toBe(true);
    expect(created?.added).toBe(1);
    expect(created?.diff).toContain("+hello");
  });

  it("returns an empty diff when the edit changes nothing and null for read tools", () => {
    const dir = workspace({ "same.txt": "value\n" });
    expect(previewEdit(dir, "edit_file", { path: "same.txt", oldString: "value", newString: "value" })?.diff).toBe("");
    expect(previewEdit(dir, "read_file", { path: "same.txt" })).toBeNull();
  });

  it("does not preview a path outside the workspace", () => {
    const dir = workspace({ "inside.txt": "x\n" });
    expect(() => previewEdit(dir, "edit_file", { path: "../outside.txt", oldString: "x", newString: "y" })).toThrow();
  });
});
