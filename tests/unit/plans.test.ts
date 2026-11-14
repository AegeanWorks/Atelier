import { describe, expect, it } from "vitest";
import { isPlanStatus, planTitle } from "../../server/plans";

describe("plan title derivation", () => {
  it("strips a markdown heading", () => {
    expect(planTitle("# Ship the Plans tab\n\nStep one")).toBe("Ship the Plans tab");
  });

  it("strips a list marker and skips leading blank lines", () => {
    expect(planTitle("\n\n- Step one\n- Step two")).toBe("Step one");
  });

  it("falls back to Plan for an empty body", () => {
    expect(planTitle("   \n\n")).toBe("Plan");
  });

  it("truncates a long first line to 80 characters", () => {
    const title = planTitle("x".repeat(120));
    expect(title).toHaveLength(80);
    expect(title.endsWith("...")).toBe(true);
  });
});

describe("plan statuses", () => {
  it("accepts the four declared statuses and nothing else", () => {
    expect(isPlanStatus("draft")).toBe(true);
    expect(isPlanStatus("active")).toBe(true);
    expect(isPlanStatus("done")).toBe(true);
    expect(isPlanStatus("archived")).toBe(true);
    expect(isPlanStatus("deleted")).toBe(false);
  });
});
