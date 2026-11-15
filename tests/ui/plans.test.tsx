// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";
import PlansPanel from "../../src/PlansPanel";

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(_type: string, _listener: (event: MessageEvent) => void): void {}
  close(): void {}
}

const plan = {
  id: "plan_1",
  session_id: "ses_1",
  title: "Provider plan",
  body: "# Provider plan\n\nDo the thing.",
  status: "draft",
  source_run_id: "run_1",
  created: 1,
  updated: 1,
};

const boot = {
  version: "0.1.0",
  workspace: "C:\\work",
  sessions: [{ id: "ses_1", title: "Plans", created: 1, updated: 1 }],
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
  if (url === "/api/plans?session=ses_1" && method === "GET") return new Response(JSON.stringify({ plans: [plan] }), { status: 200 });
  if (url === "/api/plans" && method === "POST") return new Response(JSON.stringify({ plan: { ...plan, id: "plan_2", title: "New plan" } }), { status: 201 });
  if (url === "/api/plans/plan_1/revisions" && method === "GET") {
    return new Response(JSON.stringify({ revisions: [
      { id: "rev_2", plan_id: "plan_1", title: plan.title, body: plan.body, status: "draft", created: 2 },
      { id: "rev_1", plan_id: "plan_1", title: "Older", body: "# Older\n\nFirst draft.", status: "draft", created: 1 },
    ] }), { status: 200 });
  }
  if (url === "/api/plans/plan_1/revisions/rev_1/restore" && method === "POST") return new Response(JSON.stringify({ plan }), { status: 200 });
  if (url === "/api/plans/plan_1" && method === "PATCH") return new Response(JSON.stringify({ plan: { ...plan, status: "active" } }), { status: 200 });
  if (url === "/api/plans/plan_1" && method === "DELETE") return new Response(JSON.stringify({ ok: true }), { status: 200 });
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

describe("plans panel", () => {
  it("lists plans, shows a body, creates, updates status and deletes", async () => {
    render(<PlansPanel sessionId="ses_1" refreshTick={0} />);
    expect(await screen.findByTestId("plan-item")).toBeTruthy();
    expect(screen.getByTestId("plan-body").textContent).toContain("Do the thing");

    fireEvent.change(screen.getByTestId("plan-title-input"), { target: { value: "New plan" } });
    fireEvent.change(screen.getByTestId("plan-body-input"), { target: { value: "Steps" } });
    fireEvent.click(screen.getByTestId("plan-create"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/plans", expect.objectContaining({ method: "POST" })));

    expect(await screen.findByTestId("plan-history")).toBeTruthy();
    fireEvent.click(screen.getAllByTestId("plan-revision")[1] as HTMLElement);
    expect((await screen.findByTestId("plan-revision-body")).textContent).toContain("First draft");
    fireEvent.click(screen.getByTestId("plan-revision-restore"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/plans/plan_1/revisions/rev_1/restore", expect.objectContaining({ method: "POST" })));

    fireEvent.click(screen.getByTestId("plan-activate"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/plans/plan_1", expect.objectContaining({ method: "PATCH" })));

    fireEvent.click(screen.getByTestId("plan-delete"));
    const confirmDelete = await screen.findByTestId("plan-delete-confirm");
    expect(confirmDelete.textContent).toBe("Delete?");
    fireEvent.click(confirmDelete);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/plans/plan_1", expect.objectContaining({ method: "DELETE" })));
  });

  it("requires a confirming click before deleting a plan", async () => {
    render(<PlansPanel sessionId="ses_1" refreshTick={0} />);
    await screen.findByTestId("plan-detail");
    expect(screen.getByTestId("plan-item").classList.contains("active")).toBe(true);
    const deleteCalls = () => fetchMock.mock.calls.filter(([url, init]) => url === "/api/plans/plan_1" && init?.method === "DELETE").length;
    fireEvent.click(screen.getByTestId("plan-delete"));
    expect(deleteCalls()).toBe(0);
    const confirm = await screen.findByTestId("plan-delete-confirm");
    expect(confirm.textContent).toBe("Delete?");
    fireEvent.click(confirm);
    await waitFor(() => expect(deleteCalls()).toBe(1));
  });

  it("renders inside the Plans workspace tab", async () => {
    render(<App />);
    await screen.findByText("What are we building?");
    fireEvent.click(screen.getByTestId("tab-plans"));
    expect(await screen.findByTestId("plans-panel")).toBeTruthy();
  });
});
