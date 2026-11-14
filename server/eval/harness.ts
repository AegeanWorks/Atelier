import { hashRequest } from "../providers/http.js";
import { toolSchemas } from "../tools.js";
import type { HarnessProfile } from "./types.js";

export const FULL_PROFILE: HarnessProfile = {
  id: "full-v1",
  promptVersion: "agents-md-v1",
  maxSteps: 40,
  toolNames: ["read_file", "list_dir", "glob", "ripgrep", "write_file", "edit_file", "multi_edit", "todo_write", "bash", "wait", "delegate", "mcp", "git_status", "git_diff"],
  contextMessages: 200,
  contextTokens: 24_000,
  doomLoopLimit: 3,
  compaction: "summary",
  permissions: "build-workspace",
  finishPolicy: "text",
};

export const DELEGATE_PROFILE: HarnessProfile = {
  id: "delegate-v1",
  promptVersion: "agents-md-v1",
  maxSteps: 3,
  toolNames: ["read_file", "list_dir", "glob", "ripgrep"],
  contextMessages: 10,
  contextTokens: 4_000,
  doomLoopLimit: 2,
  compaction: "none",
  permissions: "plan-readonly",
  finishPolicy: "text",
};

export const MINIMAL_PROFILE: HarnessProfile = {
  id: "minimal-v1",
  promptVersion: "agents-md-v1",
  maxSteps: 3,
  toolNames: ["read_file", "write_file", "bash"],
  contextMessages: 10,
  contextTokens: 4_000,
  doomLoopLimit: 2,
  compaction: "none",
  permissions: "build-workspace",
  finishPolicy: "text",
};

export function profileFor(name: string): HarnessProfile {
  if (name === "full-v1" || name === "full") return { ...FULL_PROFILE };
  if (name === "minimal-v1" || name === "minimal") return { ...MINIMAL_PROFILE };
  throw new Error(`unknown harness profile '${name}' (use full-v1 or minimal-v1)`);
}

export function harnessVersion(profile: HarnessProfile): string {
  return hashRequest({ profile, tools: toolSchemas(profile.toolNames) });
}
