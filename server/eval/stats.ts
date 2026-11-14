export function wilson(successes: number, total: number): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function bootstrapDelta(
  baseline: number[],
  candidate: number[],
  options: { samples?: number; seed?: number } = {},
): { mean: number; low: number; high: number } {
  if (baseline.length !== candidate.length || baseline.length === 0) return { mean: 0, low: 0, high: 0 };
  const differences = baseline.map((value, index) => (candidate[index] ?? 0) - value);
  const mean = differences.reduce((total, value) => total + value, 0) / differences.length;
  const samples = options.samples ?? 2000;
  const next = random(options.seed ?? 20261108);
  const means: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    for (let index = 0; index < differences.length; index += 1) {
      total += differences[Math.floor(next() * differences.length)] ?? 0;
    }
    means.push(total / differences.length);
  }
  return { mean, low: percentile(means, 0.025), high: percentile(means, 0.975) };
}

function combination(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let index = 1; index <= Math.min(k, n - k); index += 1) result = (result * (n - index + 1)) / index;
  return result;
}

export function mcnemarExact(baselineOnly: number, candidateOnly: number): number {
  const n = baselineOnly + candidateOnly;
  if (n === 0) return 1;
  const low = Math.min(baselineOnly, candidateOnly);
  let tail = 0;
  for (let k = 0; k <= low; k += 1) tail += combination(n, k) * 0.5 ** n;
  return Math.min(1, 2 * tail);
}

export function summarize(values: number[]): { mean: number; p50: number; p95: number } {
  if (values.length === 0) return { mean: 0, p50: 0, p95: 0 };
  return {
    mean: values.reduce((total, value) => total + value, 0) / values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  };
}
