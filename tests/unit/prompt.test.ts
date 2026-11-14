import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
