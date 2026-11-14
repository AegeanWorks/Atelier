import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachMentionedFiles } from "../../server/attachments";
import { splitAttachments } from "../../src/attachments";

const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "atelier-attach-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "big.txt"), "x".repeat(60_000));
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("attachMentionedFiles", () => {
  it("appends the contents of mentioned workspace files once", () => {
    const root = workspace();
    const out = attachMentionedFiles(root, "fix @src/a.ts and @src/a.ts please");
    expect(out.startsWith("fix @src/a.ts and @src/a.ts please")).toBe(true);
    expect(out.match(/<attached_file path="src\/a.ts">/g)?.length).toBe(1);
    expect(out).toContain("export const a = 1;");
  });

  it("leaves the prompt alone for unknown, escaping or directory mentions", () => {
    const root = workspace();
    for (const text of ["mail a@b.com", "see @nope.ts", "see @../secret", "see @src", "see @/etc/passwd"]) {
      expect(attachMentionedFiles(root, text)).toBe(text);
    }
  });

  it("truncates a large file and caps the number of attachments", () => {
    const root = workspace();
    const big = attachMentionedFiles(root, "@big.txt");
    expect(big).toContain("truncated");
    expect(big.length).toBeLessThan(20_000);
    for (let i = 0; i < 8; i += 1) writeFileSync(join(root, `f${i}.md`), "z");
    const many = attachMentionedFiles(root, Array.from({ length: 8 }, (_, i) => `@f${i}.md`).join(" "));
    expect(many.match(/<attached_file /g)?.length).toBe(5);
  });

  it("splits attachments back out for display", () => {
    const root = workspace();
    const out = attachMentionedFiles(root, "fix @src/a.ts");
    expect(splitAttachments(out)).toEqual({ text: "fix @src/a.ts", files: ["src/a.ts"], images: [] });
    expect(splitAttachments("plain")).toEqual({ text: "plain", files: [], images: [] });
  });

  it("also separates image markers and reports their ids", () => {
    const content = "look\n\n<attached_image id=\"0123456789abcdef.png\"/>\n\n<attached_image id=\"fedcba9876543210.jpg\"/>";
    expect(splitAttachments(content)).toEqual({ text: "look", files: [], images: ["0123456789abcdef.png", "fedcba9876543210.jpg"] });
  });
});
