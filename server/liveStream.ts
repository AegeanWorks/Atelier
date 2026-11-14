/**
 * An in-memory channel for events that matter only while they happen, today the text a model is producing.
 * They are deliberately not written to the durable event log: the finished message is, and a late subscriber
 * gets that. Subscribers are the server-sent event endpoint and, later, an ACP agent in the same process.
 */
export interface LiveEvent {
  type: "text.delta";
  runId: string;
  step: number;
  text: string;
}

type Listener = (event: LiveEvent) => void;

const listeners = new Map<string, Set<Listener>>();

/** Hear live events of one session. Returns an unsubscribe function, safe to call more than once. */
export function subscribeLive(sessionId: string, listener: Listener): () => void {
  const set = listeners.get(sessionId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(sessionId, set);
  return () => {
    const current = listeners.get(sessionId);
    if (current === undefined) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(sessionId);
  };
}

/** Deliver an event to every current subscriber of the session; one that throws cannot affect the others or the caller. */
export function publishLive(sessionId: string, event: LiveEvent): void {
  const current = listeners.get(sessionId);
  if (current === undefined) return;
  for (const listener of [...current]) {
    try {
      listener(event);
    } catch {
      // a broken subscriber must never stop a run
    }
  }
}
