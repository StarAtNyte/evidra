import type { RunResult } from "./types.js";

export interface RunComparison {
  baselineRunId: string;
  candidateRunId: string;
  metric: string;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  direction: "improved" | "regressed" | "unchanged" | "insufficient_data";
  evidence: "scalar_only" | "replicated" | "insufficient_data";
  probabilityImproved?: number;
  permutationPValue?: number;
  confidenceInterval?: [number, number];
  note: string;
}

function quantile(values: number[], probability: number): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** Paired bootstrap over fold/seed metrics. A fixed PRNG keeps reports reproducible. */
export function compareMetricSeries(baseline: number[], candidate: number[], lowerIsBetter = true, resamples = 2000): { delta: number; probabilityImproved: number; confidenceInterval: [number, number]; samples: number } {
  if (baseline.length === 0 || candidate.length === 0) throw new Error("Metric series are empty.");
  if (baseline.length !== candidate.length) throw new Error("Metric series must have matching fold/seed cardinality before paired comparison.");
  const length = baseline.length;
  const differences = Array.from({ length }, (_, index) => candidate[index] - baseline[index]);
  const observed = differences.reduce((sum, value) => sum + value, 0) / length;
  let state = 0x9e3779b9;
  const nextRandom = (): number => {
    state = (Math.imul(state ^ (state >>> 16), 0x21f0aaad) + 0x735a2d97) | 0;
    return (state >>> 0) / 0x100000000;
  };
  const bootstrap: number[] = [];
  let improved = 0;
  for (let sample = 0; sample < Math.max(200, resamples); sample += 1) {
    let total = 0;
    for (let index = 0; index < length; index += 1) total += differences[Math.floor(nextRandom() * length)];
    const delta = total / length;
    bootstrap.push(delta);
    if (lowerIsBetter ? delta < 0 : delta > 0) improved += 1;
  }
  return { delta: observed, probabilityImproved: improved / bootstrap.length, confidenceInterval: [quantile(bootstrap, 0.025), quantile(bootstrap, 0.975)], samples: bootstrap.length };
}

/** Deterministic paired sign-permutation p-value for the one-sided improvement hypothesis. */
export function pairedPermutationPValue(baseline: number[], candidate: number[], lowerIsBetter = true, samples = 10_000): number {
  if (baseline.length === 0 || candidate.length === 0 || baseline.length !== candidate.length) throw new Error("Permutation inputs must have matching non-empty cardinality.");
  const improvements = baseline.map((value, index) => lowerIsBetter ? value - candidate[index] : candidate[index] - value);
  const observed = improvements.reduce((sum, value) => sum + value, 0) / improvements.length;
  let favorable = 0;
  let total = 0;
  const exact = improvements.length <= 16;
  const iterations = exact ? 2 ** improvements.length : Math.max(1_000, samples);
  let state = 0x243f6a88;
  const random = (): number => {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x297a2d39) | 0;
    return (state >>> 0) / 0x100000000;
  };
  for (let mask = 0; mask < iterations; mask += 1) {
    let mean = 0;
    for (let index = 0; index < improvements.length; index += 1) {
      const positive = exact ? (mask & (1 << index)) !== 0 : random() >= 0.5;
      mean += positive ? improvements[index] : -improvements[index];
    }
    if (mean / improvements.length >= observed - 1e-12) favorable += 1;
    total += 1;
  }
  return (favorable + 1) / (total + 1);
}

export function compareRuns(baseline: RunResult, candidate: RunResult, metric = "final_layer_mse", lowerIsBetter = true): RunComparison {
  const base = baseline.metrics[metric] ?? null;
  const next = candidate.metrics[metric] ?? null;
  if (base === null || next === null) {
    return { baselineRunId: baseline.runId, candidateRunId: candidate.runId, metric, baseline: base, candidate: next, delta: null, direction: "insufficient_data", evidence: "insufficient_data", note: "Both runs must expose the same finite metric." };
  }
  const baselineSeries = baseline.metricsByFold?.[metric] ?? [];
  const candidateSeries = candidate.metricsByFold?.[metric] ?? [];
  if (baselineSeries.length !== candidateSeries.length || (baselineSeries.length > 0 && baselineSeries.length < 2)) {
    return { baselineRunId: baseline.runId, candidateRunId: candidate.runId, metric, baseline: base, candidate: next, delta: null, direction: "insufficient_data", evidence: "insufficient_data", note: "Fold/seed metric series must have matching cardinality and at least two paired values." };
  }
  if (baselineSeries.length > 1 && candidateSeries.length > 1) {
    const series = compareMetricSeries(baselineSeries, candidateSeries, lowerIsBetter);
    const permutationPValue = pairedPermutationPValue(baselineSeries, candidateSeries, lowerIsBetter);
    const improved = lowerIsBetter ? series.delta < 0 : series.delta > 0;
    return {
      baselineRunId: baseline.runId,
      candidateRunId: candidate.runId,
      metric,
      baseline: base,
      candidate: next,
      delta: series.delta,
      direction: series.delta === 0 ? "unchanged" : improved ? "improved" : "regressed",
      evidence: "replicated",
      probabilityImproved: series.probabilityImproved,
      permutationPValue,
      confidenceInterval: series.confidenceInterval,
      note: `Paired bootstrap plus sign-permutation test over ${baselineSeries.length} fold/seed values (${series.samples} bootstrap resamples; p=${permutationPValue.toFixed(4)}).`,
    };
  }
  const delta = next - base;
  const improved = lowerIsBetter ? delta < 0 : delta > 0;
  return {
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    metric,
    baseline: base,
    candidate: next,
    delta,
    direction: delta === 0 ? "unchanged" : improved ? "improved" : "regressed",
    evidence: "scalar_only",
    note: "Only aggregate scalar metrics are available; fold/seed confidence requires prediction artifacts.",
  };
}
