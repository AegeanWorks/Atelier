import { AtelierError } from "./config.js";

export interface TextEdit {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export type EditStrategy = "exact" | "crlf" | "line-trimmed" | "whitespace" | "indentation";

export interface EditMatch {
  /** The strategy that produced the match, so the agent learns the file's real shape. */
  strategy: EditStrategy;
  /** First line index of the matched window in the original text. */
  line: number;
  /** How many original lines the window covers. */
  lines: number;
  /** Byte offset for an exact match; absent for a window match. */
  at?: number;
  /** Matched length for an exact match; absent for a window match. */
  length?: number;
}

/**
 * Line-level comparison used by one strategy, tried in order from the most specific drift to the
 * most permissive, so indentation is reported as indentation rather than as loose whitespace.
 * Each reports whether it is worth trying at all, so an ordinary exact needle skips them all.
 */
const COMPARATORS: Array<{ strategy: EditStrategy; same: (left: string, right: string) => boolean; active: (text: string, needle: string) => boolean }> = [
  // The common drift is the other way round: the model writes LF and the file is CRLF.
  { strategy: "crlf", active: (text) => text.includes("\r"), same: (left, right) => strip(left, "\r") === strip(right, "\r") },
  { strategy: "line-trimmed", active: (_text, needle) => /[ \t]+$/m.test(needle), same: (left, right) => strip(left, /[ \t]+$/g) === strip(right, /[ \t]+$/g) },
  { strategy: "indentation", active: (_text, needle) => /^[ \t]+/m.test(needle), same: (left, right) => strip(left, /^[ \t]+/g) === strip(right, /^[ \t]+/g) },
  { strategy: "whitespace", active: (_text, needle) => /[ \t]{2,}/.test(needle), same: (left, right) => squish(left) === squish(right) },
];

function strip(value: string, what: string | RegExp): string {
  return typeof what === "string" ? value.split(what).join("") : value.replace(what, "");
}

function squish(value: string): string {
  return value.replace(/[ \t]+/g, " ").trim();
}

function splitLines(text: string): string[] {
  return text.split("\n");
}

/** Every window of `needle` lines in `text` that compares equal under one comparator. */
function windows(text: string, needle: string, same: (left: string, right: string) => boolean): EditMatch["line"][] {
  const haystack = splitLines(text);
  const wanted = splitLines(needle);
  const found: number[] = [];
  for (let start = 0; start + wanted.length <= haystack.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if (!same(haystack[start + offset] ?? "", wanted[offset] ?? "")) {
        matches = false;
        break;
      }
    }
    if (matches) found.push(start);
  }
  return found;
}

/**
 * Every place `oldString` appears in `text`, trying the exact form first and then each drift
 * strategy in order. Returning all occurrences keeps an ambiguous edit refusable instead of
 * guessed, and reporting the strategy tells the caller which drift was healed.
 *
 * The exact strategy is a plain substring match, because a model often edits a fragment in the
 * middle of a line. Only a failed exact match falls back to whole-line windows, where the
 * drift strategies can compare shape rather than bytes.
 */
export function findEdit(text: string, oldString: string): EditMatch[] {
  const exact: EditMatch[] = [];
  let index = 0;
  while (true) {
    const at = text.indexOf(oldString, index);
    if (at < 0) break;
    const line = splitLines(text.slice(0, at)).length - 1;
    exact.push({ strategy: "exact", line, lines: splitLines(oldString).length, at, length: oldString.length });
    index = at + oldString.length;
  }
  if (exact.length > 0) return exact;
  for (const comparator of COMPARATORS) {
    if (!comparator.active(text, oldString)) continue;
    const hits = windows(text, oldString, comparator.same);
    if (hits.length > 0) return hits.map((line) => ({ strategy: comparator.strategy, line, lines: splitLines(oldString).length }));
  }
  return [];
}

/** Replace one exact substring at a byte offset, leaving every other byte untouched. */
function replaceAt(text: string, at: number, length: number, newString: string): string {
  return `${text.slice(0, at)}${newString}${text.slice(at + length)}`;
}

/** Replace one whole line window, leaving every other byte of the file untouched. */
function replaceWindow(text: string, match: EditMatch, newString: string): string {
  const lines = splitLines(text);
  const before = lines.slice(0, match.line);
  const after = lines.slice(match.line + match.lines);
  return [...before, ...splitLines(newString), ...after].join("\n");
}

export function applyTextEdit(text: string, edit: TextEdit, label = "Edit"): { text: string; replacements: number; strategy: EditStrategy } {
  const oldString = edit.oldString;
  if (oldString.length === 0) {
    throw new AtelierError("EDIT_EMPTY", `${label} has an empty oldString.`, "An empty match cannot be targeted.", "Provide the exact text to replace.");
  }
  const replaceAll = edit.replaceAll === true;
  const matches = findEdit(text, oldString);
  if (matches.length === 0 || (!replaceAll && matches.length !== 1)) {
    throw new AtelierError(
      "EDIT_MATCH",
      `${label} needs ${replaceAll ? "at least one match" : "exactly one match"}; found ${matches.length}.`,
      replaceAll ? "The oldString is absent, even allowing for line endings, trailing whitespace and indentation." : "The oldString is absent or ambiguous, even allowing for line endings, trailing whitespace and indentation.",
      replaceAll ? "Check the file content." : "Read the file and provide a unique oldString, or set replaceAll=true.",
    );
  }
  const strategy = matches[0]?.strategy ?? "exact";
  let out = text;
  if (strategy === "exact") {
    // Right to left, so earlier offsets stay valid.
    for (const match of [...matches].sort((left, right) => (right.at ?? 0) - (left.at ?? 0))) {
      out = replaceAt(out, match.at ?? 0, match.length ?? oldString.length, edit.newString);
    }
  } else {
    for (const match of [...matches].sort((left, right) => right.line - left.line)) {
      out = replaceWindow(out, match, edit.newString);
    }
  }
  return { text: out, replacements: replaceAll ? matches.length : 1, strategy };
}

export function applyMultiEdit(text: string, edits: TextEdit[]): { text: string; replacements: number; strategies: EditStrategy[] } {
  if (edits.length === 0) {
    throw new AtelierError("EDIT_EMPTY", "multi_edit needs at least one edit.", "The edits array was empty.", "Pass one or more {oldString, newString} entries.");
  }
  let current = text;
  let replacements = 0;
  const strategies: EditStrategy[] = [];
  for (const [index, edit] of edits.entries()) {
    try {
      const applied = applyTextEdit(current, edit, `Edit ${index + 1}`);
      current = applied.text;
      replacements += applied.replacements;
      strategies.push(applied.strategy);
    } catch (error) {
      if (error instanceof AtelierError && error.code === "EDIT_MATCH") {
        throw new AtelierError("EDIT_MATCH", error.message, "No edit was written; the file is unchanged.", "Re-read the file and make each oldString unique, or set replaceAll=true.");
      }
      throw error;
    }
  }
  return { text: current, replacements, strategies };
}
