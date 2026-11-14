import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkills } from "./skills.js";

export const WORKSPACE_INSTRUCTIONS_FILES = ["AGENTS.md", "CLAUDE.md"];
export const INSTRUCTIONS_MAX_CHARS = 8_000;

const BASE_PROMPT = `You are atelier, a coding agent working inside a local workspace.

How you work:
- Act on the user's request with tools; do not describe what you would do and then stop.
- Read before you edit. Use read_file, glob, and ripgrep to find the code; use list_dir for the layout.
- Prefer edit_file or multi_edit for small changes and write_file only for new or fully rewritten files.
- Keep edits minimal and in the existing style. Never touch .git internals or secret files.
- Verify with the project's own command (tests, lint, build) through bash before you claim success.
- bash runs in the workspace with a wall-clock limit; pass timeoutMs for long commands.
- Only state facts you observed in tool output. If a command failed, say so and show the failure.
- Ask for missing intent instead of guessing when the request is genuinely ambiguous.
- In build mode, writes and commands wait for the user's approval; a denied call is final for that call.
- Prefer a delegated read-only brief (delegate) for a broad search when you do not need to edit.
- For work with three or more steps, publish a short todo list with todo_write and keep exactly one item in_progress; update it as you go so the user can see progress.
- Finish with a short summary of what changed and how you verified it.

Tools: read_file (line window), list_dir, glob, ripgrep (regex text search), write_file, edit_file (exact replace, replaceAll option), multi_edit (several exact edits, atomic), todo_write (visible task list), bash, git_status, git_diff, delegate, wait, and any configured MCP tools named mcp__<server>__<tool>.`;

export interface SystemPromptOptions {
  extraInstructions?: string | undefined;
  maxChars?: number;
  platform?: NodeJS.Platform;
}

function readInstructions(workspace: string, maxChars: number): { file: string; text: string } | null {
  for (const name of WORKSPACE_INSTRUCTIONS_FILES) {
    const path = join(workspace, name);
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8").trim();
      if (text.length === 0) continue;
      const bounded = text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… truncated at ${maxChars} characters`;
      return { file: name, text: bounded };
    } catch {
      continue;
    }
  }
  return null;
}

export function buildSystemPrompt(workspace: string, options: SystemPromptOptions = {}): string {
  const maxChars = options.maxChars ?? INSTRUCTIONS_MAX_CHARS;
  const parts = [BASE_PROMPT];
  parts.push(`Workspace: ${workspace}\nPlatform: ${options.platform ?? process.platform}`);
  const instructions = readInstructions(workspace, maxChars);
  if (instructions !== null) {
    parts.push(`The workspace provides ${instructions.file} with project instructions. Follow it unless it conflicts with the safety rules above.\n\n<${instructions.file}>\n${instructions.text}\n</${instructions.file}>`);
  }
  const skills = loadSkills(workspace);
  if (skills.length > 0) {
    const list = skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.path})`).join("\n");
    parts.push(`Available skills. Each is a reusable instruction bundle. When one clearly matches the user's request, read its file with read_file before acting and follow it; do not read skills that do not apply.\n${list}`);
  }
  const extra = options.extraInstructions?.trim() ?? "";
  if (extra.length > 0) parts.push(`Additional instructions:\n${extra.slice(0, maxChars)}`);
  return parts.join("\n\n");
}
