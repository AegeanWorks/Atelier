// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPanel from "../../src/SettingsPanel";

function configView(overrides: Record<string, unknown> = {}) {
  return {
    providers: [
      {
        id: "local",
        name: "Local",
        protocol: "openai-chat",
        baseUrl: "http://127.0.0.1:1234/v1",
        defaultModel: null,
        modelCount: 0,
        key: { set: true, source: "secret" },
      },
    ],
    roles: { executor: null, manager: null, auditor: null, compactor: null },
    defaults: { provider: null, model: null },
    mcpServers: [],
    ...overrides,
  };
}

const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  if (url === "/api/config" && method === "GET") {
    return new Response(JSON.stringify(configView()), { status: 200 });
  }
  if (url === "/api/providers/local" && method === "PUT") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; baseUrl?: string; apiKey?: string; clearKey?: boolean };
    const view = configView();
    return new Response(JSON.stringify({
      provider: {
        ...view.providers[0],
        name: body.name ?? "Local",
        baseUrl: body.baseUrl ?? "http://127.0.0.1:1234/v1",
        key: { set: body.clearKey === true ? false : body.apiKey !== undefined ? true : true, source: "secret" },
      },
    }), { status: 200 });
  }
  if (url === "/api/config" && method === "PUT") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { defaults?: { provider: string | null; model: string | null }; mcpServers?: unknown[] };
    return new Response(JSON.stringify({
      roles: configView().roles,
      defaults: body.defaults ?? { provider: null, model: null },
      mcpServers: body.mcpServers ?? [],
    }), { status: 200 });
  }
  if (url === "/api/models?provider=local" && method === "GET") {
    return new Response(JSON.stringify({ models: [{ id: "qwen2.5-coder-7b" }, { id: "llama-3.2-3b" }], providerId: "local" }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { code: "UNEXPECTED", what: url } }), { status: 500 });
};

const fetchMock = vi.fn(baseFetch);

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(baseFetch);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("settings provider editing", () => {
  it("updates a provider in place without removing it", async () => {
    render(<SettingsPanel />);
    fireEvent.click(await screen.findByTestId("edit-provider-local"));
    const name = (await screen.findByTestId("edit-provider-name")) as HTMLInputElement;
    expect(name.value).toBe("Local");
    fireEvent.change(name, { target: { value: "Local server" } });
    fireEvent.change(screen.getByTestId("edit-provider-url"), { target: { value: "http://127.0.0.1:4321/v1" } });
    fireEvent.change(screen.getByTestId("edit-provider-key"), { target: { value: "sk-new" } });
    fireEvent.click(screen.getByTestId("save-provider-edit"));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/providers/local" && init?.method === "PUT");
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({
        name: "Local server",
        protocol: "openai-chat",
        baseUrl: "http://127.0.0.1:4321/v1",
        apiKey: "sk-new",
      });
    });
    expect(await screen.findByTestId("settings-message")).toBeTruthy();
    expect(screen.queryByTestId("provider-edit")).toBeNull();
  });

  it("cancels an edit without sending a request", async () => {
    render(<SettingsPanel />);
    fireEvent.click(await screen.findByTestId("edit-provider-local"));
    await screen.findByTestId("provider-edit");
    fireEvent.click(screen.getByTestId("cancel-provider-edit"));
    await waitFor(() => expect(screen.queryByTestId("provider-edit")).toBeNull());
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });
});

