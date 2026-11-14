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
  sessions: [{ id: "ses_1", title: "Models", created: 1, updated: 1 }],
  profiles: [],
  providers: [],
  recovery: { startedAt: 0, finishedAt: 1, actionCount: 0, result: "clean", actions: [] },
};
let defaults: { provider: string | null; model: string | null } = { provider: "local", model: "alpha" };
let catalog: Array<{ id: string; providerId: string }> = [{ id: "alpha", providerId: "local" }, { id: "beta", providerId: "local" }, { id: "gamma", providerId: "cloud" }];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/commands") return new Response(JSON.stringify({ commands: [] }), { status: 200 });
  if (url === "/api/config" && method === "GET") return new Response(JSON.stringify({ providers: [], roles: {}, defaults, mcpServers: [], hooks: [], rules: [] }), { status: 200 });
  if (url === "/api/config" && method === "PUT") {
    defaults = (JSON.parse(String(init?.body ?? "{}")) as { defaults: typeof defaults }).defaults;
    return new Response(JSON.stringify({ defaults }), { status: 200 });
  }
  if (url === "/api/models") return new Response(JSON.stringify({ models: catalog }), { status: 200 });
  if (url === "/api/sessions/ses_1/messages") return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/approvals?pending=1") return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: "nope" } }), { status: 404 });
});

beforeEach(() => {
  defaults = { provider: "local", model: "alpha" };
  catalog = [{ id: "alpha", providerId: "local" }, { id: "beta", providerId: "local" }, { id: "gamma", providerId: "cloud" }];
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

function puts(): Array<{ defaults: { provider: string | null; model: string | null } }> {
  return fetchMock.mock.calls
    .filter(([url, init]) => url === "/api/config" && (init as RequestInit | undefined)?.method === "PUT")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

describe("/model", () => {
  it("shows the current model and the ones you can switch to", async () => {
    render(<App />);
    await command("/model ");
    const notice = (await screen.findAllByText(/Current model/)).at(0)?.textContent ?? "";
    expect(notice).toContain("alpha");
    expect(notice).toContain("beta");
    expect(notice).toContain("gamma");
    expect(puts()).toHaveLength(0);
  });

  it("switches the default model, keeping its provider", async () => {
    render(<App />);
    await command("/model beta");
    await waitFor(() => expect(puts()).toEqual([{ defaults: { provider: "local", model: "beta" } }]));
    expect((await screen.findAllByText(/Model set to beta/)).length).toBeGreaterThan(0);
  });

  it("moves to the provider that owns the chosen model", async () => {
    render(<App />);
    await command("/model gamma");
    await waitFor(() => expect(puts()).toEqual([{ defaults: { provider: "cloud", model: "gamma" } }]));
  });

  it("prefers the current provider when two providers list the same model id", async () => {
    catalog = [{ id: "shared", providerId: "cloud" }, { id: "shared", providerId: "local" }];
    render(<App />);
    await command("/model shared");
    await waitFor(() => expect(puts()).toEqual([{ defaults: { provider: "local", model: "shared" } }]));
  });

  it("refuses a model that is not in the catalog and changes nothing", async () => {
    render(<App />);
    await command("/model nope");
    expect((await screen.findAllByText(/nope is not in the model list/)).length).toBeGreaterThan(0);
    expect(puts()).toHaveLength(0);
  });

  it("points to Settings when no provider has any models", async () => {
    catalog = [];
    render(<App />);
    await command("/model beta");
    expect((await screen.findAllByText(/Add a provider/)).length).toBeGreaterThan(0);
    expect(puts()).toHaveLength(0);
  });

  it("picking /model from the menu inserts it for you to finish instead of running it", async () => {
    render(<App />);
    const input = await screen.findByTestId("composer-input");
    fireEvent.change(input, { target: { value: "/mod" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).value).toBe("/model "));
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/models")).toBe(false);
  });

  it("does not treat Enter on ordinary text or an unknown /word as a command", async () => {
    render(<App />);
    const input = await screen.findByTestId("composer-input");
    fireEvent.change(input, { target: { value: "/usr/bin is where it lives" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "/unknownthing beta" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/models" || String(url).endsWith("/runs"))).toBe(false);
  });
});
