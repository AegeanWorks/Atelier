// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  sessions: [{ id: "ses_1", title: "Skills", created: 1, updated: 1 }],
  profiles: [],
  providers: [],
  recovery: { startedAt: 0, finishedAt: 1, actionCount: 0, result: "clean", actions: [] },
};
let skills: Array<{ name: string; description: string; path: string }> = [];
let commands: Array<{ name: string; description: string; kind: string; template: string }> = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === "/api/auth") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url === "/api/boot") return new Response(JSON.stringify(boot), { status: 200 });
  if (url === "/api/commands") return new Response(JSON.stringify({ commands }), { status: 200 });
  if (url === "/api/skills") return new Response(JSON.stringify({ skills }), { status: 200 });
  if (url === "/api/sessions/ses_1/messages") return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  if (url === "/api/sessions/ses_1/approvals?pending=1") return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: "nope" } }), { status: 404 });
});

beforeEach(() => {
  skills = [];
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

describe("/skills", () => {
  it("lists the discovered skills with their descriptions", async () => {
    skills = [
      { name: "release", description: "Cut a release", path: ".atelier/skills/release/SKILL.md" },
      { name: "triage", description: "Triage a bug", path: ".atelier/skills/triage/SKILL.md" },
    ];
    render(<App />);
    await command("/skills");
    const notice = (await screen.findAllByText(/2 skills/)).at(0)?.textContent ?? "";
    expect(notice).toContain("/release");
    expect(notice).toContain("/triage");
  });

  it("explains where to add skills when there are none", async () => {
    render(<App />);
    await command("/skills");
    expect((await screen.findAllByText(/\.atelier\/skills\/<name>\/SKILL\.md/)).length).toBeGreaterThan(0);
  });

  it("refreshes the slash menu so a skill added after boot shows up as a command", async () => {
    render(<App />);
    const input = await screen.findByTestId("composer-input");
    fireEvent.change(input, { target: { value: "/rel" } });
    expect(screen.queryByTestId("slash-menu")).toBeNull();
    skills = [{ name: "release", description: "Cut a release", path: ".atelier/skills/release/SKILL.md" }];
    commands = [{ name: "release", description: "Skill: Cut a release", kind: "custom", template: "t" }];
    await command("/skills");
    await screen.findAllByText(/1 skill/);
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "/rel" } });
    expect((await screen.findAllByTestId("slash-option")).length).toBe(1);
  });
});
