// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";

const listeners = new Map<string, Array<(event: MessageEvent) => void>>();
class FakeEventSource {
  static latest: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeEventSource.latest = this;
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const current = listeners.get(type) ?? [];
    current.push(listener);
    listeners.set(type, current);
  }
  close(): void {}
}

function emit(type: string, data: unknown): void {
  for (const listener of listeners.get(type) ?? []) listener({ data: JSON.stringify(data) } as MessageEvent);
}

const boot = {
  version: "0.1.0",
  workspace: "C:\\work",
  sessions: [{ id: "ses_1", title: "Approval", created: 1, updated: 1 }],
  profiles: [],
  providers: [],
  recovery: { startedAt: 0, finishedAt: 1, actionCount: 0, result: "clean", actions: [] },
};

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/sessions/ses_1/messages") return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/approvals?pending=1") return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
  if (url === "/api/runs/run_1/approvals/ap_1" && method === "POST") return new Response(JSON.stringify({ approval: { id: "ap_1", status: "approved" } }), { status: 200 });
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: "nope" } }), { status: 404 });
});

beforeEach(() => {
  listeners.clear();
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

describe("approval dock", () => {
  it("shows a pending tool approval and resolves it", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    await waitFor(() => expect(FakeEventSource.latest).not.toBeNull());
    expect(screen.queryByTestId("approval-dock")).toBeNull();
    emit("approval.request", { approvalId: "ap_1", runId: "run_1", callId: "c1", tool: "write_file", action: "edit", resource: "notes.txt", reason: "write_file requires approval in build mode" });
    expect(await screen.findByTestId("approval-dock")).toBeTruthy();
    expect(screen.getByText("notes.txt")).toBeTruthy();
    fireEvent.click(screen.getByTestId("approval-approve"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/runs/run_1/approvals/ap_1", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(screen.queryByTestId("approval-dock")).toBeNull());
  });

  it("sends an optional note as the decision reason", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    await waitFor(() => expect(FakeEventSource.latest).not.toBeNull());
    emit("approval.request", { approvalId: "ap_1", runId: "run_1", callId: "c1", tool: "write_file", action: "edit", resource: "notes.txt", reason: "requires approval" });
    await screen.findByTestId("approval-dock");
    fireEvent.change(screen.getByTestId("approval-note"), { target: { value: "  keep the licence header  " } });
    fireEvent.click(screen.getByTestId("approval-deny"));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) => String(input) === "/api/runs/run_1/approvals/ap_1");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ decision: "deny", reason: "keep the licence header" });
    });
  });

  it("omits the reason key when the note is blank", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    await waitFor(() => expect(FakeEventSource.latest).not.toBeNull());
    emit("approval.request", { approvalId: "ap_1", runId: "run_1", callId: "c1", tool: "write_file", action: "edit", resource: "notes.txt", reason: "requires approval" });
    await screen.findByTestId("approval-dock");
    fireEvent.change(screen.getByTestId("approval-note"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("approval-approve"));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) => String(input) === "/api/runs/run_1/approvals/ap_1");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ decision: "approve" });
    });
  });
});
