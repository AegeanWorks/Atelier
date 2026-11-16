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

/**
 * A bounded, re-readable list of the large tool outputs this run offloaded to disk.
 *
 * Compaction drops the messages that mentioned them, so without this the model knows a
 * file was read but not that it can read the full output again with `read_file`.
 */
export function artifactManifest(paths: string[]): string {
  if (paths.length === 0) return "";
  const lines = paths.slice(-20).map((path) => `- ${path}`);
  return `[offloaded tool outputs still on disk; read any with read_file or bash]\n${lines.join("\n")}`;
}

export interface CompactOptionsExtra {
  /** Summary of the dropped window from a model; absent or null falls back to the mechanical summary. */
  modelSummary?: string | null | undefined;
  /** Large tool outputs that remain readable on disk, listed in the compacted head. */
  artifacts?: string[] | undefined;
}

export function compactMessages(messages: ChatMessage[], maxTokens: number, extra: CompactOptionsExtra = {}): { messages: ChatMessage[]; stats: CompactionStats } {
  const beforeTokens = messages.reduce((total, message) => total + estimateTokens(message.content), 0);
  if (beforeTokens <= maxTokens || messages.length <= 2) {
    return { messages, stats: { beforeTokens, afterTokens: beforeTokens, droppedMessages: 0, summaryTokens: 0 } };
  }
  const summaryBudget = Math.min(1_500, Math.max(200, Math.floor(maxTokens * 0.25)));
  // A model summary is what the model actually wrote down; the mechanical one is the fallback.
  const modelSummary = extra.modelSummary?.trim() ?? "";
  const summary = modelSummary.length > 0
    ? (modelSummary.length <= summaryBudget * 4 ? modelSummary : `${modelSummary.slice(0, summaryBudget * 4)}\n… truncated`)
    : summarize(messages, summaryBudget * 4);
  const manifest = artifactManifest(extra.artifacts ?? []);
  const head = manifest.length === 0 ? `[compacted earlier context]\n${summary}` : `[compacted earlier context]\n${summary}\n\n${manifest}`;
  const summaryMessage: ChatMessage = { role: "user", content: head };
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

/** The messages compaction is about to drop, so a model can summarise exactly that window. */
export function droppedWindow(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  const { stats } = compactMessages(messages, maxTokens);
  if (stats.droppedMessages === 0) return [];
  return messages.slice(0, messages.length - (messages.length - stats.droppedMessages));
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
