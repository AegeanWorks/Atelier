// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";
import UsagePanel from "../../src/UsagePanel";

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(_type: string, _listener: (event: MessageEvent) => void): void {}
  close(): void {}
}

let sessionUsage: Record<string, unknown> = {
  sessionId: "ses_1",
  requests: 1,
  replays: 0,
  promptTokens: 1000,
  completionTokens: 500,
  cachedTokens: 0,
  costUsd: 0.006,
  unpricedRequests: 0,
  invalidEvents: 0,
  byModel: [{ providerId: "openai", model: "gpt-4.1", requests: 1, promptTokens: 1000, completionTokens: 500, costUsd: 0.006 }],
};
const baseSessionUsage = sessionUsage;

const globalUsage = {
  sessionId: null,
  requests: 2,
  replays: 1,
  promptTokens: 1500,
  completionTokens: 800,
  cachedTokens: 0,
  costUsd: 0.01,
  unpricedRequests: 0,
  invalidEvents: 0,
  byModel: [{ providerId: "openai", model: "gpt-4.1", requests: 2, promptTokens: 1500, completionTokens: 800, costUsd: 0.01 }],
};

const boot = {
  version: "0.1.0",
  workspace: "C:\\work",
  sessions: [{ id: "ses_1", title: "Usage", created: 1, updated: 1 }],
  profiles: [],
  providers: [],
  recovery: { startedAt: 0, finishedAt: 1, actionCount: 0, result: "clean", actions: [] },
};

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/sessions/ses_1/messages") return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/approvals?pending=1") return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
  if (url === "/api/usage?session=ses_1") return new Response(JSON.stringify(sessionUsage), { status: 200 });
  if (url === "/api/usage") return new Response(JSON.stringify(globalUsage), { status: 200 });
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: "nope" } }), { status: 404 });
});

beforeEach(() => {
  sessionUsage = baseSessionUsage;
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  localStorage.clear();
  fetchMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("usage panel", () => {
  it("renders session and global totals with a per-model breakdown", async () => {
    render(<UsagePanel sessionId="ses_1" />);
    expect((await screen.findByTestId("usage-session-requests")).textContent).toBe("1");
    expect(screen.getByTestId("usage-session-prompt").textContent).toBe("1000");
    expect(screen.getByTestId("usage-session-completion").textContent).toBe("500");
    expect(screen.getByTestId("usage-session-cost").textContent).toBe("$0.006000");
    expect(screen.getByTestId("usage-global-requests").textContent).toBe("2");
    expect(screen.getByTestId("usage-global-replays").textContent).toBe("1");
    expect((await screen.findByTestId("usage-model")).textContent).toContain("gpt-4.1");
  });

  it("puts the live session totals in the status bar", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    await waitFor(() => expect(screen.getByTestId("statusbar").textContent).toContain("tokens 1500"));
    expect(screen.getByTestId("statusbar").textContent).toContain("$0.006000");
  });

  it("shows how much of the session's spend came from sub-agents", async () => {
    sessionUsage = { ...baseSessionUsage, requests: 3, costUsd: 0.01, delegated: { requests: 2, costUsd: 0.004 } };
    render(<UsagePanel sessionId="ses_1" />);
    const row = await screen.findByTestId("usage-session-delegated");
    expect(row.textContent).toContain("2 requests");
    expect(row.textContent).toContain("$0.004000");
  });

  it("shows no sub-agent row when nothing was delegated", async () => {
    sessionUsage = { ...baseSessionUsage, delegated: { requests: 0, costUsd: 0 } };
    render(<UsagePanel sessionId="ses_1" />);
    await screen.findByTestId("usage-session-requests");
    expect(screen.queryByTestId("usage-session-delegated")).toBeNull();
  });

  it("renders empty state when no model usage is recorded", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/usage") return new Response(JSON.stringify({ ...globalUsage, byModel: [] }), { status: 200 });
      if (url === "/api/usage?session=ses_1") return new Response(JSON.stringify(sessionUsage), { status: 200 });
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 });
    });
    render(<UsagePanel sessionId="ses_1" />);
    const empty = await screen.findByTestId("usage-empty");
    expect(empty.textContent).toContain("No provider usage recorded yet.");
  });
});
