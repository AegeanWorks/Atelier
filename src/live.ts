/** The assistant text of the step that is being written right now, shown before it is saved. */
export interface LiveText {
  runId: string;
  step: number;
  text: string;
}

/** The newest characters kept of a live reply, so a very long answer cannot grow the page without bound. */
export const LIVE_TEXT_LIMIT = 20_000;

const ENDS = new Set(["run.started", "run.finished", "run.blocked"]);

/**
 * Folds one server event into the live reply. Only `text.delta` extends it, and only the current step is kept
 * (text a run wrote before a tool call is not part of its final answer). A run starting, finishing or blocking
 * clears it, because the saved message or the status line takes over. Anything else leaves it as it was.
 */
export function applyLiveEvent(current: LiveText | null, type: string, data: unknown): LiveText | null {
  if (ENDS.has(type)) return null;
  if (type !== "text.delta" || typeof data !== "object" || data === null) return current;
  const { runId, step, text } = data as { runId?: unknown; step?: unknown; text?: unknown };
  if (typeof runId !== "string" || typeof text !== "string") return current;
  const stepNumber = typeof step === "number" ? step : 0;
  const same = current !== null && current.runId === runId && current.step === stepNumber;
  const joined = (same ? current.text : "") + text;
  return { runId, step: stepNumber, text: joined.length > LIVE_TEXT_LIMIT ? joined.slice(joined.length - LIVE_TEXT_LIMIT) : joined };
}
