/**
 * Both perf gates divide out host speed, so the helper they share is worth pinning directly:
 * a wrong ratio here would silently loosen or tighten every budget in the project.
 */
import { describe, expect, it } from "vitest";
import { calibrateHost, HOST_REFERENCE_MS, hostScale } from "../../scripts/hostCalibration";

describe("host calibration", () => {
  it("returns a positive, finite reading", () => {
    const reading = calibrateHost();
    expect(Number.isFinite(reading)).toBe(true);
    expect(reading).toBeGreaterThan(1);
  });

  it("scales in proportion to the reference", () => {
    // Twice the reference time means a host twice as slow, so limits double.
    expect(hostScale(HOST_REFERENCE_MS * 2)).toBeCloseTo(2, 5);
    expect(hostScale(HOST_REFERENCE_MS)).toBeCloseTo(1, 5);
    expect(hostScale(HOST_REFERENCE_MS / 2)).toBeCloseTo(0.5, 5);
  });

  it("accepts an explicit reference, which is how one baseline is compared to another", () => {
    expect(hostScale(400, 200)).toBeCloseTo(2, 5);
    expect(hostScale(100, 200)).toBeCloseTo(0.5, 5);
  });

  it("falls back to 1 rather than dividing by zero", () => {
    // A corrupt reading must not produce Infinity and silently pass every budget.
    expect(hostScale(0)).toBe(1);
    expect(hostScale(-5)).toBe(1);
    expect(hostScale(Number.NaN)).toBe(1);
    expect(hostScale(200, 0)).toBe(1);
  });
});
