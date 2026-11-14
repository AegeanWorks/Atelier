// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";
import HistoryPanel from "../../src/HistoryPanel";

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(_type: string, _listener: (event: MessageEvent) => void): void {}
  close(): void {}
}

const entries = [
  { commit: "a".repeat(40), createdAt: 1, message: "atelier-checkpoint test src/a.ts", path: "src/a.ts" },
  { commit: "b".repeat(40), createdAt: 2, message: "atelier-checkpoint test other.txt", path: "other.txt" },
];

const boot = {
  version: "0.1.0",
  workspace: "C:\\work",
  sessions: [{ id: "ses_1", title: "History", created: 1, updated: 1 }],
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
  if (url === "/api/checkpoints" && method === "GET") return new Response(JSON.stringify({ checkpoints: entries }), { status: 200 });
  if (url === "/api/checkpoints/restore" && method === "POST") return new Response(JSON.stringify(entries[0]), { status: 200 });
  if (url === "/api/checkpoints/restore-directory" && method === "POST") {
    return new Response(JSON.stringify({ directory: "src", restored: 1, paths: ["src/a.ts"] }), { status: 200 });
  }
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

describe("history panel", () => {
  it("lists checkpoints, restores a file and confirms a directory restore", async () => {
    render(<HistoryPanel refreshTick={0} />);
    const items = await screen.findAllByTestId("checkpoint-item");
    expect(items).toHaveLength(2);
    expect(screen.getByTestId("checkpoint-detail").textContent).toContain("src/a.ts");
    await waitFor(() => expect((screen.getByTestId("history-dir") as HTMLInputElement).value).toBe("src"));

    fireEvent.click(screen.getByTestId("checkpoint-restore"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/checkpoints/restore",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ commit: entries[0]?.commit, path: "src/a.ts" }) }),
      ),
    );

    fireEvent.click(screen.getByTestId("history-restore-dir"));
    fireEvent.click(screen.getByTestId("history-confirm-dir"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/checkpoints/restore-directory",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ path: "src" }) }),
      ),
    );
    expect((await screen.findByTestId("history-message")).textContent).toContain("Restored 1 file");
  });

  it("renders inside the History workspace tab", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("tab-history"));
    expect(await screen.findByTestId("history-panel")).toBeTruthy();
  });
});
