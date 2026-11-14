import { describe, expect, it } from "vitest";
import { contextView } from "../../src/context";

const base = { providerId: "p", model: "m" };

describe("contextView", () => {
  it("shows nothing before any request", () => {
    expect(contextView(null)).toBeNull();
  });

  it("shows a percentage and a plain title when the window is known", () => {
    const view = contextView({ ...base, usedTokens: 42_000, windowTokens: 128_000 });
    expect(view).toMatchObject({ label: "ctx 33%", level: "ok" });
    expect(view?.title).toContain("42,000 of 128,000 tokens");
    expect(view?.title).toContain("m");
  });

  it("warns from 70 percent and flags high from 90 with a /compact hint", () => {
    expect(contextView({ ...base, usedTokens: 70_000, windowTokens: 100_000 })?.level).toBe("warn");
    const high = contextView({ ...base, usedTokens: 95_000, windowTokens: 100_000 });
    expect(high?.level).toBe("high");
    expect(high?.title).toMatch(/\/compact/);
  });

  it("caps the percentage at 100 and never divides by zero", () => {
    expect(contextView({ ...base, usedTokens: 150_000, windowTokens: 100_000 })?.label).toBe("ctx 100%");
    expect(contextView({ ...base, usedTokens: 10, windowTokens: 0 })?.label).toBe("ctx 10");
  });

  it("falls back to a compact token count when the window is unknown", () => {
    expect(contextView({ ...base, usedTokens: 12_345, windowTokens: null })).toMatchObject({ label: "ctx 12.3k", level: "ok" });
    expect(contextView({ ...base, usedTokens: 800, windowTokens: null })?.label).toBe("ctx 800");
  });
});
