// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";
import { INIT_PROMPT } from "../../src/slash";

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(_type: string, _listener: (event: MessageEvent) => void): void {}
  close(): void {}
}

const boot = {
  version: "0.1.0",
  workspace: "/work",
  sessions: [{ id: "ses_1", title: "Init", created: 1, updated: 1 }],
  profiles: [],
  providers: [],
  recovery: { startedAt: 0, finishedAt: 1, actionCount: 0, result: "clean", actions: [] },
};
let existing: string[] = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/commands") return new Response(JSON.stringify({ commands: [] }), { status: 200 });
  if (url === "/api/workspace/tree") return new Response(JSON.stringify({ entries: [] }), { status: 200 });
  if (url.startsWith("/api/workspace/file?path=")) {
    const path = decodeURIComponent(url.split("path=")[1] ?? "");
    if (existing.includes(path)) return new Response(JSON.stringify({ path, content: `# ${path}\n`, hash: "h", size: 5 }), { status: 200 });
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: "No such file.", why: "x", fix: "y" } }), { status: 404 });
  }
  if (url === "/api/sessions/ses_1/messages") return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/approvals?pending=1") return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/runs" && method === "POST") {
    return new Response(JSON.stringify({ run: { id: "run_1", status: "running" }, message: { id: "m1", session_id: "ses_1", seq: 1, role: "user", text: "x", client_id: null, created: 1 } }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: "nope" } }), { status: 404 });
});

beforeEach(() => {
  existing = [];
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  localStorage.clear();
  fetchMock.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function command(text: string): Promise<void> {
  const input = await screen.findByTestId("composer-input");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("project instructions commands", () => {
  it("/init sends the canned prompt in build mode, even while the UI is in plan mode", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Plan" }));
    await command("/init");
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => url === "/api/sessions/ses_1/runs");
      const body = JSON.parse(String((call?.[1] as RequestInit | undefined)?.body ?? "{}"));
      expect(body.prompt).toBe(INIT_PROMPT);
      expect(body.mode).toBe("build");
    });
  });

  it("/instructions opens AGENTS.md in the Files panel", async () => {
    existing = ["AGENTS.md"];
    render(<App />);
    await command("/instructions");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/workspace/file?path=AGENTS.md", expect.anything()));
    expect(await screen.findByDisplayValue(/# AGENTS\.md/)).toBeTruthy();
  });

  it("/instructions falls back to CLAUDE.md", async () => {
    existing = ["CLAUDE.md"];
    render(<App />);
    await command("/instructions");
    expect(await screen.findByDisplayValue(/# CLAUDE\.md/)).toBeTruthy();
  });

  it("/instructions points to /init when neither file exists", async () => {
    render(<App />);
    await command("/instructions");
    expect((await screen.findAllByText(/Run \/init/)).length).toBeGreaterThan(0);
  });
});
