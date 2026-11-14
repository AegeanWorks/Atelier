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
  sessions: [{ id: "ses_1", title: "Plan it", created: 1, updated: 1 }],
  profiles: [],
  providers: [],
  recovery: { startedAt: 0, finishedAt: 1, actionCount: 0, result: "clean", actions: [] },
};
let lastAssistant = true;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/commands") return new Response(JSON.stringify({ commands: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/messages") {
    const messages = [{ id: "m1", session_id: "ses_1", seq: 1, role: "user", text: "plan a fix", client_id: null, created: 1 }];
    if (lastAssistant) messages.push({ id: "m2", session_id: "ses_1", seq: 2, role: "assistant", text: "1. do x", client_id: null, created: 2 });
    return new Response(JSON.stringify({ messages }), { status: 200 });
  }
  if (url === "/api/sessions/ses_1/approvals?pending=1") return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/runs" && method === "POST") {
    return new Response(JSON.stringify({ run: { id: "run_1", status: "running" }, message: { id: "m3", session_id: "ses_1", seq: 3, role: "user", text: "x", client_id: null, created: 3 } }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: "nope" } }), { status: 404 });
});

beforeEach(() => {
  lastAssistant = true;
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  localStorage.clear();
  fetchMock.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("plan to build handoff", () => {
  it("offers Build this plan only in plan mode after an assistant reply", async () => {
    render(<App />);
    await screen.findByTestId("composer-input");
    expect(screen.queryByTestId("handoff")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(await screen.findByTestId("handoff")).toBeTruthy();
  });

  it("switches to build mode and sends the implement prompt", async () => {
    render(<App />);
    await screen.findByTestId("composer-input");
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    fireEvent.click(await screen.findByTestId("handoff-build"));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => url === "/api/sessions/ses_1/runs");
      const body = JSON.parse(String((call?.[1] as RequestInit | undefined)?.body ?? "{}"));
      expect(body.mode).toBe("build");
      expect(body.prompt).toMatch(/Implement the plan/);
    });
    expect(screen.getByRole("button", { name: "Build" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("stays hidden when there is no assistant reply yet", async () => {
    lastAssistant = false;
    render(<App />);
    await screen.findByTestId("composer-input");
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(screen.queryByTestId("handoff")).toBeNull();
  });
});
