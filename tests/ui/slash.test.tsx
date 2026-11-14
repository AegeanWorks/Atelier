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
  sessions: [{ id: "ses_1", title: "Slash", created: 1, updated: 1 }],
  profiles: [],
  providers: [],
  recovery: { startedAt: 0, finishedAt: 1, actionCount: 0, result: "clean", actions: [] },
};

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/commands") {
    return new Response(JSON.stringify({ commands: [{ name: "review", description: "Review the diff", kind: "custom", template: "Review: $ARGUMENTS" }] }), { status: 200 });
  }
  if (url === "/api/workspace/files") return new Response(JSON.stringify({ files: ["src/App.tsx", "src/api.ts", "README.md"] }), { status: 200 });
  if (url === "/api/sessions/ses_1/messages") {
    return new Response(JSON.stringify({ messages: [{ id: "m0", session_id: "ses_1", seq: 1, role: "user", text: "see @a.ts\n\n<attached_file path=\"a.ts\">\nBODY\n</attached_file>", client_id: null, created: 1 }] }), { status: 200 });
  }
  if (url === "/api/sessions/ses_1/approvals?pending=1") return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/compact" && method === "POST") {
    return new Response(JSON.stringify({ session: { id: "ses_2", title: "Compacted: Slash", created: 2, updated: 2 }, summary: "s" }), { status: 201 });
  }
  if (url === "/api/sessions/ses_2/messages") return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  if (url === "/api/sessions/ses_2/approvals?pending=1") return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/runs" && method === "POST") {
    return new Response(JSON.stringify({ run: { id: "run_1", status: "running" }, message: { id: "m1", role: "user", text: "x", seq: 2, created: 1 } }), { status: 200 });
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

function type(value: string): HTMLTextAreaElement {
  const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value } });
  return input;
}

describe("composer slash commands", () => {
  it("lists built-in and custom commands and filters as you type", async () => {
    render(<App />);
    await screen.findByTestId("composer-input");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/commands", expect.anything()));
    type("/");
    const all = await screen.findAllByTestId("slash-option");
    expect(all.map((node) => node.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("/plan"), expect.stringContaining("/review")]));
    type("/rev");
    expect(screen.getAllByTestId("slash-option")).toHaveLength(1);
    type("hello");
    expect(screen.queryByTestId("slash-menu")).toBeNull();
  });

  it("runs a built-in on Enter without sending a message", async () => {
    render(<App />);
    await screen.findByTestId("composer-input");
    const input = type("/plan");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Plan" }).getAttribute("aria-pressed")).toBe("true"));
    expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).value).toBe("");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/runs"))).toBe(false);
  });

  it("expands a custom command with its arguments when sent", async () => {
    render(<App />);
    await screen.findByTestId("composer-input");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/commands", expect.anything()));
    type("/review src/a.ts");
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => url === "/api/sessions/ses_1/runs");
      const init = call?.[1] as RequestInit | undefined;
      expect(JSON.parse(String(init?.body ?? "{}")).prompt).toBe("Review: src/a.ts");
    });
  });

  it("tells you when a command is unknown instead of sending it", async () => {
    render(<App />);
    await screen.findByTestId("composer-input");
    type("/nope now");
    fireEvent.click(screen.getByTestId("send-button"));
    expect((await screen.findAllByText(/Unknown command/)).length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/runs"))).toBe(false);
  });

  it("suggests workspace files after @ and inserts the chosen path", async () => {
    render(<App />);
    const input = await screen.findByTestId("composer-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "see @ap", selectionStart: 7 } });
    input.setSelectionRange(7, 7);
    fireEvent.select(input);
    const options = await screen.findAllByTestId("mention-option");
    expect(options.map((node) => node.textContent)).toEqual([expect.stringContaining("api.ts"), expect.stringContaining("App.tsx")]);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).value).toBe("see @src/api.ts "));
    expect(screen.queryByTestId("mention-menu")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/runs"))).toBe(false);
  });

  it("shows attached files as chips without dumping their contents", async () => {
    render(<App />);
    const row = await screen.findByTestId("attachment-row");
    expect(row.textContent).toBe("a.ts");
    expect(screen.queryByText(/BODY/)).toBeNull();
  });

  it("compacts the conversation into a new one and opens it", async () => {
    render(<App />);
    const input = await screen.findByTestId("composer-input");
    await screen.findAllByTestId("message");
    type("/compact");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/sessions/ses_1/compact", expect.objectContaining({ method: "POST" })));
    expect((await screen.findAllByText("Compacted: Slash")).length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/runs"))).toBe(false);
  });
});
