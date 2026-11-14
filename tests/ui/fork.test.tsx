// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(_type: string, _listener: (event: MessageEvent) => void): void {}
  close(): void {}
}

const boot = {
  version: "0.1.0",
  workspace: "/work",
  sessions: [{ id: "ses_1", title: "Forks", created: 1, updated: 1 }],
  profiles: [],
  providers: [],
  recovery: { startedAt: 0, finishedAt: 1, actionCount: 0, result: "clean", actions: [] },
};

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/commands") return new Response(JSON.stringify({ commands: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/messages") {
    return new Response(JSON.stringify({ messages: [
      { id: "m1", session_id: "ses_1", seq: 1, role: "user", text: "first", client_id: null, created: 1 },
      { id: "m2", session_id: "ses_1", seq: 2, role: "assistant", text: "second", client_id: null, created: 2 },
    ] }), { status: 200 });
  }
  if (url === "/api/sessions/ses_1/fork" && method === "POST") {
    return new Response(JSON.stringify({ session: { id: "ses_2", title: "Fork: Forks", created: 3, updated: 3 } }), { status: 201 });
  }
  if (url === "/api/sessions/ses_2/messages") return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/approvals?pending=1" || url === "/api/sessions/ses_2/approvals?pending=1") return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: "nope" } }), { status: 404 });
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  localStorage.clear();
  fetchMock.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function forkBody(): unknown {
  const call = fetchMock.mock.calls.find(([url]) => url === "/api/sessions/ses_1/fork");
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body ?? "null"));
}

describe("fork a conversation", () => {
  it("forks from a chosen message and opens the new conversation", async () => {
    render(<App />);
    const buttons = await screen.findAllByTestId("fork-message");
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0] as HTMLElement);
    await waitFor(() => expect(forkBody()).toEqual({ messageId: "m1" }));
    expect((await screen.findAllByText("Fork: Forks")).length).toBeGreaterThan(0);
  });

  it("forks the whole conversation with /fork", async () => {
    render(<App />);
    await screen.findAllByTestId("message");
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "/fork" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(forkBody()).toEqual({}));
    expect((await screen.findAllByText("Fork: Forks")).length).toBeGreaterThan(0);
  });
});
