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
  note: string;
}

export function compareRuns(baseline: RunResult, candidate: RunResult, metric = "final_layer_mse", lowerIsBetter = true): RunComparison {
  const base = baseline.metrics[metric] ?? null;
  const next = candidate.metrics[metric] ?? null;
  if (base === null || next === null) {
    return { baselineRunId: baseline.runId, candidateRunId: candidate.runId, metric, baseline: base, candidate: next, delta: null, direction: "insufficient_data", evidence: "insufficient_data", note: "Both runs must expose the same finite metric." };
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
