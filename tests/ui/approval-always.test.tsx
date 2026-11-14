// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";

const listeners = new Map<string, Array<(event: MessageEvent) => void>>();
class FakeEventSource {
  static latest: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeEventSource.latest = this;
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const current = listeners.get(type) ?? [];
    current.push(listener);
    listeners.set(type, current);
  }
  close(): void {}
}
function emit(type: string, data: unknown): void {
  for (const listener of listeners.get(type) ?? []) listener({ data: JSON.stringify(data) } as MessageEvent);
}

const boot = {
  version: "0.1.0",
  workspace: "/work",
  sessions: [{ id: "ses_1", title: "Always", created: 1, updated: 1 }],
  profiles: [],
  providers: [],
  recovery: { startedAt: 0, finishedAt: 1, actionCount: 0, result: "clean", actions: [] },
};
let rules: Array<Record<string, unknown>> = [];
let saveFails = false;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/commands") return new Response(JSON.stringify({ commands: [] }), { status: 200 });
  if (url === "/api/config" && method === "GET") return new Response(JSON.stringify({ providers: [], roles: {}, defaults: {}, mcpServers: [], hooks: [], rules }), { status: 200 });
  if (url === "/api/config" && method === "PUT") {
    if (saveFails) return new Response(JSON.stringify({ error: { code: "CONFIG_INVALID", what: "Config payload is invalid.", why: "bad", fix: "retry" } }), { status: 400 });
    rules = (JSON.parse(String(init?.body ?? "{}")) as { rules: Array<Record<string, unknown>> }).rules;
    return new Response(JSON.stringify({ rules }), { status: 200 });
  }
  if (url === "/api/sessions/ses_1/messages") return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/approvals?pending=1") return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
  if (url === "/api/runs/run_1/approvals/ap_1" && method === "POST") return new Response(JSON.stringify({ approval: { id: "ap_1", status: "approved" } }), { status: 200 });
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: "nope" } }), { status: 404 });
});

beforeEach(() => {
  listeners.clear();
  FakeEventSource.latest = null;
  rules = [];
  saveFails = false;
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  localStorage.clear();
  fetchMock.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function request(tool: string, action: string, resource: string): Promise<void> {
  render(<App />);
  await screen.findByText("What are we building?");
  await waitFor(() => expect(FakeEventSource.latest).not.toBeNull());
  emit("approval.request", { approvalId: "ap_1", runId: "run_1", callId: "c1", tool, action, resource, reason: "requires approval" });
  await screen.findByTestId("approval-dock");
}

describe("always allow", () => {
  it("saves an exact-match allow rule and then approves the call", async () => {
    await request("bash", "exec", "npm test");
    fireEvent.click(screen.getByTestId("approval-always"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/runs/run_1/approvals/ap_1", expect.objectContaining({ method: "POST" })));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ action: "exec", match: "npm test", decision: "allow" });
    const order = fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${String(url)}`);
    expect(order.indexOf("PUT /api/config")).toBeLessThan(order.indexOf("POST /api/runs/run_1/approvals/ap_1"));
    await waitFor(() => expect(screen.queryByTestId("approval-dock")).toBeNull());
  });

  it("keeps the existing rules when adding one", async () => {
    rules = [{ id: "docs", action: "edit", match: "docs/*", decision: "allow" }];
    await request("write_file", "edit", "notes.txt");
    fireEvent.click(screen.getByTestId("approval-always"));
    await waitFor(() => expect(rules).toHaveLength(2));
    expect(rules[0]).toMatchObject({ id: "docs" });
  });

  it("does not approve when the rule could not be saved", async () => {
    saveFails = true;
    await request("bash", "exec", "npm test");
    fireEvent.click(screen.getByTestId("approval-always"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/config" && (init as RequestInit | undefined)?.method === "PUT")).toBe(true));
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/runs/run_1/approvals/ap_1")).toBe(false);
    expect(screen.getByTestId("approval-dock")).toBeTruthy();
  });

  it("is not offered for a chained command", async () => {
    await request("bash", "exec", "npm test && rm -rf x");
    expect(screen.queryByTestId("approval-always")).toBeNull();
    expect(screen.getByTestId("approval-approve")).toBeTruthy();
  });
});
