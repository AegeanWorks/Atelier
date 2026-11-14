export interface DiffLine {
  kind: "add" | "del" | "context";
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  truncated: boolean;
}

const MAX_DIFF_LINES = 400;
const MAX_LCS_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function diffLines(before: string, after: string, context = 3): DiffResult {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const truncated = oldLines.length * newLines.length > MAX_LCS_CELLS;
  if (truncated) {
    const lines: DiffLine[] = [
      ...oldLines.slice(0, MAX_DIFF_LINES).map((text) => ({ kind: "del" as const, text })),
      ...newLines.slice(0, MAX_DIFF_LINES).map((text) => ({ kind: "add" as const, text })),
    ];
    return { lines, added: newLines.length, removed: oldLines.length, truncated };
  }

  const n = oldLines.length;
  const m = newLines.length;
  const lcs: Uint32Array = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number): number => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[at(i, j)] = oldLines[i] === newLines[j] ? (lcs[at(i + 1, j + 1)] as number) + 1 : Math.max(lcs[at(i + 1, j)] as number, lcs[at(i, j + 1)] as number);
    }
  }

  const ops: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: "context", text: oldLines[i] as string });
      i += 1;
      j += 1;
    } else if ((lcs[at(i + 1, j)] as number) >= (lcs[at(i, j + 1)] as number)) {
      ops.push({ kind: "del", text: oldLines[i] as string });
      i += 1;
    } else {
      ops.push({ kind: "add", text: newLines[j] as string });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", text: oldLines[i] as string });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "add", text: newLines[j] as string });
    j += 1;
  }

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "add") added += 1;
    if (op.kind === "del") removed += 1;
  }

  return { lines: trimContext(ops, context), added, removed, truncated };
}

function trimContext(ops: DiffLine[], context: number): DiffLine[] {
  const keep = Array.from({ length: ops.length }, () => false);
  ops.forEach((op, index) => {
    if (op.kind === "context") return;
    for (let cursor = Math.max(0, index - context); cursor <= Math.min(ops.length - 1, index + context); cursor += 1) keep[cursor] = true;
  });
  const output: DiffLine[] = [];
  let gap = false;
  ops.forEach((op, index) => {
    if (keep[index] === true) {
      if (gap && output.length > 0) output.push({ kind: "context", text: "…" });
      gap = false;
      output.push(op);
    } else {
      gap = true;
    }
  });
  return output.length > MAX_DIFF_LINES ? output.slice(0, MAX_DIFF_LINES) : output;
}

export function renderDiff(path: string, diff: DiffResult): string {
  const header = `--- a/${path}\n+++ b/${path}`;
  const body = diff.lines.map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`).join("\n");
  return `${header}\n${body}`;
}
