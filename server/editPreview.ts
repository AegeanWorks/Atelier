import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { AtelierError } from "./config.js";
import { diffLines, renderDiff, type DiffResult } from "./diff.js";
import { applyMultiEdit, applyTextEdit, type TextEdit } from "./edits.js";
import { resolveInside } from "./tools.js";

export interface EditPreview {
  path: string;
  tool: string;
  diff: string;
  added: number;
  removed: number;
  truncated: boolean;
  created: boolean;
}

export const MAX_PREVIEW_CHARS = 8_000;

function editsOf(input: Record<string, unknown>): TextEdit[] {
  const raw = Array.isArray(input.edits) ? input.edits : [];
  return raw.map((entry) => {
    const edit = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    return {
      oldString: String(edit.oldString ?? ""),
      newString: String(edit.newString ?? ""),
      replaceAll: edit.replaceAll === true,
    };
  });
}

export function previewEdit(workspace: string, tool: string, input: Record<string, unknown>): EditPreview | null {
  if (tool !== "edit_file" && tool !== "multi_edit" && tool !== "write_file") return null;
  const requested = typeof input.path === "string" ? input.path : "";
  if (requested.length === 0) return null;
  const absolute = resolveInside(workspace, requested);
  const created = !existsSync(absolute);
  let before = "";
  if (!created) {
    try {
      before = readFileSync(absolute, "utf8");
    } catch {
      return null;
    }
  }
  let after: string;
  if (tool === "write_file") {
    after = String(input.content ?? "");
  } else if (tool === "edit_file") {
    after = applyTextEdit(before, {
      oldString: String(input.oldString ?? ""),
      newString: String(input.newString ?? ""),
      replaceAll: input.replaceAll === true,
    }).text;
  } else {
    after = applyMultiEdit(before, editsOf(input)).text;
  }
  const path = relative(workspace, absolute).split("\\").join("/");
  if (after === before && !created) {
    return { path, tool, diff: "", added: 0, removed: 0, truncated: false, created };
  }
  const diff: DiffResult = diffLines(before, after);
  let text = renderDiff(path, diff);
  let truncated = diff.truncated;
  if (text.length > MAX_PREVIEW_CHARS) {
    text = `${text.slice(0, MAX_PREVIEW_CHARS)}\n… preview clipped`;
    truncated = true;
  }
  return { path, tool, diff: text, added: diff.added, removed: diff.removed, truncated, created };
}

export function previewForApproval(workspace: string, tool: string, input: unknown): EditPreview | null {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  try {
    return previewEdit(workspace, tool, record);
  } catch (error) {
    if (error instanceof AtelierError) {
      return {
        path: String(record.path ?? ""),
        tool,
        diff: "",
        added: 0,
        removed: 0,
        truncated: false,
        created: false,
      };
    }
    throw error;
  }
}
