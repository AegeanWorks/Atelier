// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EvalsPanel from "../../src/EvalsPanel";

const baseFetch = async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === "/api/evals/runs") {
    return new Response(JSON.stringify({
      runs: [{
        id: "eval_1",
        suite: "harness",
        split: "validation",
        model: "fixture",
        profile: { id: "build" },
        status: "finished",
        created: 1,
        metrics: { mean: 0.82, p95Ms: 12 },
      }],
    }), { status: 200 });
  }
  if (url === "/api/evals/baselines") {
    return new Response(JSON.stringify({
      baselines: [{ label: "h1", suite: "harness", split: "validation", harnessVersion: "1" }],
    }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: url } }), { status: 404 });
};

const fetchMock = vi.fn(baseFetch);

function setEmpty(): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/evals/runs") return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    if (url === "/api/evals/baselines") return new Response(JSON.stringify({ baselines: [] }), { status: 200 });
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", what: url } }), { status: 404 });
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(baseFetch);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("evals compare card", () => {
  it("labels the baseline and candidate controls", async () => {
    render(<EvalsPanel />);
    await waitFor(() => expect(screen.getByTestId("eval-baseline")).toBeTruthy());
    expect(screen.getByText("Baseline")).toBeTruthy();
    expect(screen.getByText("Candidate run")).toBeTruthy();
    expect((screen.getByTestId("eval-baseline") as HTMLSelectElement).disabled).toBe(false);
    expect((screen.getByTestId("eval-compare-run") as HTMLButtonElement).disabled).toBe(false);
  });

  it("explains missing inputs instead of showing empty selects", async () => {
    setEmpty();
    render(<EvalsPanel />);
    expect(await screen.findByText("No baselines yet")).toBeTruthy();
    expect(screen.getByText("No harness runs yet")).toBeTruthy();
    const hint = (await screen.findByText(/No eval runs yet/)).querySelector("code");
    expect(hint?.textContent).toBe("npm run eval");
    expect(document.body.textContent).not.toContain("`");
    expect((screen.getByTestId("eval-baseline") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByTestId("eval-candidate") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByTestId("eval-compare-run") as HTMLButtonElement).disabled).toBe(true);
  });
});
