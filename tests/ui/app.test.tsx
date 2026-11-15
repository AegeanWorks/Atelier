// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  providers: [
    {
      id: "demo",
      name: "Demo",
      protocol: "openai-chat",
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModel: "demo-model",
      modelCount: 3,
      key: { set: true, source: "secret" },
    },
  ],
  roles: { executor: null, manager: null, auditor: null, compactor: null },
  defaults: { provider: null, model: null },
};

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) } as MessageEvent);
  }
  close(): void {
    // No-op for the shell test.
  }
}

let sessionCounter = 0;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/config" && method === "GET") return new Response(JSON.stringify(config), { status: 200 });
  if (url === "/api/providers/demo/test" && method === "POST") {
    return new Response(JSON.stringify({ ok: true, modelCount: 3, latencyMs: 7 }), { status: 200 });
  }
  if (url === "/api/preview/session" && method === "POST") {
    return new Response(JSON.stringify({ token: "tok", base: "http://127.0.0.1:3000/", prefix: "/api/preview/tok/" }), { status: 200 });
  }
  if (url === "/api/sessions" && method === "POST") {
    sessionCounter += 1;
    return new Response(JSON.stringify({ session: { id: `ses_${sessionCounter}`, title: "New conversation", created: 1, updated: 1 } }), { status: 201 });
  }
  if (url.startsWith("/api/search?q=") && method === "GET") {
    return new Response(
      JSON.stringify({ sessions: [], messages: [{ id: "msg_9", session_id: "ses_1", seq: 2, role: "user", text: "hello there from search", created: 1 }] }),
      { status: 200 },
    );
  }
  if (url === "/api/sessions/ses_1" && method === "PATCH") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { title?: string; pinned?: boolean; archived?: boolean };
    return new Response(
      JSON.stringify({
        sessions: [{
          id: "ses_1",
          title: body.title ?? "New conversation",
          created: 1,
          updated: 2,
          pinned: body.pinned === true ? 1 : 0,
          archived: body.archived === true ? 1 : 0,
        }],
      }),
      { status: 200 },
    );
  }
  if (url === "/api/sessions/ses_1" && method === "DELETE") {
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  if (url === "/api/sessions/ses_1/stop" && method === "POST") {
    return new Response(JSON.stringify({ run: { id: "run_1", status: "blocked", blocked_reason: "stopped" } }), { status: 200 });
  }
  if (url === "/api/sessions/ses_1/messages" && method === "GET") {
    return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  }
  if (url === "/api/sessions/ses_1/runs" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
    return new Response(
      JSON.stringify({ run: { id: "run_1", status: "running" }, message: { id: "msg_1", session_id: "ses_1", seq: 1, role: "user", text: body.prompt ?? "hello", client_id: "c1", created: 1 } }),
      { status: 201 },
    );
  }
  if (url === "/api/sessions/ses_1/messages" && method === "POST") {
    return new Response(
      JSON.stringify({ message: { id: "msg_1", session_id: "ses_1", seq: 1, role: "user", text: "hello", client_id: "c1", created: 1 } }),
      { status: 201 },
    );
  }
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: "nope" } }), { status: 404 });
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  localStorage.clear();
  sessionCounter = 0;
  fetchMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("atelier shell", () => {
  it("renders the four regions and the empty state", async () => {
    render(<App />);
    expect(screen.getByTestId("app-shell")).toBeTruthy();
    expect(screen.getByTestId("rail")).toBeTruthy();
    expect(screen.getByTestId("composer")).toBeTruthy();
    expect(screen.getByTestId("workspace-tabs")).toBeTruthy();
    expect(screen.getByTestId("statusbar")).toBeTruthy();
    expect(await screen.findByText("What are we building?")).toBeTruthy();
    expect(screen.getByText(/Every message is durable/)).toBeTruthy();
    expect(screen.queryByText(/arrives in M4/)).toBeNull();
  });

  it("points a first run at Settings when no provider key is configured", async () => {
    render(<App />);
    expect(await screen.findByTestId("provider-notice")).toBeTruthy();
    fireEvent.click(screen.getByTestId("provider-settings"));
    expect(await screen.findByTestId("settings-panel")).toBeTruthy();
  });

  it("slides the workspace into view when the first-run hint opens Settings", async () => {
    render(<App />);
    await screen.findByTestId("provider-notice");
    expect(screen.getByTestId("workspace").getAttribute("data-open")).toBe("false");
    fireEvent.click(screen.getByTestId("provider-settings"));
    expect(screen.getByTestId("workspace").getAttribute("data-open")).toBe("true");
  });

  it("lets the workspace overlay be left with the back button and Escape", async () => {
    render(<App />);
    await screen.findByTestId("provider-notice");
    const workspace = screen.getByTestId("workspace");
    fireEvent.click(screen.getByTestId("provider-settings"));
    expect(workspace.getAttribute("data-open")).toBe("true");
    fireEvent.click(screen.getByTestId("workspace-back"));
    expect(workspace.getAttribute("data-open")).toBe("false");
    fireEvent.click(screen.getByTestId("provider-settings"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(workspace.getAttribute("data-open")).toBe("false");
  });

  it("explains a no_model block in actionable words", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("new-conversation"));
    await screen.findByTestId("conversation-list");
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    FakeEventSource.last?.emit("run.blocked", { reason: "no_model" });
    const banner = await screen.findByTestId("error-banner");
    expect(banner.textContent).toContain("no model to call");
    expect(banner.textContent).toContain("set a default model");
    expect(banner.textContent).not.toContain("no_model");
  });

  it("lets a raised error be dismissed", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("new-conversation"));
    await screen.findByTestId("conversation-list");
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    FakeEventSource.last?.emit("run.blocked", { reason: "provider down" });
    expect(await screen.findByTestId("error-banner")).toBeTruthy();
    fireEvent.click(screen.getByTestId("dismiss-error"));
    await waitFor(() => expect(screen.queryByTestId("error-banner")).toBeNull());
  });

  it("creates a conversation and sends a durable message", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("new-conversation"));
    await waitFor(() => expect(screen.getByTestId("conversation-list")).toBeTruthy());
    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("send-button"));
    expect(await screen.findByText("hello")).toBeTruthy();
  });

  it("titles a new conversation from its first message", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("new-conversation"));
    await screen.findByTestId("conversation-list");
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("send-button"));
    await screen.findByText("hello");
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input, init]) => String(input) === "/api/sessions/ses_1" && init?.method === "PATCH"),
      ).toBe(true),
    );
  });

  it("renames a conversation inline", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("new-conversation"));
    await screen.findByTestId("conversation-list");
    fireEvent.click(screen.getByRole("button", { name: "Rename New conversation" }));
    const input = (await screen.findByTestId("rename-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Fix the parser" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("conversation-list").textContent).toContain("Fix the parser"));
  });

  it("deletes a conversation after an explicit confirmation", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("new-conversation"));
    await screen.findByTestId("conversation-list");
    fireEvent.click(screen.getByRole("button", { name: "Delete New conversation" }));
    fireEvent.click(await screen.findByTestId("conversation-delete-confirm"));
    await waitFor(() => expect(screen.queryByTestId("conversation-list")).toBeNull());
    expect(screen.getByText(/No conversations yet/)).toBeTruthy();
  });

  it("searches message text and opens the matching conversation", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.change(screen.getByTestId("session-search"), { target: { value: "hello" } });
    const hit = await screen.findByTestId("search-hit", undefined, { timeout: 3000 });
    expect(hit.textContent).toContain("hello there from search");
    fireEvent.click(hit);
    await waitFor(() => expect(screen.queryByTestId("search-hit")).toBeNull());
  });

  it("appends an assistant reply delivered by the live event stream", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("new-conversation"));
    await screen.findByTestId("conversation-list");
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    FakeEventSource.last?.emit("text.ended", { messageId: "msg_live", text: "live reply" });
    expect(await screen.findByText("live reply")).toBeTruthy();
  });

  it("renders an assistant reply as markdown and copies a fenced code block", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("new-conversation"));
    await screen.findByTestId("conversation-list");
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    FakeEventSource.last?.emit("text.ended", {
      messageId: "msg_md",
      text: "Run **this**:\n\n```sh\nnpm test\n```\n",
    });
    expect(await screen.findByText("this")).toBeTruthy();
    const code = await screen.findByText("npm test");
    expect(code.tagName).toBe("CODE");
    fireEvent.click(screen.getByTestId("copy-code"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("npm test"));
  });

  it("copies a message and confirms it briefly", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("new-conversation"));
    await screen.findByTestId("conversation-list");
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "copy me" } });
    fireEvent.click(screen.getByTestId("send-button"));
    await screen.findByText("copy me");
    fireEvent.click(screen.getAllByTestId("copy-message")[0]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("copy me"));
    expect(screen.getByTestId("copy-message").textContent).toBe("Copied");
  });

  it("exports the conversation as a markdown download", async () => {
    const blobs: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
      blobs.push(blob as Blob);
      return "blob:transcript";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("new-conversation"));
    await screen.findByTestId("conversation-list");
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(screen.getAllByTestId("message")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("export-conversation"));
    await waitFor(() => expect(blobs).toHaveLength(1));
    const text = await blobs[0]!.text();
    expect(text).toContain("# hello");
    expect(text).toContain("## You");
    expect(text).toContain("hello");
    expect((await screen.findByTestId("run-notice")).textContent).toContain("Transcript downloaded");
  });

  it("names the conversation in the tab title and marks work and approvals", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    expect(document.title).toBe("atelier");
    fireEvent.click(screen.getByTestId("new-conversation"));
    await screen.findByTestId("conversation-list");
    await waitFor(() => expect(document.title).toBe("New conversation · atelier"));
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("send-button"));
    await screen.findByTestId("working");
    await waitFor(() => expect(document.title).toBe("● Working · hello"));
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    FakeEventSource.last?.emit("approval.request", { approvalId: "ap_title", runId: "run_1", callId: "c1", tool: "write_file", action: "edit", resource: "a.txt", reason: "needs approval" });
    await waitFor(() => expect(document.title).toBe("● Approval needed · hello"));
    FakeEventSource.last?.emit("approval.resolved", { approvalId: "ap_title" });
    FakeEventSource.last?.emit("run.finished", { runId: "run_1", status: "ok" });
    await waitFor(() => expect(document.title).toBe("hello · atelier"));
  });

  it("blocks a second send while a run is working and re-enables it after finish", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("new-conversation"));
    await screen.findByTestId("conversation-list");
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "first" } });
    fireEvent.click(screen.getByTestId("send-button"));
    await screen.findByTestId("working");
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "second" } });
    expect((screen.getByTestId("send-button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("composer").textContent).toContain("Run in progress");
    fireEvent.keyDown(screen.getByTestId("composer-input"), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId("run-notice").textContent).toContain("already working"));
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    FakeEventSource.last?.emit("run.finished", { runId: "run_1", status: "ok" });
    await waitFor(() => expect((screen.getByTestId("send-button") as HTMLButtonElement).disabled).toBe(false));
  });

  it("drops the running indicator when switching to a conversation without a run", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("new-conversation"));
    await screen.findByTestId("conversation-list");
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "long job" } });
    fireEvent.click(screen.getByTestId("send-button"));
    await screen.findByTestId("working");
    fireEvent.click(screen.getByTestId("new-conversation"));
    await waitFor(() => expect(screen.getAllByTestId("conversation-item")).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId("working")).toBeNull());
    expect(screen.queryByTestId("stop-run")).toBeNull();
  });

  it("stops a running run from the header and shows a neutral notice", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("new-conversation"));
    await screen.findByTestId("conversation-list");
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "long job" } });
    fireEvent.click(screen.getByTestId("send-button"));
    await screen.findByTestId("working");
    fireEvent.click(screen.getByTestId("stop-run"));
    await waitFor(() => expect(screen.queryByTestId("working")).toBeNull());
    expect((await screen.findByTestId("run-notice")).textContent).toContain("Run stopped");
    expect(screen.queryByTestId("error-banner")).toBeNull();
    fireEvent.click(screen.getByTestId("dismiss-notice"));
    await waitFor(() => expect(screen.queryByTestId("run-notice")).toBeNull());
  });

  it("treats a stopped run event as a notice rather than an error", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("new-conversation"));
    await screen.findByTestId("conversation-list");
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    FakeEventSource.last?.emit("run.blocked", { reason: "stopped" });
    expect((await screen.findByTestId("run-notice")).textContent).toContain("Run stopped");
    expect(screen.queryByTestId("error-banner")).toBeNull();
  });

  it("shows a working indicator while a run is in flight", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("new-conversation"));
    await screen.findByTestId("conversation-list");
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("send-button"));
    expect(await screen.findByTestId("working")).toBeTruthy();
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    FakeEventSource.last?.emit("run.finished", { runId: "run_1", status: "ok" });
    await waitFor(() => expect(screen.queryByTestId("working")).toBeNull());
  });

  it("keeps a separate unsent draft per conversation", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "unsent scratch" } });
    fireEvent.click(screen.getByTestId("new-conversation"));
    await screen.findByTestId("conversation-list");
    await waitFor(() => expect(input.value).toBe(""));
    fireEvent.change(input, { target: { value: "note for one" } });
    fireEvent.click(screen.getByTestId("new-conversation"));
    await waitFor(() => expect(screen.getAllByTestId("conversation-item")).toHaveLength(2));
    expect(input.value).toBe("");
    fireEvent.click(screen.getAllByTestId("conversation-item")[1]!);
    await waitFor(() => expect(input.value).toBe("note for one"));
  });

  it("traverses the workspace tab strip with arrows, Home and End", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    const files = screen.getByTestId("tab-files");
    const git = screen.getByTestId("tab-git");
    expect(files.getAttribute("tabindex")).toBe("0");
    expect(git.getAttribute("tabindex")).toBe("-1");
    expect(files.getAttribute("aria-controls")).toBe("workspace-panel");
    expect(screen.getByTestId("workspace-panel").getAttribute("aria-labelledby")).toBe("workspace-tab-files");

    fireEvent.keyDown(files, { key: "ArrowRight" });
    expect(await screen.findByTestId("git-panel")).toBeTruthy();
    expect(document.activeElement).toBe(git);
    expect(git.getAttribute("tabindex")).toBe("0");
    expect(files.getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(git, { key: "End" });
    expect(await screen.findByTestId("evals-panel")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId("tab-evals"));

    fireEvent.keyDown(screen.getByTestId("tab-evals"), { key: "ArrowRight" });
    expect(await screen.findByTestId("files-panel")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId("tab-files"));

    fireEvent.keyDown(screen.getByTestId("tab-files"), { key: "ArrowLeft" });
    expect(await screen.findByTestId("evals-panel")).toBeTruthy();

    fireEvent.keyDown(screen.getByTestId("tab-evals"), { key: "Home" });
    expect(await screen.findByTestId("files-panel")).toBeTruthy();
  });

  it("jumps between workspace panels with Alt+digit", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.keyDown(window, { key: "2", altKey: true });
    expect(await screen.findByTestId("git-panel")).toBeTruthy();
    fireEvent.keyDown(window, { key: "1", altKey: true });
    expect(await screen.findByTestId("files-panel")).toBeTruthy();
  });

  it("ignores the panel chords while typing in the composer", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    await screen.findByTestId("files-panel");
    const input = screen.getByTestId("composer-input");
    fireEvent.keyDown(input, { key: "4", altKey: true });
    expect(screen.queryByTestId("plans-panel")).toBeNull();
    expect(screen.getByTestId("files-panel")).toBeTruthy();
  });

  it("opens the command palette from the keyboard", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByTestId("command-palette")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("command-palette")).toBeNull());
  });

  it("toggles the terminal drawer from keyboard and closes it on Escape", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.keyDown(window, { key: "j", ctrlKey: true });
    expect(await screen.findByTestId("terminal-drawer")).toBeTruthy();
    expect(screen.getByText("pipe fallback · 30 s timeout")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("terminal-drawer")).toBeNull());
  });

  it("navigates the palette with the arrow keys and runs the selected command", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByTestId("palette-input");
    fireEvent.change(input, { target: { value: "go to git" } });
    const option = await screen.findByRole("option", { name: /Go to Git/ });
    expect(option.getAttribute("data-active")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByTestId("git-panel")).toBeTruthy();
    expect(screen.queryByTestId("command-palette")).toBeNull();
  });

  it("moves the palette selection with ArrowUp and ArrowDown", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByTestId("palette-input");
    fireEvent.change(input, { target: { value: "terminal" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[0]?.getAttribute("data-active")).toBe("true");
  });

  it("reports an empty palette query", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(await screen.findByTestId("palette-input"), { target: { value: "zzzz" } });
    expect(await screen.findByTestId("palette-empty")).toBeTruthy();
  });

  it("opens the preview panel and builds a sandboxed directory proxy URL", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("tab-preview"));
    expect(await screen.findByTestId("preview-panel")).toBeTruthy();
    const input = screen.getByTestId("preview-url") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "http://127.0.0.1:3000/" } });
    fireEvent.click(screen.getByTestId("preview-load"));
    const frame = (await screen.findByTestId("preview-frame")) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toMatch(/^\/api\/preview\/tok\/\?r=\d+$/);
    expect(frame.getAttribute("sandbox")).toContain("allow-scripts");
  });

  it("shows providers with masked key status and tests a provider", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("tab-settings"));
    expect(await screen.findByTestId("settings-panel")).toBeTruthy();
    expect(screen.getAllByText("Demo").length).toBeGreaterThan(0);
    expect(screen.getByText("SET (secret)")).toBeTruthy();
    expect(screen.queryByText("sk-secret")).toBeNull();
    fireEvent.click(screen.getByTestId("test-provider-demo"));
    expect(await screen.findByText(/3 models in 7 ms/)).toBeTruthy();
  });
});
