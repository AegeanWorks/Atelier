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
  sessions: [{ id: "ses_1", title: "Undo", created: 1, updated: 1 }],
  profiles: [],
  providers: [],
  recovery: { startedAt: 0, finishedAt: 1, actionCount: 0, result: "clean", actions: [] },
};
const NEWEST = "b".repeat(40);
const OLDER = "a".repeat(40);
let checkpoints: Array<{ commit: string; createdAt: number; message: string; path: string }> = [];
let restoreFails = false;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/commands") return new Response(JSON.stringify({ commands: [] }), { status: 200 });
  if (url === "/api/checkpoints" && method === "GET") return new Response(JSON.stringify({ checkpoints }), { status: 200 });
  if (url === "/api/checkpoints/restore" && method === "POST") {
    if (restoreFails) return new Response(JSON.stringify({ error: { code: "CHECKPOINT_COMMIT", what: "Invalid checkpoint object.", why: "gone", fix: "refresh" } }), { status: 400 });
    return new Response(JSON.stringify({ commit: NEWEST, createdAt: 3, message: "restored", path: "src/a.ts" }), { status: 200 });
  }
  if (url === "/api/sessions/ses_1/messages") return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/approvals?pending=1") return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/runs" && method === "POST") {
    return new Response(JSON.stringify({ run: { id: "run_1", status: "running" }, message: { id: "m1", session_id: "ses_1", seq: 1, role: "user", text: "x", client_id: null, created: 1 } }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: "nope" } }), { status: 404 });
});

beforeEach(() => {
  checkpoints = [
    { commit: NEWEST, createdAt: 2, message: "atelier-checkpoint edit_file src/a.ts", path: "src/a.ts" },
    { commit: OLDER, createdAt: 1, message: "atelier-checkpoint write_file other.txt", path: "other.txt" },
  ];
  restoreFails = false;
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

function restores(): Array<{ commit: string; path: string }> {
  return fetchMock.mock.calls
    .filter(([url, init]) => url === "/api/checkpoints/restore" && (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

describe("/undo", () => {
  it("restores the file from the newest checkpoint and says how to redo", async () => {
    render(<App />);
    await command("/undo");
    await waitFor(() => expect(restores()).toEqual([{ commit: NEWEST, path: "src/a.ts" }]));
    const notice = (await screen.findAllByText(/src\/a\.ts/)).at(0)?.textContent ?? "";
    expect(notice).toMatch(/before the agent's last edit/i);
    expect(notice).toMatch(/\/undo again/i);
  });

  it("says so when there is nothing to undo", async () => {
    checkpoints = [];
    render(<App />);
    await command("/undo");
    expect((await screen.findAllByText(/No edits to undo/)).length).toBeGreaterThan(0);
    expect(restores()).toHaveLength(0);
  });

  it("refuses while a run is working so it cannot race the agent", async () => {
    render(<App />);
    const input = await screen.findByTestId("composer-input");
    fireEvent.change(input, { target: { value: "do something" } });
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/sessions/ses_1/runs")).toBe(true));
    await command("/undo");
    expect((await screen.findAllByText(/Stop it or wait/)).length).toBeGreaterThan(0);
    expect(restores()).toHaveLength(0);
  });

  it("shows the error and leaves things alone when the restore fails", async () => {
    restoreFails = true;
    render(<App />);
    await command("/undo");
    expect((await screen.findAllByText(/Invalid checkpoint object/)).length).toBeGreaterThan(0);
  });
});
