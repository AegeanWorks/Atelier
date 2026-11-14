import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DbHandle } from "./db.js";
import type { ChatMessage } from "./providers/types.js";
import { atomicWrite } from "./tools.js";
import type { RunRow } from "./runs.js";

export const OFFLOAD_THRESHOLD = 8_000;
export const OFFLOAD_PREVIEW = 500;

export interface CompactionStats {
  beforeTokens: number;
  afterTokens: number;
  droppedMessages: number;
  summaryTokens: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function summarize(messages: ChatMessage[], maxChars: number): string {
  const lines: string[] = [];
  for (const message of messages) {
    const oneLine = message.content.replace(/\s+/g, " ").trim();
    const label = message.name === undefined ? message.role : `${message.role} ${message.name}`;
    lines.push(`${label}: ${oneLine.slice(0, 180)}`);
  }
  const text = lines.join("\n");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… truncated`;
}

export function compactMessages(messages: ChatMessage[], maxTokens: number): { messages: ChatMessage[]; stats: CompactionStats } {
  const beforeTokens = messages.reduce((total, message) => total + estimateTokens(message.content), 0);
  if (beforeTokens <= maxTokens || messages.length <= 2) {
    return { messages, stats: { beforeTokens, afterTokens: beforeTokens, droppedMessages: 0, summaryTokens: 0 } };
  }
  const summaryBudget = Math.min(1_500, Math.max(200, Math.floor(maxTokens * 0.25)));
  const summary = summarize(messages, summaryBudget * 4);
  const summaryMessage: ChatMessage = { role: "user", content: `[compacted earlier context]\n${summary}` };
  const summaryTokens = estimateTokens(summaryMessage.content);
  const budget = Math.max(200, maxTokens - summaryTokens);
  const kept: ChatMessage[] = [];
  let keptTokens = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const tokens = estimateTokens(message.content);
    if (kept.length >= 2 && keptTokens + tokens > budget) break;
    kept.unshift(message);
    keptTokens += tokens;
  }
  if (kept.length === messages.length) return { messages, stats: { beforeTokens, afterTokens: beforeTokens, droppedMessages: 0, summaryTokens: 0 } };
  const compacted = [summaryMessage, ...kept];
  const afterTokens = compacted.reduce((total, message) => total + estimateTokens(message.content), 0);
  return {
    messages: compacted,
    stats: { beforeTokens, afterTokens, droppedMessages: messages.length - kept.length, summaryTokens },
  };
}

export function offloadToolOutput(
  handle: DbHandle,
  run: RunRow,
  callId: string,
  output: string,
): { content: string; path: string | null } {
  if (output.length <= OFFLOAD_THRESHOLD) return { content: output, path: null };
  const directory = join(handle.paths.home, "artifacts", run.id);
  mkdirSync(directory, { recursive: true });
  const safe = callId.replace(/[^A-Za-z0-9_-]/g, "_");
  const path = join(directory, `${safe}.txt`);
  atomicWrite(path, output);
  return {
    content: `${output.slice(0, OFFLOAD_PREVIEW)}\n\n[full output: ${path}]`,
    path,
  };
}
