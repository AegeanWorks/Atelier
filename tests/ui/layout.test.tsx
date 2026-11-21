// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";

const boot = {
  version: "0.1.0",
  workspace: "C:\\work",
  sessions: [],
  profiles: [],
  providers: [],
  recovery: { startedAt: 0, finishedAt: 1, actionCount: 0, result: "clean", actions: [] },
};

const config = {
  providers: [],
  roles: { executor: null, manager: null, auditor: null, compactor: null },
  defaults: { provider: null, model: null },
};

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/config") return new Response(JSON.stringify(config), { status: 200 });
  if (url.startsWith("/api/sessions")) return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
  if (url.startsWith("/api/usage")) return new Response(JSON.stringify({}), { status: 200 });
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: "nope" } }), { status: 404 });
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const stored = (): { rail: number; workspace: number } =>
  JSON.parse(localStorage.getItem("atelier.layout") ?? "{}") as { rail: number; workspace: number };

describe("resizable three-pane layout", () => {
  it("exposes both dividers as labelled separators with their current widths", async () => {
    render(<App />);
    expect(await screen.findByTestId("app-shell")).toBeTruthy();
    const rail = screen.getByTestId("resize-rail");
    const workspace = screen.getByTestId("resize-workspace");
    expect(rail.getAttribute("role")).toBe("separator");
    expect(rail.getAttribute("aria-label")).toBe("Resize conversation list");
    expect(workspace.getAttribute("aria-label")).toBe("Resize workspace panel");
    expect(rail.getAttribute("aria-valuenow")).toBe("248");
    expect(workspace.getAttribute("aria-valuenow")).toBe("456");
  });

  it("nudges a pane with the arrow keys, persists it, and restores it on the next mount", async () => {
    render(<App />);
    const rail = await screen.findByTestId("resize-rail");
    fireEvent.keyDown(rail, { key: "ArrowRight" });
    expect(rail.getAttribute("aria-valuenow")).toBe("256");
    expect(stored().rail).toBe(256);

    cleanup();
    render(<App />);
    const restored = await screen.findByTestId("resize-rail");
    expect(restored.getAttribute("aria-valuenow")).toBe("256");
  });

  it("resets a pane to its default width on double click", async () => {
    render(<App />);
    const workspace = await screen.findByTestId("resize-workspace");
    fireEvent.keyDown(workspace, { key: "ArrowLeft" });
    expect(workspace.getAttribute("aria-valuenow")).toBe("464");
    fireEvent.doubleClick(workspace);
    expect(workspace.getAttribute("aria-valuenow")).toBe("456");
    expect(stored().workspace).toBe(456);
  });

  it("clamps a persisted width to the usable range", async () => {
    localStorage.setItem("atelier.layout", JSON.stringify({ rail: 9999, workspace: -5 }));
    render(<App />);
    expect((await screen.findByTestId("resize-rail")).getAttribute("aria-valuenow")).toBe("340");
    expect((await screen.findByTestId("resize-workspace")).getAttribute("aria-valuenow")).toBe("320");
  });
});
