// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PreviewPanel from "../../src/PreviewPanel";

const livePorts = new Set<number>();

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  if (url === "/api/preview/session" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { url?: string };
    const target = new URL(body.url ?? "http://127.0.0.1:3000/");
    return new Response(
      JSON.stringify({ token: `tok-${target.port}`, base: target.href, prefix: `/api/preview/tok-${target.port}/` }),
      { status: 200 },
    );
  }
  if (url.startsWith("/api/preview/tok-")) {
    const port = Number(/tok-(\d+)/.exec(url)?.[1] ?? "0");
    if (livePorts.has(port)) return new Response("<html>live</html>", { status: 200 });
    return new Response(JSON.stringify({ error: { code: "PREVIEW_HTTP", what: "down" } }), { status: 502 });
  }
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: "nope" } }), { status: 404 });
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  localStorage.clear();
  livePorts.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("preview panel", () => {
  it("loads a loopback URL through a directory session", async () => {
    render(<PreviewPanel />);
    fireEvent.click(screen.getByTestId("preview-load"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/preview/session",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ url: "http://127.0.0.1:3000/" }) }),
      ),
    );
    const frame = (await screen.findByTestId("preview-frame")) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("/api/preview/tok-3000/?r=1");
  });

  it("remembers the last URL across a remount", async () => {
    const first = render(<PreviewPanel />);
    fireEvent.change(screen.getByTestId("preview-url"), { target: { value: "http://127.0.0.1:5173/app" } });
    first.unmount();
    render(<PreviewPanel />);
    expect((screen.getByTestId("preview-url") as HTMLInputElement).value).toBe("http://127.0.0.1:5173/app");
  });

  it("reloads the frame with a new cache-busting key", async () => {
    render(<PreviewPanel />);
    fireEvent.click(screen.getByTestId("preview-load"));
    const before = (await screen.findByTestId("preview-frame")).getAttribute("src");
    fireEvent.click(screen.getByTestId("preview-reload"));
    await waitFor(() => expect(screen.getByTestId("preview-frame").getAttribute("src")).not.toBe(before));
    expect((await screen.findByTestId("preview-notice")).textContent).toContain("Reloaded");
  });

  it("opens the proxied page in a new tab and closes the frame", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<PreviewPanel />);
    fireEvent.click(screen.getByTestId("preview-load"));
    await screen.findByTestId("preview-frame");
    fireEvent.click(screen.getByTestId("preview-tab"));
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining("/api/preview/tok-3000/"),
      "_blank",
      "noopener,noreferrer",
    );
    fireEvent.click(screen.getByTestId("preview-close"));
    await waitFor(() => expect(screen.queryByTestId("preview-frame")).toBeNull());
  });

  it("detects the first live loopback dev server", async () => {
    livePorts.add(5173);
    render(<PreviewPanel />);
    fireEvent.click(screen.getByTestId("preview-detect"));
    expect((await screen.findByTestId("preview-notice")).textContent).toContain("http://127.0.0.1:5173/");
    expect((screen.getByTestId("preview-url") as HTMLInputElement).value).toBe("http://127.0.0.1:5173/");
    const frame = (await screen.findByTestId("preview-frame")) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toContain("tok-5173");
  });

  it("reports when no candidate answers", async () => {
    render(<PreviewPanel />);
    fireEvent.click(screen.getByTestId("preview-detect"));    const error = await screen.findByTestId("preview-error");
    expect(error.textContent).toContain("No dev server answered");
    expect(screen.queryByTestId("preview-frame")).toBeNull();
  });
});
