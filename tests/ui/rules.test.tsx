// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPanel from "../../src/SettingsPanel";

let rules: Array<Record<string, unknown>> = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  const base = { providers: [], roles: { executor: null, manager: null, auditor: null, compactor: null }, defaults: { provider: null, model: null }, mcpServers: [], hooks: [] };
  if (url === "/api/config" && method === "GET") return new Response(JSON.stringify({ ...base, rules }), { status: 200 });
  if (url === "/api/config" && method === "PUT") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { rules?: Array<Record<string, unknown>> };
    rules = body.rules ?? rules;
    return new Response(JSON.stringify({ ...base, rules }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { code: "UNEXPECTED", what: url } }), { status: 500 });
});

beforeEach(() => {
  rules = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function lastPut(): { rules: Array<Record<string, unknown>> } {
  const call = fetchMock.mock.calls.filter(([url, init]) => url === "/api/config" && (init as RequestInit | undefined)?.method === "PUT").at(-1);
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body ?? "{}"));
}

describe("settings permission rules", () => {
  it("explains the empty state and lists existing rules with their decision", async () => {
    rules = [{ id: "tests", action: "exec", match: "npm test*", decision: "allow" }, { id: "frozen", action: "edit", match: "dist/*", decision: "deny" }];
    render(<SettingsPanel />);
    const rows = await screen.findAllByTestId("rule-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("allow");
    expect(rows[0]?.textContent).toContain("npm test*");
    expect(rows[1]?.textContent).toContain("deny");
  });

  it("adds a rule with a derived id and saves the whole list", async () => {
    render(<SettingsPanel />);
    expect((await screen.findByTestId("rules-card")).textContent).toContain("No rules");
    expect(await screen.findByTestId("rules-empty")).toBeTruthy();
    fireEvent.change(screen.getByTestId("rule-name"), { target: { value: "Run Tests" } });
    fireEvent.change(screen.getByTestId("rule-action"), { target: { value: "exec" } });
    fireEvent.change(screen.getByTestId("rule-match"), { target: { value: "npm test*" } });
    fireEvent.change(screen.getByTestId("rule-decision"), { target: { value: "allow" } });
    fireEvent.click(screen.getByTestId("save-rule"));
    await waitFor(() => expect(lastPut().rules).toEqual([{ id: "run-tests", action: "exec", match: "npm test*", decision: "allow" }]));
    expect((await screen.findAllByTestId("rule-row")).length).toBe(1);
  });

  it("warns when an allow rule would cover everything", async () => {
    render(<SettingsPanel />);
    await screen.findByTestId("rules-card");
    fireEvent.change(screen.getByTestId("rule-name"), { target: { value: "all" } });
    fireEvent.change(screen.getByTestId("rule-match"), { target: { value: "*" } });
    fireEvent.change(screen.getByTestId("rule-decision"), { target: { value: "allow" } });
    fireEvent.click(screen.getByTestId("save-rule"));
    expect((await screen.findByTestId("settings-error")).textContent).toMatch(/too broad/i);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(false);
  });

  it("refuses a duplicate name", async () => {
    rules = [{ id: "tests", action: "exec", match: "npm test*", decision: "allow" }];
    render(<SettingsPanel />);
    await screen.findAllByTestId("rule-row");
    fireEvent.change(screen.getByTestId("rule-name"), { target: { value: "Tests" } });
    fireEvent.change(screen.getByTestId("rule-match"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("save-rule"));
    expect((await screen.findByTestId("settings-error")).textContent).toMatch(/already exists/i);
  });

  it("removes a rule only after a second confirming click", async () => {
    rules = [{ id: "tests", action: "exec", match: "npm test*", decision: "allow" }];
    render(<SettingsPanel />);
    fireEvent.click(await screen.findByTestId("rule-remove"));
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(false);
    fireEvent.click(screen.getByTestId("rule-remove-confirm"));
    await waitFor(() => expect(lastPut().rules).toEqual([]));
  });
});
