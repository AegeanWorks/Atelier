import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "..", "..", "src", "theme.css"), "utf8");

/** Names defined as custom properties anywhere in the sheet (`:root`, the light theme, a component). */
function defined(sheet: string): Set<string> {
  return new Set([...sheet.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1] as string));
}

/** Names read through `var(--name)` with no fallback, which fail silently when the name does not exist. */
function usedWithoutFallback(sheet: string): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  sheet.split("\n").forEach((text, index) => {
    for (const match of text.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)) out.push({ name: match[1] as string, line: index + 1 });
  });
  return out;
}

describe("theme tokens", () => {
  it("defines every custom property the stylesheet reads, because a missing one silently drops the declaration", () => {
    const known = defined(css);
    const missing = usedWithoutFallback(css).filter((use) => !known.has(use.name));
    expect(missing.map((use) => `${use.name} (line ${use.line})`)).toEqual([]);
  });

  it("recognises a missing token when there is one", () => {
    const sheet = ":root { --space-1: 4px; }\n.a { padding: var(--space-1) var(--space-9); }\n";
    expect(usedWithoutFallback(sheet).filter((use) => !defined(sheet).has(use.name))).toEqual([{ name: "--space-9", line: 2 }]);
  });
});
