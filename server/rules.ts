import { posix } from "node:path";
import { isProtectedConfigPath } from "../src/rules.js";

export type RuleAction = "exec" | "edit";

export interface Rule {
  id: string;
  action: RuleAction;
  /** Literal text with * as a wildcard, matched against the whole command or path. */
  match: string;
  decision: "allow" | "ask" | "deny";
}

export interface RuleVerdict {
  decision: "allow" | "deny" | "ask";
  ruleId: string | null;
}

// A command that chains, pipes, redirects, backgrounds or substitutes can do more than the pattern names.
const SHELL_CONTROL = /&&|\|\||[;|&<>`\n\r]|\$\(/;

function matches(pattern: string, text: string): boolean {
  const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`, "s").test(text);
}

/**
 * One spelling per path: forward slashes, no `./`, no `//`, `..` resolved, and lower case on Windows where the
 * file system ignores case. Without this a deny rule for `dist/*` is dodged by `./dist/x`, `dist\x` or `DIST/x`.
 */
export function normalizeEditPath(path: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = posix.normalize(path.replace(/\\/g, "/")).replace(/^(\.\/)+/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function collapse(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function fold(text: string, action: RuleAction, platform: NodeJS.Platform = process.platform): string {
  if (action === "edit") return normalizeEditPath(text, platform);
  const collapsed = collapse(text);
  return platform === "win32" ? collapsed.toLowerCase() : collapsed;
}

export { isProtectedConfigPath };

function climbsOut(path: string): boolean {
  return path === ".." || path.startsWith("../");
}

/**
 * Decide a tool call against the configured rules. The order is deny, then ask, then allow: a matching deny always
 * wins, a matching ask beats an allow that would also cover the call, and otherwise the first matching allow wins, except that an allow never covers a command containing shell control operators or a path that
 * climbs out with `..`. Everything else is left to ask. These rules only decide whether to prompt: the hard
 * safety checks (secrets, paths outside the workspace, destructive commands) still run afterwards.
 */
export function evaluateRules(rules: Rule[], action: RuleAction, resource: string): RuleVerdict {
  const target = action === "edit" ? normalizeEditPath(resource) : collapse(resource);
  const hit = (rule: Rule): boolean => matches(action === "edit" ? normalizeEditPath(rule.match) : collapse(rule.match), target);
  // A deny is matched the way the shell reads the command, so it also ignores case where the shell does.
  const denyHit = (rule: Rule): boolean => matches(fold(rule.match, action), fold(resource, action));
  const deny = rules.find((rule) => rule.action === action && rule.decision === "deny" && (hit(rule) || denyHit(rule)));
  if (deny !== undefined) return { decision: "deny", ruleId: deny.id };
  // Asking is the safe direction, so an ask rule matches the way a deny does, and a chained command cannot dodge it.
  const ask = rules.find((rule) => rule.action === action && rule.decision === "ask" && (hit(rule) || denyHit(rule)));
  if (ask !== undefined) return { decision: "ask", ruleId: ask.id };
  const allow = rules.find((rule) => rule.action === action && rule.decision === "allow" && hit(rule));
  if (allow === undefined) return { decision: "ask", ruleId: null };
  if (action === "exec" && SHELL_CONTROL.test(resource)) return { decision: "ask", ruleId: null };
  if (action === "edit" && (climbsOut(target) || isProtectedConfigPath(target))) return { decision: "ask", ruleId: null };
  return { decision: "allow", ruleId: allow.id };
}
