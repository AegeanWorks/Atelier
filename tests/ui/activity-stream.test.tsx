// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("conversation activity feed", () => {
  it("shows live tool steps from the event stream and clears on a new run", async () => {
    render(<App />);
    await screen.findByTestId("conversation-list");
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;

    source.emit("run.started", { runId: "run_1" });
    expect(await screen.findByTestId("activity-feed")).toBeTruthy();
    expect(screen.getByText("Working")).toBeTruthy();

    source.emit("tool.result", { callId: "c1", name: "read_file", ok: true, detail: "src/App.tsx" });
    source.emit("tool.result", { callId: "c2", name: "edit_file", ok: false, detail: "src/App.tsx" });
    await waitFor(() => expect(screen.getAllByTestId("activity-item")).toHaveLength(2));
    expect(screen.getByText("2 steps")).toBeTruthy();
    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.getByText("Edited")).toBeTruthy();

    source.emit("tool.result", { callId: "c1", name: "read_file", ok: true, detail: "src/App.tsx" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getAllByTestId("activity-item")).toHaveLength(2);

    source.emit("run.started", { runId: "run_2" });
    await waitFor(() => expect(screen.queryAllByTestId("activity-item")).toHaveLength(0));
  });

  it("opens the task panel from the feed and dismisses a finished run", async () => {
    render(<App />);
    await screen.findByTestId("conversation-list");
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;
    source.emit("run.started", { runId: "run_1" });
    source.emit("tool.result", { callId: "c1", name: "bash", ok: true, detail: "npm test" });
    source.emit("run.finished", { runId: "run_1", status: "ok", messageId: "msg_1", text: "done" });
    await waitFor(() => expect(screen.getByText("Last run")).toBeTruthy());

    fireEvent.click(screen.getByTestId("activity-open-task"));
    await waitFor(() => expect(screen.getByTestId("tab-task").getAttribute("aria-selected")).toBe("true"));

    fireEvent.click(screen.getByTestId("activity-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("activity-feed")).toBeNull());
  });
});
