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

const boot = {
  version: "0.1.0",
  workspace: "/work",
  sessions: [{ id: "ses_1", title: "Skill", created: 1, updated: 1 }],
  profiles: [],
  providers: [],
  recovery: { startedAt: 0, finishedAt: 1, actionCount: 0, result: "clean", actions: [] },
};
const PATH = ".atelier/skills/release/SKILL.md";
let exists = false;
let commands: Array<Record<string, unknown>> = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/commands") return new Response(JSON.stringify({ commands }), { status: 200 });
  if (url === "/api/skills" && method === "POST") {
    if (exists) return new Response(JSON.stringify({ error: { code: "SKILL_EXISTS", what: "A skill with that name already exists.", why: "release is already defined.", fix: "Pick another name, or edit the existing skill." } }), { status: 409 });
    exists = true;
    commands = [{ name: "release", description: "Skill: Cut a release", kind: "custom", template: "t" }];
    return new Response(JSON.stringify({ skill: { name: "release", description: "Cut a release", path: PATH } }), { status: 201 });
  }
  if (url === "/api/workspace/tree") return new Response(JSON.stringify({ entries: [] }), { status: 200 });
  if (url === `/api/workspace/file?path=${encodeURIComponent(PATH)}`) return new Response(JSON.stringify({ path: PATH, content: "---\nname: release\n---\n", hash: "h", size: 20 }), { status: 200 });
  if (url === "/api/sessions/ses_1/messages") return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/approvals?pending=1") return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: "nope" } }), { status: 404 });
});

beforeEach(() => {
  exists = false;
  commands = [];
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  localStorage.clear();
  fetchMock.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function command(text: string): Promise<void> {
  const input = await screen.findByTestId("composer-input");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
}

function posts(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([url, init]) => url === "/api/skills" && (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

describe("/skill-new", () => {
  it("creates the skill, opens its file for editing and makes it a /command", async () => {
    render(<App />);
    await command("/skill-new release Cut a release with the checklist");
    await waitFor(() => expect(posts()).toEqual([{ name: "release", description: "Cut a release with the checklist" }]));
    expect(await screen.findByDisplayValue(/name: release/)).toBeTruthy();
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "/rel" } });
    expect((await screen.findAllByTestId("slash-option")).length).toBe(1);
  });

  it("sends no description when only a name is given", async () => {
    render(<App />);
    await command("/skill-new release");
    await waitFor(() => expect(posts()).toEqual([{ name: "release" }]));
  });

  it("explains the usage when the name is missing and creates nothing", async () => {
    render(<App />);
    await command("/skill-new ");
    expect((await screen.findAllByText(/Usage: \/skill-new <name>/)).length).toBeGreaterThan(0);
    expect(posts()).toHaveLength(0);
  });

  it("shows the server's message when the skill already exists", async () => {
    exists = true;
    render(<App />);
    await command("/skill-new release");
    expect((await screen.findAllByText(/already exists/i)).length).toBeGreaterThan(0);
  });

  it("is inserted for you to finish when picked from the menu", async () => {
    render(<App />);
    const input = await screen.findByTestId("composer-input");
    fireEvent.change(input, { target: { value: "/skill-n" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).value).toBe("/skill-new "));
    expect(posts()).toHaveLength(0);
  });
});
