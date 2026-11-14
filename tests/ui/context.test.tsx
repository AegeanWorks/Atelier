// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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
  sessions: [{ id: "ses_1", title: "Ctx", created: 1, updated: 1 }],
  profiles: [],
  providers: [],
  recovery: { startedAt: 0, finishedAt: 1, actionCount: 0, result: "clean", actions: [] },
};
let context: { providerId: string; model: string; usedTokens: number; windowTokens: number | null } | null = null;

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/commands") return new Response(JSON.stringify({ commands: [] }), { status: 200 });
  if (url === "/api/usage?session=ses_1") {
    return new Response(JSON.stringify({ sessionId: "ses_1", requests: 1, replays: 0, promptTokens: 1, completionTokens: 1, cachedTokens: 0, costUsd: 0, unpricedRequests: 0, invalidEvents: 0, byModel: [], last: null, context }), { status: 200 });
  }
  if (url === "/api/sessions/ses_1/messages") return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/approvals?pending=1") return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: "nope" } }), { status: 404 });
});

beforeEach(() => {
  context = null;
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  localStorage.clear();
  fetchMock.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("context meter", () => {
  it("is absent before any request", async () => {
    render(<App />);
    await screen.findByTestId("statusbar");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/usage?session=ses_1", expect.anything()));
    expect(screen.queryByTestId("context-meter")).toBeNull();
  });

  it("shows the percentage with a plain-language title", async () => {
    context = { providerId: "p", model: "gpt-4.1", usedTokens: 42_000, windowTokens: 128_000 };
    render(<App />);
    const meter = await screen.findByTestId("context-meter");
    expect(meter.textContent).toBe("ctx 33%");
    expect(meter.className).toContain("status-ok");
    expect(meter.getAttribute("title")).toContain("42,000 of 128,000");
  });

  it("turns amber then red as the window fills and suggests /compact", async () => {
    context = { providerId: "p", model: "m", usedTokens: 80_000, windowTokens: 100_000 };
    const first = render(<App />);
    expect((await screen.findByTestId("context-meter")).className).toContain("status-warn");
    first.unmount();
    cleanup();
    context = { providerId: "p", model: "m", usedTokens: 95_000, windowTokens: 100_000 };
    render(<App />);
    const meter = await screen.findByTestId("context-meter");
    expect(meter.className).toContain("status-bad");
    expect(meter.getAttribute("title")).toMatch(/\/compact/);
  });

  it("shows a plain token count when the window is unknown", async () => {
    context = { providerId: "p", model: "mystery", usedTokens: 12_345, windowTokens: null };
    render(<App />);
    expect((await screen.findByTestId("context-meter")).textContent).toBe("ctx 12.3k");
  });
});
