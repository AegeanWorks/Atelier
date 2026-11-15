import type { RuleConfig } from "./types.js";

// Mirrors the server: a command with these operators is never auto-allowed, so offering a rule for it would be misleading.
const SHELL_CONTROL = /&&|\|\||[;|&<>`\n\r]|\$\(/;

/**
 * The exact-match allow rule that "Always allow" would save for this approval, or null when it would not
 * be honoured or already exists.
 */
export function alwaysAllowRule(call: { action: string; resource: string; reason?: string }, existing: RuleConfig[]): RuleConfig | null {
  if (call.action !== "exec" && call.action !== "edit") return null;
  // An allow rule never auto-approves a protected path, and it cannot override a permission rule that asks.
  if (call.action === "edit" && isProtectedConfigPath(call.resource)) return null;
  if (call.reason?.startsWith("permission rule") === true) return null;
  const resource = call.resource.trim();
  if (resource.length === 0 || resource.length > 500 || resource.includes("*")) return null;
  if (call.action === "exec" && SHELL_CONTROL.test(resource)) return null;
  if (call.action === "edit" && resource.split(/[\\/]/).includes("..")) return null;
  if (existing.some((rule) => rule.action === call.action && rule.match === resource && rule.decision === "allow")) return null;
  const taken = new Set(existing.map((rule) => rule.id));
  let id = `always-${Date.now().toString(36)}`;
  for (let n = 1; taken.has(id); n += 1) id = `always-${Date.now().toString(36)}${n}`;
  return { id, action: call.action, match: resource, decision: "allow" };
}

const PROTECTED_DIRS = new Set([".atelier", ".claude", ".agents"]);
const PROTECTED_FILES = new Set(["agents.md", "claude.md"]);

/**
 * The agent's own configuration: instruction files, skills, commands and settings. A prompt injection that can write
 * these steers every later run, so an edit of one is never auto-approved, wherever the file sits and however it is spelled.
 * Shared by the server (which enforces it) and the approval dock (which must not offer a rule that could not be honoured).
 */
export function isProtectedConfigPath(path: string): boolean {
  const parts: string[] = [];
  for (const raw of path.split(/[\\/]/)) {
    const part = raw.toLowerCase();
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const last = parts.at(-1) ?? "";
  return PROTECTED_FILES.has(last) || PROTECTED_DIRS.has(last) || parts.slice(0, -1).some((part) => PROTECTED_DIRS.has(part));
}
