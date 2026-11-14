export interface Mention {
  start: number;
  query: string;
}

/** The `@token` that ends at the caret, or null when the caret is not inside one. */
export function activeMention(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (match === null) return null;
  const query = match[1] ?? "";
  return { start: caret - query.length - 1, query };
}

export function applyMention(text: string, mention: Mention, path: string): { text: string; caret: number } {
  const end = mention.start + 1 + mention.query.length;
  const inserted = `@${path} `;
  return { text: `${text.slice(0, mention.start)}${inserted}${text.slice(end)}`, caret: mention.start + inserted.length };
}

export function rankFiles(files: string[], query: string, limit: number): string[] {
  const needle = query.toLowerCase();
  if (needle.length === 0) return files.slice(0, limit);
  const scored: Array<{ path: string; score: number }> = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    if (base.startsWith(needle)) scored.push({ path, score: 0 });
    else if (lower.includes(needle)) scored.push({ path, score: 1 });
  }
  return scored.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path)).slice(0, limit).map((item) => item.path);
}
