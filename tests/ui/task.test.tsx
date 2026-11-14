// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";
import TaskPanel from "../../src/TaskPanel";

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(_type: string, _listener: (event: MessageEvent) => void): void {}
  close(): void {}
}

const blockedRun = {
  id: "run_1",
  session_id: "ses_1",
  status: "blocked",
  parent_run_id: null,
  fork_id: null,
  profile_id: "build",
  blocked_reason: "provider error",
  recovery_attempts: 0,
  started_at: 1,
  finished_at: null,
  error: "boom",
  workspace: "C:\\work",
  created: 2,
  updated: 3,
};

const runningRun = { ...blockedRun, id: "run_2", status: "running", blocked_reason: null, error: null, created: 4, updated: 5 };

const steps = [{ id: "step_1", run_id: "run_1", seq: 1, kind: "llm_request", status: "failed", input_json: null, output_ref: null, created: 2 }];

const audit = { runId: "run_1", clean: false, findings: [{ level: "L2", code: "FAILED_STEP", message: "1 run step(s) failed" }] };

const boot = {
  version: "0.1.0",
  workspace: "C:\\work",
  sessions: [{ id: "ses_1", title: "Task", created: 1, updated: 1 }],
  profiles: [],
  providers: [],
  recovery: { startedAt: 0, finishedAt: 1, actionCount: 0, result: "clean", actions: [] },
};

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/sessions/ses_1/messages") return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/approvals?pending=1") return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
  if (url === "/api/runs?session=ses_1") return new Response(JSON.stringify({ runs: [blockedRun, runningRun] }), { status: 200 });
  if (url === "/api/runs/run_1") return new Response(JSON.stringify({ run: blockedRun, steps }), { status: 200 });
  if (url === "/api/audit/run_1") return new Response(JSON.stringify(audit), { status: 200 });
  if (url === "/api/runs/run_2") return new Response(JSON.stringify({ run: runningRun, steps: [] }), { status: 200 });
  if (url === "/api/audit/run_2") return new Response(JSON.stringify({ runId: "run_2", clean: true, findings: [] }), { status: 200 });
  if (url === "/api/runs/run_1/resume" && method === "POST") return new Response(JSON.stringify({ run: { ...blockedRun, status: "running" }, mode: "retry" }), { status: 200 });
  if (url === "/api/sessions/ses_1/stop" && method === "POST") return new Response(JSON.stringify({ run: { ...runningRun, status: "blocked" } }), { status: 200 });
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: "nope" } }), { status: 404 });
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  localStorage.clear();
  fetchMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("task panel", () => {
  it("shows runs, steps and audit findings and drives retry, fork and stop", async () => {
    render(<TaskPanel sessionId="ses_1" refreshTick={0} />);
    const items = await screen.findAllByTestId("run-item");
    expect(items).toHaveLength(2);
    expect(screen.getByTestId("run-detail").textContent).toContain("blocked");
    expect(screen.getByTestId("run-detail").textContent).toContain("provider error");
    expect((await screen.findByTestId("run-step")).textContent).toContain("llm_request");
    expect((await screen.findByTestId("run-audit-finding")).textContent).toContain("FAILED_STEP");

    fireEvent.click(screen.getByTestId("run-retry"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/runs/run_1/resume", expect.objectContaining({ method: "POST", body: JSON.stringify({ mode: "retry" }) })));

    fireEvent.click(screen.getByTestId("run-fork"));
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([url]) => url === "/api/runs/run_1/resume");
      expect(calls.some(([, init]) => String(init?.body).includes('"mode":"fork"'))).toBe(true);
    });

    fireEvent.click(screen.getAllByTestId("run-item")[1] as HTMLElement);
    await waitFor(() => expect(screen.getByTestId("run-status").textContent).toContain("running"));
    fireEvent.click(screen.getByTestId("run-stop"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/sessions/ses_1/stop", expect.objectContaining({ method: "POST" })));
  });

  it("renders inside the Task workspace tab", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("tab-task"));
    expect(await screen.findByTestId("task-panel")).toBeTruthy();
  });
});
