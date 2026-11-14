import { isAbsolute, relative, resolve } from "node:path";

export type PermissionAction = "read" | "edit" | "exec";
export type Mode = "plan" | "build";

export interface PermissionDecision {
  decision: "allow" | "deny";
  action: PermissionAction;
  resource: string;
  reason: string;
}

const SECRET_NAMES = [".env", ".env.local", "id_rsa", "id_ed25519", "secrets.json", "credentials.json"];
const SECRET_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];
const DESTRUCTIVE = /(^|\s)(rm\s+-rf|git\s+reset\s+--hard|git\s+push\s+--force|sudo|curl\b[^|]*\|\s*(sh|bash))/i;

export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function isSecretPath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  return SECRET_NAMES.includes(name) || SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function checkPermission(
  root: string,
  mode: Mode,
  action: PermissionAction,
  resource: string,
): PermissionDecision {
  if (action === "read") {
    if (isSecretPath(resource)) {
      return { decision: "deny", action, resource, reason: "secret files are not readable by tools" };
    }
    return { decision: "allow", action, resource, reason: "read within the workspace" };
  }
  if (mode === "plan") {
    return { decision: "deny", action, resource, reason: "plan mode is read-only" };
  }
  if (action === "edit") {
    const target = isAbsolute(resource) ? resource : resolve(root, resource);
    if (!isInside(root, target)) {
      return { decision: "deny", action, resource, reason: "path is outside the workspace" };
    }
    if (resource.split(/[\\/]/).includes(".git") || isSecretPath(resource)) {
      return { decision: "deny", action, resource, reason: "protected path" };
    }
    return { decision: "allow", action, resource, reason: "edit within the workspace" };
  }
  if (DESTRUCTIVE.test(resource)) {
    return { decision: "deny", action, resource, reason: "destructive command" };
  }
  return { decision: "allow", action, resource, reason: "exec within the workspace" };
}
