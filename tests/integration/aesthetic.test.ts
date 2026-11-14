// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(process.cwd(), "src");

function componentFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...componentFiles(full));
    else if (entry.name.endsWith(".tsx")) files.push(full);
  }
  return files;
}

function text(file: string): string {
  return readFileSync(file, "utf8");
}

describe("aesthetic guard", () => {
  it("keeps raw hex colors out of components", () => {
    const offenders = componentFiles(src)
      .filter((file) => /#[0-9a-fA-F]{3,8}\b/.test(text(file)))
      .map((file) => relative(src, file));
    expect(offenders).toEqual([]);
  });

  it("declares one global visible focus treatment", () => {
    const css = text(join(src, "theme.css"));
    expect(css).toContain("button:focus-visible");
    expect(css).toContain("input:focus-visible");
    expect(css).toContain("textarea:focus-visible");
    expect(css).toContain("select:focus-visible");
    expect(css).toContain("outline:");
  });

  it("drives the shell from shared radius, spacing and glow tokens", () => {
    const css = text(join(src, "theme.css"));
    for (const token of ["--radius-sm:", "--space-2:", "--control:", "--glow-a:", "--scrim:"]) {
      expect(css).toContain(token);
    }
    expect(css).toContain("var(--glow-a)");
    expect(css).toMatch(/\[data-theme="light"\]\s*\{[^}]*--glow-a:/);
  });

  it("keeps components free of a misleading profile label", () => {
    const offenders = componentFiles(src)
      .filter((file) => /profile:\s*full|profile full/.test(text(file)))
      .map((file) => relative(src, file));
    expect(offenders).toEqual([]);
  });

  it("keeps layout spacing out of inline styles", () => {
    const offenders = componentFiles(src)
      .filter((file) => /style=\{\{\s*margin/.test(text(file)))
      .map((file) => relative(src, file));
    expect(offenders).toEqual([]);
  });
});
