/**
 * Measuring wall-clock milliseconds on a shared machine measures the machine as much as the code.
 *
 * Measured here: an untouched tree produced toolDispatchP95 of 3.49 ms and 18.63 ms on different
 * runs, and the loaded samples were internally *consistent* (1-18% spread) rather than scattered,
 * so a spread threshold cannot distinguish a busy host from a regression. A fixed workload that
 * has nothing to do with atelier can: it measured 187.9-194.4 ms across passes (3.4% spread)
 * while the atelier metrics moved 2-3x.
 *
 * Every gate that compares milliseconds over time records this and divides by it, so the
 * comparison is about the code rather than about what else the computer was doing.
 */

/**
 * Round count for the calibration workload: enough to dwarf process startup, about 190 ms on the
 * host the numbers in this repository were recorded on.
 */
const CALIBRATION_ROUNDS = 60_000_000;

/**
 * The reading the recorded baselines were written against, on this host.
 *
 * A baseline stores its own calibration too, so the ratio between the two is what matters; this
 * constant exists for the first baseline and for the absolute budgets, which had to start
 * somewhere.
 */
export const HOST_REFERENCE_MS = 189.8;

/**
 * Time a fixed integer workload and return the elapsed milliseconds.
 *
 * The accumulator is kept live so the loop cannot be optimised away, and the result is floored
 * at 1 so a caller dividing by it can never produce an infinity.
 */
export function calibrateHost(): number {
  let accumulator = 0;
  const started = performance.now();
  for (let index = 0; index < CALIBRATION_ROUNDS; index += 1) accumulator = (accumulator + index * 31) % 1_000_003;
  const elapsed = performance.now() - started;
  if (accumulator < 0) throw new Error("calibration accumulator wrapped; the workload cannot be trusted");
  return Math.max(1, Number(elapsed.toFixed(2)));
}

/**
 * How much slower this host is than `referenceMs`, as a multiplier to apply to a millisecond
 * limit. A host measured at twice the reference time allows twice the milliseconds.
 */
export function hostScale(currentMs: number, referenceMs: number = HOST_REFERENCE_MS): number {
  if (!Number.isFinite(currentMs) || currentMs <= 0 || !Number.isFinite(referenceMs) || referenceMs <= 0) return 1;
  return currentMs / referenceMs;
}
