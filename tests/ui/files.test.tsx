// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FilesPanel from "../../src/FilesPanel";

const file = {
  path: "notes.md",
  content: "hello",
  hash: "hash-1",
  size: 5,
};

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  if (url === "/api/workspace/tree") {
    return new Response(JSON.stringify({ entries: [{ name: "notes.md", path: "notes.md", type: "file" }] }), { status: 200 });
  }
  if (url.startsWith("/api/workspace/file?path=") && method === "GET") {
    return new Response(JSON.stringify(file), { status: 200 });
  }
  if (url === "/api/workspace/file" && method === "PUT") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { content?: string };
    return new Response(JSON.stringify({ ...file, content: body.content ?? "", hash: "hash-2", size: 11 }), { status: 200 });
  }
  if (url === "/api/workspace/file" && method === "DELETE") {
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { code: "UNEXPECTED", what: url } }), { status: 500 });
});

function deleteCalls(): number {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE").length;
}

function putCalls(): number {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT").length;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openFile(): Promise<void> {
  render(<FilesPanel />);
  fireEvent.click(await screen.findByRole("button", { name: /notes\.md/ }));
  await screen.findByTestId("editor");
}

describe("file panel safety", () => {
  it("requires a second click before deleting a file", async () => {
    await openFile();
    fireEvent.click(screen.getByTestId("delete-file"));
    expect(deleteCalls()).toBe(0);
    const confirm = await screen.findByTestId("delete-file-confirm");
    expect(confirm.textContent).toBe("Delete?");
    fireEvent.click(confirm);
    await waitFor(() => expect(deleteCalls()).toBe(1));
  });

  it("resets the delete confirmation when another file opens", async () => {
    await openFile();
    fireEvent.click(screen.getByTestId("delete-file"));
    await screen.findByTestId("delete-file-confirm");
    fireEvent.click(screen.getByRole("button", { name: /notes\.md/ }));
    await waitFor(() => expect(screen.queryByTestId("delete-file-confirm")).toBeNull());
  });

  it("saves with Cmd/Ctrl+S only when the draft changed", async () => {
    await openFile();
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(putCalls()).toBe(0);
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "hello world" } });
    expect(screen.getByText(/unsaved/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(putCalls()).toBe(1));
    expect(await screen.findByTestId("files-message")).toBeTruthy();
    expect(screen.getByText(/saved/)).toBeTruthy();
  });
});
