// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type: string, data: unknown, lastEventId = ""): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data), lastEventId } as MessageEvent);
    }
  }
  close(): void {
    this.closed = true;
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

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/sessions") return new Response(JSON.stringify({ sessions: boot.sessions }), { status: 200 });
  if (url === "/api/sessions/ses_1/messages") return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/approvals?pending=1") return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
  if (url.startsWith("/api/usage")) return new Response(JSON.stringify({ totals: null }), { status: 200 });
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: url } }), { status: 404 });
});

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  localStorage.clear();
  fetchMock.mockClear();
  setHidden(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setHidden(false);
});

describe("live event stream lifecycle", () => {
  it("resumes a reopened stream after the last seen event id", async () => {
    render(<App />);
    await screen.findByTestId("conversation-list");
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const first = FakeEventSource.instances[0]!;
    expect(first.url).toBe("/api/sessions/ses_1/events?after=0");

    first.emit("run.started", { runId: "run_1" }, "7");
    expect(await screen.findByTestId("working")).toBeTruthy();

    setHidden(true);
    await waitFor(() => expect(first.closed).toBe(true));

    setHidden(false);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(1));
    const reopened = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    expect(reopened.url).toBe("/api/sessions/ses_1/events?after=7");
    expect(reopened.closed).toBe(false);
  });

  it("does not open a stream and marks itself not live while hidden", async () => {
    setHidden(true);
    render(<App />);
    await screen.findByTestId("conversation-list");
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(screen.getByTestId("statusbar").textContent).toContain("sse idle");

    setHidden(false);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0]!.url).toBe("/api/sessions/ses_1/events?after=0");
  });
});
