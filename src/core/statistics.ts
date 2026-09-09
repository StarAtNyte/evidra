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
  const length = Math.min(baseline.length, candidate.length);
  if (length === 0) throw new Error("Metric series are empty.");
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

export function compareRuns(baseline: RunResult, candidate: RunResult, metric = "final_layer_mse", lowerIsBetter = true): RunComparison {
  const base = baseline.metrics[metric] ?? null;
  const next = candidate.metrics[metric] ?? null;
  if (base === null || next === null) {
    return { baselineRunId: baseline.runId, candidateRunId: candidate.runId, metric, baseline: base, candidate: next, delta: null, direction: "insufficient_data", evidence: "insufficient_data", note: "Both runs must expose the same finite metric." };
  }
  const baselineSeries = baseline.metricsByFold?.[metric] ?? [];
  const candidateSeries = candidate.metricsByFold?.[metric] ?? [];
  if (baselineSeries.length > 1 && candidateSeries.length > 1) {
    const series = compareMetricSeries(baselineSeries, candidateSeries, lowerIsBetter);
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
      confidenceInterval: series.confidenceInterval,
      note: `Paired bootstrap over ${Math.min(baselineSeries.length, candidateSeries.length)} fold/seed values (${series.samples} resamples).`,
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
