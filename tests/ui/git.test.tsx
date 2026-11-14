// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GitPanel from "../../src/GitPanel";

const changes = [
  { status: "M", index: "M", worktree: " ", path: "staged.ts" },
  { status: "M", index: " ", worktree: "M", path: "dirty.ts" },
  { status: "??", index: "?", worktree: "?", path: "new.ts" },
];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  if (url === "/api/git/status" && method === "GET") {
    return new Response(JSON.stringify({ branch: "main", changes }), { status: 200 });
  }
  if (url === "/api/git/stage" && method === "POST") {
    return new Response(JSON.stringify({ ok: true, status: { branch: "main", changes } }), { status: 200 });
  }
  if (url === "/api/git/unstage" && method === "POST") {
    return new Response(JSON.stringify({ ok: true, status: { branch: "main", changes } }), { status: 200 });
  }
  if (url === "/api/git/diff?path=staged.ts&staged=1") {
    return new Response(JSON.stringify({ diff: "@@ staged hunk" }), { status: 200 });
  }
  if (url === "/api/git/diff?path=dirty.ts") {
    return new Response(JSON.stringify({ diff: "@@ dirty hunk" }), { status: 200 });
  }
  if (url === "/api/git/commit" && method === "POST") {
    return new Response(JSON.stringify({ ok: true, output: "[main abc123] msg\n 1 file changed", status: { branch: "main", changes: [] } }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { code: "UNEXPECTED", what: url } }), { status: 500 });
});

function callsTo(path: string): number {
  return fetchMock.mock.calls.filter(([input]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return url === path;
  }).length;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function rows(): Promise<HTMLElement[]> {
  await screen.findByTestId("git-status");
  return screen.getAllByTestId("git-file").map((button) => button.closest("li") as HTMLElement);
}

describe("git panel staging", () => {
  it("shows both porcelain columns and the staged count", async () => {
    render(<GitPanel />);
    await rows();
    expect(screen.getByText(/1 staged of 3 change\(s\)/)).toBeTruthy();
    expect(screen.getByText("M·")).toBeTruthy();
    expect(screen.getByText("·M")).toBeTruthy();
    expect(screen.getByText("??")).toBeTruthy();
  });

  it("enables Stage only for worktree changes and Unstage only for staged ones", async () => {
    render(<GitPanel />);
    const [stagedRow, dirtyRow, newRow] = await rows();
    expect((within(stagedRow!).getByTestId("git-stage") as HTMLButtonElement).disabled).toBe(true);
    expect((within(stagedRow!).getByTestId("git-unstage") as HTMLButtonElement).disabled).toBe(false);
    expect((within(dirtyRow!).getByTestId("git-stage") as HTMLButtonElement).disabled).toBe(false);
    expect((within(dirtyRow!).getByTestId("git-unstage") as HTMLButtonElement).disabled).toBe(true);
    expect((within(newRow!).getByTestId("git-stage") as HTMLButtonElement).disabled).toBe(false);
  });

  it("stages and unstages a single file", async () => {
    render(<GitPanel />);
    const dirtyRow = (await rows())[1]!;
    fireEvent.click(within(dirtyRow).getByTestId("git-stage"));
    await waitFor(() => expect(callsTo("/api/git/stage")).toBe(1));
    expect((await screen.findByTestId("git-notice")).textContent).toContain("Staged dirty.ts");
    fireEvent.click(within((await rows())[0]!).getByTestId("git-unstage"));
    await waitFor(() => expect(callsTo("/api/git/unstage")).toBe(1));
  });

  it("stages every worktree change at once", async () => {
    render(<GitPanel />);
    await rows();
    fireEvent.click(screen.getByTestId("git-stage-all"));
    await waitFor(() => expect(callsTo("/api/git/stage")).toBe(2));
    expect((await screen.findByTestId("git-notice")).textContent).toContain("Staged 2 files");
  });

  it("requests the staged diff for a fully staged file", async () => {
    render(<GitPanel />);
    const [stagedRow, dirtyRow] = await rows();
    fireEvent.click(within(stagedRow!).getByTestId("git-file"));
    expect((await screen.findByTestId("git-diff")).textContent).toContain("@@ staged hunk");
    expect(screen.getByText(/Diff · staged\.ts · staged/)).toBeTruthy();
    fireEvent.click(within(dirtyRow!).getByTestId("git-file"));
    expect((await screen.findByTestId("git-diff")).textContent).toContain("@@ dirty hunk");
    expect(screen.getByText("Diff · dirty.ts")).toBeTruthy();
  });

  it("gates Commit until a message exists and a file is staged", async () => {
    render(<GitPanel />);
    await rows();
    const commit = screen.getByTestId("git-commit") as HTMLButtonElement;
    expect(commit.disabled).toBe(true);
    expect(screen.queryByTestId("git-staged-hint")).toBeNull();
    fireEvent.change(screen.getByTestId("git-commit-message"), { target: { value: "feat: stage" } });
    expect(commit.disabled).toBe(false);
    fireEvent.click(commit);
    await waitFor(() => expect(callsTo("/api/git/commit")).toBe(1));
    expect((await screen.findByTestId("git-notice")).textContent).toContain("[main abc123] msg");
  });
});
