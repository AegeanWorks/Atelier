export interface ContextUse {
  providerId: string;
  model: string;
  usedTokens: number;
  windowTokens: number | null;
}

export interface ContextView {
  label: string;
  level: "ok" | "warn" | "high";
  title: string;
}

function compact(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

/** What the status bar shows for how full the context window is, or null before the first request. */
export function contextView(context: ContextUse | null | undefined): ContextView | null {
  if (context === null || context === undefined) return null;
  const { usedTokens, windowTokens, model } = context;
  if (windowTokens === null || windowTokens <= 0) {
    return { label: `ctx ${compact(usedTokens)}`, level: "ok", title: `${usedTokens.toLocaleString("en-US")} tokens in the last request (${model}). This model's window size is not known.` };
  }
  const ratio = usedTokens / windowTokens;
  const percent = Math.min(100, Math.round(ratio * 100));
  const level = ratio >= 0.9 ? "high" : ratio >= 0.7 ? "warn" : "ok";
  const base = `${usedTokens.toLocaleString("en-US")} of ${windowTokens.toLocaleString("en-US")} tokens in the context window (${model}).`;
  return {
    label: `ctx ${percent}%`,
    level,
    title: level === "ok" ? base : `${base} Getting full: run /compact to continue from a summary.`,
  };
}
