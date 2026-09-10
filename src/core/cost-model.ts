export interface CostObservation {
  operator: string;
  actualMinutes: number;
  status?: "completed" | "failed" | "timeout" | "rejected";
}

export interface CostEstimate {
  predictedMinutes: number;
  upperMinutes: number;
  sampleCount: number;
  uncertainty: number;
  rationale: string;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : ((sorted[middle - 1] ?? sorted[middle]) + sorted[middle]) / 2;
}

function percentile(values: number[], probability: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * probability))] ?? 0;
}

/** Estimate runtime conservatively from prior observed operator durations. */
export function estimateCost(operator: string, declaredMinutes: number, observations: CostObservation[]): CostEstimate {
  const fallback = Math.max(0.1, declaredMinutes);
  const usable = observations.filter((observation) => observation.operator === operator && Number.isFinite(observation.actualMinutes) && observation.actualMinutes > 0);
  if (!usable.length) return { predictedMinutes: fallback, upperMinutes: fallback, sampleCount: 0, uncertainty: 1, rationale: "no prior runtime observations; using the declared estimate" };
  const durations = usable.map((observation) => observation.actualMinutes);
  const predictedMinutes = median(durations);
  // With very small samples, a percentile would hide the only observed
  // overrun. Use the maximum until the history is large enough to estimate a
  // tail robustly.
  const observedUpper = durations.length < 5 ? Math.max(...durations) : percentile(durations, 0.9);
  const failureInflation = usable.some((observation) => observation.status === "failed" || observation.status === "timeout") ? 1.25 : 1;
  const upperMinutes = Math.max(predictedMinutes, observedUpper, fallback) * failureInflation;
  return {
    predictedMinutes,
    upperMinutes,
    sampleCount: usable.length,
    uncertainty: 1 / Math.sqrt(usable.length),
    rationale: `${usable.length} observed '${operator}' runtime(s); budgeted against the conservative upper estimate${failureInflation > 1 ? " with failure inflation" : ""}`,
  };
}
