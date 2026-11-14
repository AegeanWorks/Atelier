// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

const boot = {
  version: "0.1.0",
  workspace: "C:\\work",
  sessions: [],
  profiles: [],
  providers: [],
  recovery: {
    startedAt: 0,
    finishedAt: 1,
    actionCount: 1,
    result: "recovered",
    actions: ["expired 1 lease(s)"],
  },
};

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: url } }), { status: 404 });
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

describe("recovery banner", () => {
  it("counts actions rather than runs and names the recorded action", async () => {
    render(<App />);
    const banner = await screen.findByTestId("recovery-banner");
    expect(banner.textContent).toContain("Recovered 1 action(s)");
    expect(banner.textContent).not.toContain("run(s)");
    expect(banner.textContent).toContain("recovered");
  });
});
