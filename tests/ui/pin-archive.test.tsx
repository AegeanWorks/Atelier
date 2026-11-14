// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";

class FakeEventSource {
  static latest: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeEventSource.latest = this;
  }
  addEventListener(): void {}
  close(): void {}
}

const active = [
  { id: "ses_a", title: "Alpha", created: 1, updated: 3, pinned: 1, archived: 0 },
  { id: "ses_b", title: "Beta", created: 1, updated: 2, pinned: 0, archived: 0 },
];
const archived = [{ id: "ses_c", title: "Gamma", created: 1, updated: 1, pinned: 0, archived: 1 }];

let current = [...active];

const boot = {
  version: "0.1.0",
  workspace: "C:\\work",
  sessions: active,
  profiles: [],
  providers: [],
  recovery: { startedAt: 0, finishedAt: 1, actionCount: 0, result: "clean", actions: [] },
};

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/sessions" && method === "GET") return new Response(JSON.stringify({ sessions: current }), { status: 200 });
  if (url === "/api/sessions?archived=1" && method === "GET") {
    return new Response(JSON.stringify({ sessions: archived }), { status: 200 });
  }
  if (url.startsWith("/api/sessions/ses_") && method === "PATCH") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { pinned?: boolean; archived?: boolean };
    const id = url.slice("/api/sessions/".length);
    current = current.map((session) =>
      session.id === id
        ? {
            ...session,
            pinned: body.pinned === undefined ? session.pinned : body.pinned ? 1 : 0,
            archived: body.archived === undefined ? session.archived : body.archived ? 1 : 0,
          }
        : session,
    );
    return new Response(JSON.stringify({ sessions: current }), { status: 200 });
  }
  if (url === "/api/sessions/ses_a/messages") return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  if (url === "/api/sessions/ses_a/approvals?pending=1") return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: url } }), { status: 404 });
});

function patchBodies(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === "PATCH")
    .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
}

beforeEach(() => {
  current = [...active];
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

async function ready(): Promise<void> {
  render(<App />);
  await screen.findByTestId("conversation-list");
}

describe("conversation pin and archive", () => {
  it("marks a pinned conversation and unpins it", async () => {
    await ready();
    expect(screen.getByLabelText("Pinned")).toBeTruthy();
    fireEvent.click(screen.getByTestId("conversation-unpin"));
    await waitFor(() => expect(patchBodies()).toContainEqual({ pinned: false }));
    await waitFor(() => expect(screen.queryByTestId("conversation-unpin")).toBeNull());
    expect(screen.queryByLabelText("Pinned")).toBeNull();
  });

  it("pins an unpinned conversation", async () => {
    await ready();
    const rows = screen.getAllByTestId("conversation-item");
    const beta = rows.find((row) => row.textContent?.includes("Beta"));
    expect(beta).toBeTruthy();
    const betaRow = beta?.closest("li") as HTMLElement;
    fireEvent.click(within(betaRow).getByTestId("conversation-pin"));
    await waitFor(() => expect(patchBodies()).toContainEqual({ pinned: true }));
    await waitFor(() => expect(screen.getAllByLabelText("Pinned")).toHaveLength(2));
  });

  it("archives a conversation and falls back to the next one", async () => {
    await ready();
    expect(screen.getByTestId("conversation-header").textContent).toContain("Alpha");
    fireEvent.click(screen.getAllByTestId("conversation-archive")[0]!);
    await waitFor(() => expect(patchBodies()).toContainEqual({ archived: true }));
    await waitFor(() => expect(screen.queryByText("Alpha")).toBeNull());
    expect((await screen.findByTestId("run-notice")).textContent).toContain("archived");
  });

  it("shows archived conversations and restores one", async () => {
    await ready();
    fireEvent.click(screen.getByTestId("toggle-archived"));
    await waitFor(() => expect(screen.getByTestId("conversation-list").textContent).toContain("Gamma"));
    expect(screen.getByTestId("conversation-list").textContent).not.toContain("Alpha");
    fireEvent.click(screen.getByTestId("conversation-unarchive"));
    await waitFor(() => expect(patchBodies()).toContainEqual({ archived: false }));
    expect((await screen.findByTestId("run-notice")).textContent).toContain("restored");
  });
});
