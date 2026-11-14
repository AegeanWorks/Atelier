export interface TerminalState {
  output: string;
  history: string[];
}

export const TERMINAL_HEADER = "atelier terminal\n$ _";
export const MAX_OUTPUT_LINES = 400;
export const MAX_HISTORY = 60;

const STORAGE_KEY = "atelier.terminal";

export function boundOutput(text: string, maxLines: number = MAX_OUTPUT_LINES): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(lines.length - maxLines).join("\n");
}

export function pushCommand(history: string[], command: string, maxEntries: number = MAX_HISTORY): string[] {
  if (command.trim().length === 0) return history;
  if (history[history.length - 1] === command) return history;
  const next = [...history, command];
  return next.length <= maxEntries ? next : next.slice(next.length - maxEntries);
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readTerminal(storage: Storage | null = defaultStorage()): TerminalState {
  if (storage === null) return { output: TERMINAL_HEADER, history: [] };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return { output: TERMINAL_HEADER, history: [] };
    const parsed = JSON.parse(raw) as { output?: unknown; history?: unknown };
    const output = typeof parsed.output === "string" && parsed.output.length > 0 ? parsed.output : TERMINAL_HEADER;
    const history = Array.isArray(parsed.history)
      ? parsed.history.filter((entry): entry is string => typeof entry === "string").slice(-MAX_HISTORY)
      : [];
    return { output: boundOutput(output), history };
  } catch {
    return { output: TERMINAL_HEADER, history: [] };
  }
}

export function writeTerminal(state: TerminalState, storage: Storage | null = defaultStorage()): void {
  if (storage === null) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      output: boundOutput(state.output),
      history: state.history.slice(-MAX_HISTORY),
    }));
  } catch {
    // A full or blocked storage keeps the in-memory terminal working.
  }
}
