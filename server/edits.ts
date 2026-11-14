import { AtelierError } from "./config.js";

export interface TextEdit {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export function applyTextEdit(text: string, edit: TextEdit, label = "Edit"): { text: string; replacements: number } {
  const oldString = edit.oldString;
  if (oldString.length === 0) {
    throw new AtelierError("EDIT_EMPTY", `${label} has an empty oldString.`, "An empty match cannot be targeted.", "Provide the exact text to replace.");
  }
  const occurrences = text.split(oldString).length - 1;
  const replaceAll = edit.replaceAll === true;
  if (occurrences === 0 || (!replaceAll && occurrences !== 1)) {
    throw new AtelierError(
      "EDIT_MATCH",
      `${label} needs ${replaceAll ? "at least one match" : "exactly one match"}; found ${occurrences}.`,
      replaceAll ? "The oldString is absent." : "The oldString is absent or ambiguous.",
      replaceAll ? "Check the file content." : "Read the file and provide a unique oldString, or set replaceAll=true.",
    );
  }
  return {
    text: replaceAll ? text.split(oldString).join(edit.newString) : text.replace(oldString, edit.newString),
    replacements: replaceAll ? occurrences : 1,
  };
}

export function applyMultiEdit(text: string, edits: TextEdit[]): { text: string; replacements: number } {
  if (edits.length === 0) {
    throw new AtelierError("EDIT_EMPTY", "multi_edit needs at least one edit.", "The edits array was empty.", "Pass one or more {oldString, newString} entries.");
  }
  let current = text;
  let replacements = 0;
  for (const [index, edit] of edits.entries()) {
    try {
      const applied = applyTextEdit(current, edit, `Edit ${index + 1}`);
      current = applied.text;
      replacements += applied.replacements;
    } catch (error) {
      if (error instanceof AtelierError && error.code === "EDIT_MATCH") {
        throw new AtelierError("EDIT_MATCH", error.message, "No edit was written; the file is unchanged.", "Re-read the file and make each oldString unique, or set replaceAll=true.");
      }
      throw error;
    }
  }
  return { text: current, replacements };
}
