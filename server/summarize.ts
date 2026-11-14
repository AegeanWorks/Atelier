import { splitAttachments } from "../src/attachments.js";
import { AtelierError } from "./config.js";
import { appendMessage, createSession, getSession, listMessages, type DbHandle, type SessionRow } from "./db.js";
import { collectProvider } from "./providers/run.js";
import type { ChatMessage, ProviderAdapter } from "./providers/types.js";
import { loadConfig, loadSecrets } from "./state.js";

const MAX_TRANSCRIPT_CHARS = 16_000;
const SUMMARY_TIMEOUT_MS = 120_000;

const INSTRUCTION = `Summarise this coding conversation so work can continue in a fresh conversation without the history.
Cover, tersely: the user's goal, decisions made and why, files read or changed, commands run and their outcome, what is done, and what is still open.
Use plain bullet points, at most 400 words, no preamble. State only what the conversation shows.`;

export interface CompactOptions {
  adapter?: ProviderAdapter;
}

/** The newest part of the conversation that fits, with file attachments reduced to their names. */
function transcript(handle: DbHandle, sessionId: string): string {
  const lines = listMessages(handle, sessionId).map((message) => {
    const { text, files, images } = splitAttachments(message.text);
    const names = [...files, ...images.map((_, index) => `image ${index + 1}`)];
    const attached = names.length > 0 ? ` [attached: ${names.join(", ")}]` : "";
    return `${message.role === "user" ? "User" : "Assistant"}: ${text.trim()}${attached}`;
  });
  const kept: string[] = [];
  let size = 0;
  for (const line of lines.reverse()) {
    const room = MAX_TRANSCRIPT_CHARS - size;
    if (room <= 0) break;
    kept.unshift(line.length <= room ? line : `…${line.slice(line.length - room + 1)}`);
    size += line.length + 1;
  }
  return kept.join("\n\n");
}

/** Summarise a conversation with the configured provider and start a new one seeded with that summary. */
export async function compactSession(handle: DbHandle, sessionId: string, options: CompactOptions = {}): Promise<{ session: SessionRow; summary: string }> {
  const source = getSession(handle, sessionId);
  if (source === null) throw new AtelierError("NOT_FOUND", "Session not found.", sessionId, "Refresh the conversation list.");
  const body = transcript(handle, sessionId);
  if (body.length === 0) {
    throw new AtelierError("COMPACT_EMPTY", "Nothing to compact.", "This conversation has no messages yet.", "Send a message first.");
  }
  const config = loadConfig(handle.paths);
  const providerId = config.defaults.provider ?? config.providers[0]?.id ?? null;
  const provider = config.providers.find((entry) => entry.id === providerId);
  const model = config.defaults.model ?? provider?.defaultModel;
  if (providerId === null || provider === undefined || model === undefined) {
    throw new AtelierError("COMPACT_FAILED", "No provider is configured.", "Compacting needs a provider and a default model.", "Add a provider and model in Settings.");
  }
  const messages: ChatMessage[] = [
    { role: "system", content: INSTRUCTION },
    { role: "user", content: body },
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), SUMMARY_TIMEOUT_MS);
  timer.unref();
  let result;
  try {
    result = await collectProvider(handle, config, loadSecrets(handle.paths), providerId, { model, messages, maxTokens: 1200 }, controller.signal, {
      memo: false,
      ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
    });
  } finally {
    clearTimeout(timer);
  }
  const failure = result.events.find((event) => event.type === "error");
  const summary = result.text.trim();
  if (failure !== undefined || summary.length === 0) {
    const why = failure !== undefined && failure.type === "error" ? failure.message : "the provider returned no text";
    throw new AtelierError("COMPACT_FAILED", "The summary could not be produced.", why, "Check the provider in Settings, then try again.");
  }
  const title = `Compacted: ${source.title}`.slice(0, 80);
  const session = createSession(handle, title);
  appendMessage(handle, session.id, "user", `Summary of the earlier conversation "${source.title}". Continue from here:\n\n${summary}`, null);
  return { session, summary };
}
