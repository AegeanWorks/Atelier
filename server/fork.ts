import { AtelierError } from "./config.js";
import { appendMessage, createSession, getSession, listMessages, type DbHandle, type SessionRow } from "./db.js";

/** Copy a conversation, optionally only up to and including one message, into a new conversation. */
export function forkSession(handle: DbHandle, sessionId: string, upToMessageId?: string): SessionRow {
  const source = getSession(handle, sessionId);
  if (source === null) throw new AtelierError("NOT_FOUND", "Session not found.", sessionId, "Refresh the conversation list.");
  const all = listMessages(handle, sessionId);
  let messages = all;
  if (upToMessageId !== undefined) {
    const index = all.findIndex((message) => message.id === upToMessageId);
    if (index < 0) throw new AtelierError("NOT_FOUND", "Message not found.", `${upToMessageId} is not in ${sessionId}.`, "Refresh the conversation and pick a message again.");
    messages = all.slice(0, index + 1);
  }
  if (messages.length === 0) {
    throw new AtelierError("FORK_EMPTY", "Nothing to fork.", "This conversation has no messages yet.", "Send a message first.");
  }
  // One transaction: a crash leaves either the whole fork or nothing.
  return handle.db.transaction(() => {
    const fork = createSession(handle, `Fork: ${source.title}`.slice(0, 80));
    for (const message of messages) appendMessage(handle, fork.id, message.role === "assistant" ? "assistant" : "user", message.text, null);
    return fork;
  })();
}
