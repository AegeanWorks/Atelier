import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSystemPrompt, INSTRUCTIONS_MAX_CHARS } from "../../server/prompt";

const dirs: string[] = [];

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "atelier-prompt-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("system prompt", () => {
  it("describes the tools and the workspace", () => {
    const workspacePath = workspace();
    const prompt = buildSystemPrompt(workspacePath, { platform: "linux" });
    expect(prompt).toContain("atelier");
    expect(prompt).toContain("multi_edit");
    expect(prompt).toContain("todo_write");
    expect(prompt).toContain(`Workspace: ${workspacePath}`);
    expect(prompt).toContain("Platform: linux");
    expect(prompt).not.toContain("<AGENTS.md>");
  });

  it("injects AGENTS.md and prefers it over CLAUDE.md", () => {
    const workspacePath = workspace({ "AGENTS.md": "Run npm test before claiming success.", "CLAUDE.md": "ignored instructions" });
    const prompt = buildSystemPrompt(workspacePath);
    expect(prompt).toContain("<AGENTS.md>");
    expect(prompt).toContain("Run npm test before claiming success.");
    expect(prompt).not.toContain("ignored instructions");
  });

  it("falls back to CLAUDE.md and bounds the injected text", () => {
    const workspacePath = workspace({ "CLAUDE.md": "x".repeat(INSTRUCTIONS_MAX_CHARS + 500) });
    const prompt = buildSystemPrompt(workspacePath);
    expect(prompt).toContain("<CLAUDE.md>");
    expect(prompt).toContain(`truncated at ${INSTRUCTIONS_MAX_CHARS} characters`);
    expect(prompt.length).toBeLessThan(INSTRUCTIONS_MAX_CHARS + 3_000);
  });

  it("appends extra instructions once", () => {
    const prompt = buildSystemPrompt(workspace(), { extraInstructions: "Prefer pnpm." });
    expect(prompt).toContain("Additional instructions:\nPrefer pnpm.");
  });

  it("adds the instructions of parent folders up to the repository root, outermost first", () => {
    const root = workspace({ "AGENTS.md": "root rules" });
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "packages", "app"), { recursive: true });
    writeFileSync(join(root, "packages", "AGENTS.md"), "packages rules");
    writeFileSync(join(root, "packages", "app", "CLAUDE.md"), "app rules");
    const prompt = buildSystemPrompt(join(root, "packages", "app"));
    const rootAt = prompt.indexOf("root rules");
    const packagesAt = prompt.indexOf("packages rules");
    const appAt = prompt.indexOf("app rules");
    expect(rootAt).toBeGreaterThan(0);
    expect(packagesAt).toBeGreaterThan(rootAt);
    expect(appAt).toBeGreaterThan(packagesAt);
    expect(prompt).toContain('<AGENTS.md path=".">');
    expect(prompt).toContain('<AGENTS.md path="packages">');
    expect(prompt).toContain('<CLAUDE.md path="packages/app">');
    expect(prompt).toMatch(/nearest/i);
  });

  it("does not read parent folders when the workspace is not inside a repository", () => {
    const parent = workspace({ "AGENTS.md": "unrelated parent rules" });
    mkdirSync(join(parent, "sub"));
    writeFileSync(join(parent, "sub", "AGENTS.md"), "own rules");
    const prompt = buildSystemPrompt(join(parent, "sub"));
    expect(prompt).toContain("own rules");
    expect(prompt).not.toContain("unrelated parent rules");
    expect(prompt).toContain("<AGENTS.md>");
  });

  it("keeps the nearest instructions when the shared budget runs out", () => {
    const root = workspace({ "AGENTS.md": "R".repeat(500) });
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "app"));
    writeFileSync(join(root, "app", "AGENTS.md"), "N".repeat(300));
    const prompt = buildSystemPrompt(join(root, "app"), { maxChars: 400 });
    expect(prompt).toContain("N".repeat(300));
    expect(prompt).toContain("R".repeat(100));
    expect(prompt).not.toContain("R".repeat(101));
    expect(prompt).toContain("truncated");
  });

  it("inlines a line that is only @relative/path from a file inside the repository", () => {
    const root = workspace({ "AGENTS.md": "intro\n@docs/style.md\noutro" });
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "style.md"), "use tabs");
    const prompt = buildSystemPrompt(root);
    expect(prompt).toContain("intro\nuse tabs\noutro");
    expect(prompt).not.toContain("@docs/style.md");
  });

  it("leaves an import that points outside the repository, or at nothing, as plain text", () => {
    const outer = workspace({ "secret.md": "outside secret" });
    const root = join(outer, "repo");
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "@../secret.md\n@missing.md");
    const prompt = buildSystemPrompt(root);
    expect(prompt).not.toContain("outside secret");
    expect(prompt).toContain("@../secret.md");
    expect(prompt).toContain("@missing.md");
  });

  it("follows nested imports a few levels, stops at a cycle and never repeats a file", () => {
    const root = workspace({ "AGENTS.md": "top\n@a.md" });
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "a.md"), "A\n@b.md");
    writeFileSync(join(root, "b.md"), "B\n@a.md");
    const prompt = buildSystemPrompt(root);
    expect(prompt).toContain("top\nA\nB\n@a.md");
    expect(prompt.split("\nA\n").length).toBe(2);
    const deep = workspace({ "AGENTS.md": "@l1.md" });
    mkdirSync(join(deep, ".git"));
    for (let level = 1; level <= 6; level += 1) writeFileSync(join(deep, `l${level}.md`), `L${level}\n@l${level + 1}.md`);
    const deepPrompt = buildSystemPrompt(deep);
    // Assert on the whole line, not a bare token: the prompt embeds this temp workspace's
    // absolute path, and mkdtemp's random suffix contains "L5" about once in 250 runs (measured),
    // which made a bare toContain("L5") fail for a reason that had nothing to do with imports.
    expect(deepPrompt).toContain("\nL3\n");
    expect(deepPrompt).not.toContain("\nL5\n");
  });
});
