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

const IMAGE_ID = "0123456789abcdef.png";
const boot = {
  version: "0.1.0",
  workspace: "/work",
  sessions: [{ id: "ses_1", title: "Pics", created: 1, updated: 1 }],
  profiles: [],
  providers: [],
  recovery: { startedAt: 0, finishedAt: 1, actionCount: 0, result: "clean", actions: [] },
};
let stored = false;
let uploads = 0;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/commands") return new Response(JSON.stringify({ commands: [] }), { status: 200 });
  if (url === "/api/images" && method === "POST") {
    const n = uploads;
    uploads += 1;
    return new Response(JSON.stringify({ id: n === 0 ? IMAGE_ID : `${n.toString(16).padStart(16, "0")}.png` }), { status: 201 });
  }
  if (url === "/api/sessions/ses_1/messages") {
    const text = stored ? `look\n\n<attached_image id="${IMAGE_ID}"/>` : "plain";
    return new Response(JSON.stringify({ messages: [{ id: "m0", session_id: "ses_1", seq: 1, role: "user", text, client_id: null, created: 1 }] }), { status: 200 });
  }
  if (url === "/api/sessions/ses_1/approvals?pending=1") return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/runs" && method === "POST") {
    return new Response(JSON.stringify({ run: { id: "run_1", status: "running" }, message: { id: "m3", session_id: "ses_1", seq: 3, role: "user", text: "x", client_id: null, created: 3 } }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: "nope" } }), { status: 404 });
});

beforeEach(() => {
  stored = false;
  uploads = 0;
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  localStorage.clear();
  fetchMock.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function png(name = "a.png", size = 8): File {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

async function pick(file: File): Promise<void> {
  const input = await screen.findByTestId("image-input");
  fireEvent.change(input, { target: { files: [file] } });
}

describe("composer image attachments", () => {
  it("uploads a picked image and shows a removable thumbnail", async () => {
    render(<App />);
    await pick(png());
    const chip = await screen.findByTestId("pending-image");
    expect(chip.querySelector("img")?.getAttribute("src")).toBe(`/api/images/${IMAGE_ID}`);
    const upload = fetchMock.mock.calls.find(([url]) => url === "/api/images");
    const body = JSON.parse(String((upload?.[1] as RequestInit | undefined)?.body ?? "{}"));
    expect(body.mediaType).toBe("image/png");
    expect(typeof body.data).toBe("string");
    fireEvent.click(screen.getByTestId("remove-image"));
    expect(screen.queryByTestId("pending-image")).toBeNull();
  });

  it("sends the image ids with the message and clears the tray", async () => {
    render(<App />);
    await pick(png());
    await screen.findByTestId("pending-image");
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "what is this?" } });
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => url === "/api/sessions/ses_1/runs");
      const body = JSON.parse(String((call?.[1] as RequestInit | undefined)?.body ?? "{}"));
      expect(body.images).toEqual([IMAGE_ID]);
      expect(body.prompt).toBe("what is this?");
    });
    await waitFor(() => expect(screen.queryByTestId("pending-image")).toBeNull());
  });

  it("allows sending an image with no text", async () => {
    render(<App />);
    await pick(png());
    await screen.findByTestId("pending-image");
    expect((screen.getByTestId("send-button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("accepts a pasted image", async () => {
    render(<App />);
    const input = await screen.findByTestId("composer-input");
    fireEvent.paste(input, { clipboardData: { files: [png("pasted.png")], items: [] } });
    expect(await screen.findByTestId("pending-image")).toBeTruthy();
  });

  it("refuses non-images and oversize files with a notice and no upload", async () => {
    render(<App />);
    await pick(new File(["x"], "notes.txt", { type: "text/plain" }));
    expect((await screen.findAllByText(/not a supported image/i)).length).toBeGreaterThan(0);
    await pick(png("big.png", 5 * 1024 * 1024 + 1));
    expect((await screen.findAllByText(/larger than 5 MB/i)).length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/images")).toBe(false);
  });

  it("limits the tray to four images", async () => {
    render(<App />);
    for (let i = 0; i < 4; i += 1) {
      await pick(png(`${i}.png`));
      await waitFor(() => expect(screen.getAllByTestId("pending-image").length).toBe(i + 1));
    }
    await pick(png("fifth.png"));
    expect((await screen.findAllByText(/at most 4/i)).length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/images").length).toBe(4);
  });

  it("shows stored images as thumbnails in the transcript", async () => {
    stored = true;
    render(<App />);
    const image = await screen.findByTestId("message-image");
    expect(image.getAttribute("src")).toBe(`/api/images/${IMAGE_ID}`);
    expect(screen.queryByText(/attached_image/)).toBeNull();
  });
});
