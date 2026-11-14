import { readFileSync, statSync } from "node:fs";
import { isSecretPath } from "./permissions.js";
import { resolveInside } from "./tools.js";

const MAX_FILES = 5;
const MAX_CHARS = 12_000;

/** Append the contents of workspace files named as `@path` so the model sees what the user pointed at. */
export function attachMentionedFiles(workspace: string, prompt: string): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const match of prompt.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const path = match[1] ?? "";
    if (seen.has(path)) continue;
    seen.add(path);
    if (blocks.length >= MAX_FILES) break;
    // The same rule tools follow: secret files are never sent to a provider, even when the user names them.
    if (isSecretPath(path)) continue;
    try {
      const absolute = resolveInside(workspace, path);
      if (!statSync(absolute).isFile()) continue;
      const text = readFileSync(absolute, "utf8");
      const body = text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}\n… truncated at ${MAX_CHARS} characters`;
      blocks.push(`\n\n<attached_file path="${path}">\n${body}\n</attached_file>`);
    } catch {
      continue;
    }
  }
  return blocks.length === 0 ? prompt : prompt + blocks.join("");
}
