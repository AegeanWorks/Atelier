// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";

class FakeEventSource {
  static latest: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  constructor() {
    FakeEventSource.latest = this;
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) } as MessageEvent);
  }
  close(): void {}
}

const sessions = [
  { id: "ses_a", title: "Alpha", created: 1, updated: 10, pinned: 0, archived: 0 },
  { id: "ses_b", title: "Beta", created: 1, updated: 20, pinned: 0, archived: 0 },
];

let listed = [...sessions];

const boot = {
  version: "0.1.0",
  workspace: "C:\\work",
  sessions,
  profiles: [],
  providers: [],
  recovery: { startedAt: 0, finishedAt: 1, actionCount: 0, result: "clean", actions: [] },
};

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/sessions" && method === "GET") return new Response(JSON.stringify({ sessions: listed }), { status: 200 });
  if (url === "/api/sessions/ses_a/messages") return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  if (url === "/api/sessions/ses_a/approvals?pending=1") return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
  if (url.startsWith("/api/usage")) return new Response(JSON.stringify({ totals: null }), { status: 200 });
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: url } }), { status: 404 });
});

beforeEach(() => {
  listed = [...sessions];
  FakeEventSource.latest = null;
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  localStorage.clear();
  fetchMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("session list refresh", () => {
  it("reorders the rail after a finished run changes the server order", async () => {
    render(<App />);
    await screen.findByTestId("conversation-list");
    expect(screen.getAllByTestId("conversation-item")[0]?.textContent).toContain("Alpha");

    await waitFor(() => expect(FakeEventSource.latest).not.toBeNull());
    listed = [sessions[1]!, sessions[0]!];
    FakeEventSource.latest?.emit("run.finished", { runId: "run_1", status: "ok" });

    await waitFor(() => expect(screen.getAllByTestId("conversation-item")[0]?.textContent).toContain("Beta"));
  });
});
