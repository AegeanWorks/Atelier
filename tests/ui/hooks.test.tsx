// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPanel from "../../src/SettingsPanel";

let hooks: Array<Record<string, unknown>> = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  const base = { providers: [], roles: { executor: null, manager: null, auditor: null, compactor: null }, defaults: { provider: null, model: null }, mcpServers: [] };
  if (url === "/api/config" && method === "GET") return new Response(JSON.stringify({ ...base, hooks }), { status: 200 });
  if (url === "/api/config" && method === "PUT") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { hooks?: Array<Record<string, unknown>> };
    hooks = (body.hooks ?? hooks).map((hook) => ({ timeoutMs: 10_000, ...hook }));
    return new Response(JSON.stringify({ ...base, hooks }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { code: "UNEXPECTED", what: url } }), { status: 500 });
});

beforeEach(() => {
  hooks = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function putBody(): { hooks: Array<Record<string, unknown>> } {
  const call = fetchMock.mock.calls.filter(([url, init]) => url === "/api/config" && (init as RequestInit | undefined)?.method === "PUT").at(-1);
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body ?? "{}"));
}

describe("settings hooks", () => {
  it("says so when no hooks are configured and lists existing ones", async () => {
    hooks = [{ id: "guard", event: "pre_tool", match: "bash", command: "echo hi", timeoutMs: 10_000 }];
    render(<SettingsPanel />);
    const rows = await screen.findAllByTestId("hook-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("guard");
    expect(rows[0]?.textContent).toContain("pre_tool");
    expect(rows[0]?.textContent).toContain("bash");
    expect(rows[0]?.textContent).toContain("echo hi");
  });

  it("adds a hook with a derived id and saves the whole list", async () => {
    render(<SettingsPanel />);
    expect((await screen.findByTestId("hooks-card")).textContent).toContain("No hooks configured");
    fireEvent.change(screen.getByTestId("hook-name"), { target: { value: "Block Writes" } });
    fireEvent.change(screen.getByTestId("hook-event"), { target: { value: "pre_tool" } });
    fireEvent.change(screen.getByTestId("hook-match"), { target: { value: "write_file|edit_file" } });
    fireEvent.change(screen.getByTestId("hook-command"), { target: { value: "node check.js" } });
    fireEvent.click(screen.getByTestId("save-hook"));
    await waitFor(() => expect(putBody().hooks).toEqual([{ id: "block-writes", event: "pre_tool", match: "write_file|edit_file", command: "node check.js" }]));
    expect((await screen.findAllByTestId("hook-row")).length).toBe(1);
    expect((screen.getByTestId("hook-name") as HTMLInputElement).value).toBe("");
  });

  it("refuses an invalid match pattern before sending anything", async () => {
    render(<SettingsPanel />);
    await screen.findByTestId("hooks-card");
    fireEvent.change(screen.getByTestId("hook-name"), { target: { value: "bad" } });
    fireEvent.change(screen.getByTestId("hook-match"), { target: { value: "(" } });
    fireEvent.change(screen.getByTestId("hook-command"), { target: { value: "echo" } });
    fireEvent.click(screen.getByTestId("save-hook"));
    expect((await screen.findByTestId("settings-error")).textContent).toMatch(/regular expression/i);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(false);
  });

  it("refuses a duplicate name", async () => {
    hooks = [{ id: "guard", event: "pre_tool", match: ".*", command: "echo", timeoutMs: 10_000 }];
    render(<SettingsPanel />);
    await screen.findAllByTestId("hook-row");
    fireEvent.change(screen.getByTestId("hook-name"), { target: { value: "Guard" } });
    fireEvent.change(screen.getByTestId("hook-command"), { target: { value: "echo" } });
    fireEvent.click(screen.getByTestId("save-hook"));
    expect((await screen.findByTestId("settings-error")).textContent).toMatch(/already exists/i);
  });

  it("removes a hook only after a second confirming click", async () => {
    hooks = [{ id: "guard", event: "pre_tool", match: ".*", command: "echo", timeoutMs: 10_000 }];
    render(<SettingsPanel />);
    fireEvent.click(await screen.findByTestId("hook-remove"));
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(false);
    fireEvent.click(screen.getByTestId("hook-remove-confirm"));
    await waitFor(() => expect(putBody().hooks).toEqual([]));
    await waitFor(() => expect(screen.queryAllByTestId("hook-row")).toHaveLength(0));
  });
});
