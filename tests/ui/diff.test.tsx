// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import DiffView, { diffStat } from "../../src/DiffView";

afterEach(cleanup);

const sample = ["--- a/src/a.ts", "+++ b/src/a.ts", " context", "-old line", "+new line", " tail"].join("\n");

describe("DiffView", () => {
  it("counts only real changes, not file headers", () => {
    expect(diffStat(sample)).toEqual({ added: 1, removed: 1 });
    expect(diffStat("--- a/x\n+++ b/x")).toEqual({ added: 0, removed: 0 });
  });

  it("renders a collapsed summary with the stat", () => {
    render(<DiffView diff={sample} />);
    expect(screen.getByTestId("diff-view").hasAttribute("open")).toBe(false);
    expect(screen.getByTestId("diff-add").textContent).toBe("+1");
    expect(screen.getByTestId("diff-del").textContent).toContain("1");
  });

  it("marks each line with its kind and can open by default", () => {
    render(<DiffView diff={sample} defaultOpen />);
    expect(screen.getByTestId("diff-view").hasAttribute("open")).toBe(true);
    const body = screen.getByTestId("diff-body");
    expect(body.querySelectorAll(".diff-line-add")).toHaveLength(1);
    expect(body.querySelectorAll(".diff-line-del")).toHaveLength(1);
    expect(body.querySelectorAll(".diff-line-meta")).toHaveLength(2);
    expect(body.textContent).toContain("+new line");
  });
});