describe("settings MCP servers", () => {
  it("adds a stdio server with one argument per line", async () => {
    render(<SettingsPanel />);
    await screen.findByTestId("mcp-card");
    fireEvent.change(screen.getByTestId("mcp-name"), { target: { value: "Filesystem" } });
    fireEvent.change(screen.getByTestId("mcp-command"), { target: { value: "npx" } });
    fireEvent.change(screen.getByTestId("mcp-args"), { target: { value: "-y\n@modelcontextprotocol/server-filesystem\nC:\\work\n" } });
    fireEvent.click(screen.getByTestId("save-mcp"));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/config" && init?.method === "PUT");
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({
        mcpServers: [{
          id: "filesystem",
          name: "Filesystem",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\work"],
        }],
      });
    });
    expect((await screen.findByTestId("settings-message")).textContent).toContain("Filesystem");
  });

  it("adds an http server with a URL instead of a command", async () => {
    render(<SettingsPanel />);
    await screen.findByTestId("mcp-card");
    fireEvent.change(screen.getByTestId("mcp-name"), { target: { value: "Tracker" } });
    fireEvent.change(screen.getByTestId("mcp-transport"), { target: { value: "http" } });
    expect(screen.queryByTestId("mcp-command")).toBeNull();
    fireEvent.change(screen.getByTestId("mcp-url"), { target: { value: "http://127.0.0.1:3001/mcp" } });
    fireEvent.click(screen.getByTestId("save-mcp"));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/config" && init?.method === "PUT");
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({
        mcpServers: [{ id: "tracker", name: "Tracker", transport: "http", url: "http://127.0.0.1:3001/mcp" }],
      });
    });
  });

  it("removes a server only after a confirming click", async () => {
    const view = configView({ mcpServers: [{ id: "filesystem", name: "Filesystem", transport: "stdio", command: "npx" }] });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url === "/api/config" && method === "GET") return new Response(JSON.stringify(view), { status: 200 });
      if (url === "/api/config" && method === "PUT") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { mcpServers?: unknown[] };
        return new Response(JSON.stringify({ roles: view.roles, defaults: view.defaults, mcpServers: body.mcpServers ?? [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    render(<SettingsPanel />);
    await screen.findByTestId("mcp-row");
    fireEvent.click(screen.getByTestId("mcp-remove"));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    fireEvent.click(await screen.findByTestId("mcp-remove-confirm"));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/config" && init?.method === "PUT");
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({ mcpServers: [] });
    });
    await waitFor(() => expect(screen.queryByTestId("mcp-row")).toBeNull());
  });

  it("removes a provider only after a confirming click", async () => {
    const view = configView();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url === "/api/config" && method === "GET") return new Response(JSON.stringify(view), { status: 200 });
      if (url === "/api/providers/local" && method === "DELETE") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    render(<SettingsPanel />);
    await screen.findByTestId("provider-list");
    fireEvent.click(screen.getByTestId("delete-provider-local"));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    const confirmBtn = await screen.findByTestId("delete-provider-confirm-local");
    expect(confirmBtn.textContent).toBe("Remove?");
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/providers/local" && init?.method === "DELETE");
      expect(del).toBeDefined();
    });
  });
});

describe("settings defaults", () => {
  it("lists provider models once a default provider is chosen", async () => {
    render(<SettingsPanel />);
    const select = (await screen.findByTestId("default-provider")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    fireEvent.change(select, { target: { value: "local" } });
    expect(await screen.findByTestId("default-model-count")).toBeTruthy();
    const options = screen.getByTestId("defaults-card").querySelectorAll("datalist option");
    expect([...options].map((option) => option.getAttribute("value"))).toEqual(["qwen2.5-coder-7b", "llama-3.2-3b"]);
  });

  it("saves a typed model when the listing fails", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url === "/api/config" && method === "GET") return new Response(JSON.stringify(configView()), { status: 200 });
      if (url === "/api/models?provider=local") return new Response(JSON.stringify({ error: { code: "PROVIDER_TEST" } }), { status: 502 });
      if (url === "/api/config" && method === "PUT") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { defaults?: unknown };
        return new Response(JSON.stringify({ roles: configView().roles, defaults: body.defaults, mcpServers: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 500 });
    });
    render(<SettingsPanel />);
    fireEvent.change(await screen.findByTestId("default-provider"), { target: { value: "local" } });
    expect(await screen.findByTestId("default-model-failed")).toBeTruthy();
    fireEvent.change(screen.getByTestId("default-model"), { target: { value: "custom-model" } });
    fireEvent.click(screen.getByTestId("save-defaults"));
    expect(await screen.findByTestId("settings-message")).toBeTruthy();
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ defaults: { provider: "local", model: "custom-model" } });
  });

  it("clears the default provider and its model together", async () => {
    render(<SettingsPanel />);
    const select = await screen.findByTestId("default-provider") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "local" } });
    fireEvent.change(screen.getByTestId("default-model"), { target: { value: "qwen2.5-coder-7b" } });
    fireEvent.change(select, { target: { value: "" } });
    expect((screen.getByTestId("default-model") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByTestId("save-defaults"));
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ defaults: { provider: null, model: null } });
  });
});
