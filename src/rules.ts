import type { RuleConfig } from "./types.js";

// Mirrors the server: a command with these operators is never auto-allowed, so offering a rule for it would be misleading.
const SHELL_CONTROL = /&&|\|\||[;|&<>`\n\r]|\$\(/;

/**
 * The exact-match allow rule that "Always allow" would save for this approval, or null when it would not
 * be honoured or already exists.
 */
export function alwaysAllowRule(call: { action: string; resource: string }, existing: RuleConfig[]): RuleConfig | null {
  if (call.action !== "exec" && call.action !== "edit") return null;
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
