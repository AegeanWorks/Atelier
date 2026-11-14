// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) } as MessageEvent);
  }
  close(): void {
    // No-op.
  }
}

const boot = {
  version: "0.1.0",
  workspace: "C:\\work",
  sessions: [{ id: "ses_1", title: "One", created: 1, updated: 1, pinned: 0, archived: 0 }],
  profiles: [],
  providers: [],
  recovery: { startedAt: 0, finishedAt: 1, actionCount: 0, result: "clean", actions: [] },
};

const storedTodos = {
  todos: [
    { id: "t1", text: "Read the parser", status: "completed" },
    { id: "t2", text: "Refactor the tokenizer", status: "in_progress" },
  ],
  updatedAt: 5,
};

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/sessions") return new Response(JSON.stringify({ sessions: boot.sessions }), { status: 200 });
  if (url === "/api/sessions/ses_1/messages") return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/todos") return new Response(JSON.stringify(storedTodos), { status: 200 });
  if (url === "/api/sessions/ses_1/approvals?pending=1") return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
  if (url.startsWith("/api/usage")) return new Response(JSON.stringify({ totals: null }), { status: 200 });
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: url } }), { status: 404 });
});

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("todo list in the conversation", () => {
  it("loads the stored list for the active conversation", async () => {
    render(<App />);
    await screen.findByTestId("conversation-list");
    const strip = await screen.findByTestId("todo-strip");
    expect(strip).toBeTruthy();
    expect(screen.getByTestId("todo-count").textContent).toBe("1/2");
    expect(screen.getAllByTestId("todo-item")).toHaveLength(2);
  });

  it("replaces the list from the live stream", async () => {
    render(<App />);
    await screen.findByTestId("conversation-list");
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;
    source.emit("run.started", { runId: "run_1" });
    source.emit("todo.updated", {
      runId: "run_1",
      todos: [
        { id: "t1", text: "Read the parser", status: "completed" },
        { id: "t2", text: "Refactor the tokenizer", status: "completed" },
        { id: "t3", text: "Run the suite", status: "in_progress" },
      ],
    });
    await waitFor(() => expect(screen.getByTestId("todo-count").textContent).toBe("2/3"));
    expect(screen.getByTestId("todo-strip").getAttribute("data-done")).toBe("false");

    source.emit("todo.updated", { runId: "run_1", todos: [] });
    await waitFor(() => expect(screen.queryByTestId("todo-strip")).toBeNull());
  });
});
