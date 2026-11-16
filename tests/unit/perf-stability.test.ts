/**
 * The perf gate must not call a busy host a regression. Measured on this machine, the untouched
 * tree took 3.49 ms and 18.63 ms of toolDispatchP95 on different runs, and the loaded samples
 * were internally *consistent* (1-18% spread) but shifted to a higher level, so a spread
 * threshold cannot tell a busy host from slow code.
 *
 * The gate now divides out a fixed CPU workload that has nothing to do with atelier. This pins
 * the arithmetic: the same absolute numbers must pass on a "slower" host and a genuine
 * regression must still fail.
 */
import { describe, expect, it } from "vitest";

/** Mirrors scripts/agent-perf.ts. */
const REGRESSION_RATIO = 1.5;
const REGRESSION_MADS = 6;
const HOST_REFERENCE_MS = 189.8;

/** Does `candidate` pass the budget after both sides are normalised by their calibration? */
function withinBudget(
  candidate: { value: number; calibrationMs: number },
  budget: number,
  referenceMs = HOST_REFERENCE_MS,
): boolean {
  const hostScale = candidate.calibrationMs / referenceMs;
  return candidate.value <= budget * hostScale;
}

/** The relative check, mirroring regressions() in the script. */
function withinBaseline(
  candidate: { value: number; calibrationMs: number },
  baseline: { value: number; calibrationMs: number; mad: number },
): { ok: boolean; hostEquivalent: number; limit: number } {
  const scale = candidate.calibrationMs / baseline.calibrationMs;
  const hostEquivalent = candidate.value / scale;
  const limit = Math.max(baseline.value * REGRESSION_RATIO, baseline.value + baseline.mad * REGRESSION_MADS);
  return { ok: hostEquivalent <= limit, hostEquivalent, limit };
}

describe("perf gate host calibration", () => {
  it("lets the same absolute numbers pass on a host measured 2x slower", () => {
    // 4 ms of tool dispatch is inside a 10 ms budget on the reference host...
    expect(withinBudget({ value: 4, calibrationMs: HOST_REFERENCE_MS }, 10)).toBe(true);
    // ...and still inside it when the same code runs where the calibration workload takes 2x.
    expect(withinBudget({ value: 8, calibrationMs: HOST_REFERENCE_MS * 2 }, 10)).toBe(true);
  });

  it("still fails a value that is over budget for the host it ran on", () => {
    // 40 ms against a 10 ms budget is a regression at any calibration.
    expect(withinBudget({ value: 40, calibrationMs: HOST_REFERENCE_MS }, 10)).toBe(false);
    expect(withinBudget({ value: 80, calibrationMs: HOST_REFERENCE_MS * 2 }, 10)).toBe(false);
  });

  it("treats a slow host as no regression but a real slowdown as one", () => {
    const baseline = { value: 5, calibrationMs: 200, mad: 0.5 };
    // Same code, host 2x slower: the raw number doubles, the calibrated one does not.
    expect(withinBaseline({ value: 10, calibrationMs: 400 }, baseline).ok).toBe(true);
    // Same host, code 3x slower: the calibrated value is what moved.
    expect(withinBaseline({ value: 15, calibrationMs: 200 }, baseline).ok).toBe(false);
  });

  it("reports the host-equivalent value so a failure names the comparison it made", () => {
    const baseline = { value: 5, calibrationMs: 200, mad: 0.5 };
    const verdict = withinBaseline({ value: 15, calibrationMs: 200 }, baseline);
    expect(verdict.hostEquivalent).toBe(15);
    // The limit is the more generous of the ratio and the spread bound: max(5*1.5, 5 + 0.5*6) = 8.
    expect(verdict.limit).toBeCloseTo(8, 5);
  });
});
