import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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

interface InstructionFile {
  file: string;
  /** The folder holding it, relative to the repository root ("." for the root itself). */
  folder: string;
  /** True when it is the workspace folder's own file. */
  own: boolean;
  text: string;
}

/** The nearest folder at or above `workspace` that holds a `.git` entry (a folder, or a file in a worktree), or null. */
function repositoryRoot(workspace: string): string | null {
  let dir = resolve(workspace);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readOne(dir: string): { file: string; text: string } | null {
  for (const name of WORKSPACE_INSTRUCTIONS_FILES) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8").trim();
      if (text.length > 0) return { file: name, text };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The instruction files of the workspace and of every folder above it up to the repository root, outermost first.
 * Outside a repository only the workspace itself is read, so an unrelated parent folder never steers a run. The
 * `maxChars` budget is shared and spent nearest first, so the most specific rules are the last to be cut.
 */
function readInstructions(workspace: string, maxChars: number): InstructionFile[] {
  const start = resolve(workspace);
  const root = repositoryRoot(start);
  const dirs: string[] = [];
  for (let dir = start; ; dir = dirname(dir)) {
    dirs.push(dir);
    if (root === null || dir === root || dirname(dir) === dir) break;
  }
  const found: InstructionFile[] = [];
  let remaining = maxChars;
  for (const dir of dirs) {
    if (remaining <= 0) break;
    const one = readOne(dir);
    if (one === null) continue;
    const text = one.text.length <= remaining ? one.text : `${one.text.slice(0, remaining)}\nâ€¦ truncated at ${maxChars} characters`;
    remaining -= one.text.length;
    found.push({ file: one.file, own: dir === start, folder: root === null ? "." : relative(root, dir).split("\\").join("/") || ".", text });
  }
  return found.reverse();
}

export function buildSystemPrompt(workspace: string, options: SystemPromptOptions = {}): string {
  const maxChars = options.maxChars ?? INSTRUCTIONS_MAX_CHARS;
  const parts = [BASE_PROMPT];
  parts.push(`Workspace: ${workspace}\nPlatform: ${options.platform ?? process.platform}`);
  const instructions = readInstructions(workspace, maxChars);
  const only = instructions[0];
  if (instructions.length === 1 && only !== undefined && only.own) {
    parts.push(`The workspace provides ${only.file} with project instructions. Follow it unless it conflicts with the safety rules above.\n\n<${only.file}>\n${only.text}\n</${only.file}>`);
  } else if (instructions.length > 0) {
    const blocks = instructions.map((entry) => `<${entry.file} path="${entry.folder}">\n${entry.text}\n</${entry.file}>`).join("\n\n");
    parts.push(`The workspace and the folders above it up to the repository root provide project instructions, listed outermost first. Where they disagree, the nearest to the workspace wins. Follow them unless they conflict with the safety rules above.\n\n${blocks}`);
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
