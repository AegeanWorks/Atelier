import { describe, expect, it } from "vitest";
import { bootstrapDelta, mcnemarExact, percentile, wilson } from "../../server/eval/stats";

describe("eval statistics", () => {
  it("computes Wilson intervals", () => {
    const zero = wilson(0, 10);
    expect(zero.low).toBe(0);
    expect(zero.high).toBeGreaterThan(0.2);
    const all = wilson(10, 10);
    expect(all.high).toBe(1);
    expect(all.low).toBeLessThan(0.8);
  });

  it("returns a zero paired delta for identical vectors", () => {
    const delta = bootstrapDelta([1, 0, 1], [1, 0, 1]);
    expect(delta.mean).toBe(0);
    expect(delta.low).toBe(0);
    expect(delta.high).toBe(0);
  });

  it("computes exact McNemar for flips", () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(5, 0)).toBeCloseTo(0.0625, 6);
  });

  it("computes percentiles", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([], 0.5)).toBe(0);
  });
});
