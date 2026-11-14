// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TerminalPanel from "../../src/TerminalPanel";
import { TERMINAL_HEADER } from "../../src/terminalStore";

const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
  const target = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
  const method = init?.method ?? "GET";
  if (target === "/api/terminal/exec" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { command?: string };
    return new Response(JSON.stringify({ output: `ran ${body.command ?? ""}`, exitCode: 0, durationMs: 4 }), { status: 200 });
  }
  if (target === "/api/terminal/stop" && method === "POST") {
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { code: "UNEXPECTED", what: target } }), { status: 500 });
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function runCommand(text: string): Promise<void> {
  fireEvent.change(screen.getByTestId("terminal-input"), { target: { value: text } });
  fireEvent.submit(screen.getByTestId("terminal-run").closest("form")!);
  await waitFor(() => expect(screen.getByTestId("terminal-output").textContent).toContain("ran "), { timeout: 3000 });
}

describe("terminal panel", () => {
  it("runs a command and records it in history", async () => {
    render(<TerminalPanel />);
    await runCommand("ls");
    expect(screen.getByTestId("terminal-output").textContent).toContain("[exit 0 · 4 ms]");
    expect(screen.getByTestId("terminal-history-count").textContent).toContain("1 command");
  });

  it("recalls history with the arrow keys and restores the draft", async () => {
    render(<TerminalPanel />);
    await runCommand("one");
    await runCommand("two");
    const input = screen.getByTestId("terminal-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "draft text" } });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("two");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("one");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("one");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("two");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("draft text");
  });

  it("clears the scrollback but keeps the history", async () => {
    render(<TerminalPanel />);
    await runCommand("ls");
    fireEvent.click(screen.getByTestId("terminal-clear"));
    expect(screen.getByTestId("terminal-output").textContent).toBe(TERMINAL_HEADER);
    expect(screen.getByTestId("terminal-history-count").textContent).toContain("1 command");
  });

  it("keeps the scrollback across a remount", async () => {
    const first = render(<TerminalPanel />);
    await runCommand("persist");
    first.unmount();
    render(<TerminalPanel />);
    expect(screen.getByTestId("terminal-output").textContent).toContain("ran persist");
    const input = screen.getByTestId("terminal-input") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("persist");
  });
});
