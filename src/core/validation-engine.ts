import { compareRuns, type RunComparison } from "./statistics.js";
import type { RunResult } from "./types.js";

export interface ValidationAcceptanceInput {
  baseline: RunResult;
  candidate: RunResult;
  metric: string;
  direction: "minimize" | "maximize";
  minimumDelta: number;
  maximumRegressionShift: number;
  requireReplication: boolean;
  leakageAuditPassed: boolean;
  reviewerApproved: boolean;
  subgroupDeltas?: number[];
  probabilityThreshold?: number;
}

export interface ValidationAcceptance {
  accepted: boolean;
  comparison: RunComparison;
  gates: {
    minimumDelta: boolean;
    statisticalConfidence: boolean;
    replication: boolean;
    subgroupRegression: boolean;
    leakageAudit: boolean;
    review: boolean;
  };
  reasons: string[];
  normalizedDelta: number | null;
  worstSubgroupDelta: number | null;
}

/**
 * Apply the promotion policy to paired run evidence. A scalar improvement is
 * never promoted as replicated evidence, and subgroup regressions are checked
 * independently from the aggregate metric.
 */
export function evaluateValidationAcceptance(input: ValidationAcceptanceInput): ValidationAcceptance {
  const lowerIsBetter = input.direction === "minimize";
  const comparison = compareRuns(input.baseline, input.candidate, input.metric, lowerIsBetter);
  const normalizedDelta = comparison.delta === null ? null : lowerIsBetter ? -comparison.delta : comparison.delta;
  const probabilityThreshold = input.probabilityThreshold ?? 0.95;
  const gates = {
    minimumDelta: normalizedDelta !== null && normalizedDelta >= input.minimumDelta,
    statisticalConfidence: comparison.evidence === "replicated" && (comparison.probabilityImproved ?? 0) >= probabilityThreshold,
    replication: !input.requireReplication || comparison.evidence === "replicated",
    subgroupRegression: !input.subgroupDeltas?.length || input.subgroupDeltas.every((delta) => delta >= -input.maximumRegressionShift),
    leakageAudit: input.leakageAuditPassed,
    review: input.reviewerApproved,
  };
  const worstSubgroupDelta = input.subgroupDeltas?.length ? Math.min(...input.subgroupDeltas) : null;
  const reasons: string[] = [];
  if (!gates.minimumDelta) reasons.push(`normalized delta ${normalizedDelta ?? "missing"} is below required ${input.minimumDelta}`);
  if (!gates.statisticalConfidence) reasons.push(`replicated improvement probability ${(comparison.probabilityImproved ?? 0).toFixed(3)} is below ${probabilityThreshold}`);
  if (!gates.replication) reasons.push("independent fold/seed replication is required");
  if (!gates.subgroupRegression) reasons.push(`worst subgroup delta ${worstSubgroupDelta?.toFixed(6)} exceeds allowed regression ${input.maximumRegressionShift}`);
  if (!gates.leakageAudit) reasons.push("leakage audit has not passed");
  if (!gates.review) reasons.push("independent reviewer approval is missing");
  return { accepted: Object.values(gates).every(Boolean), comparison, gates, reasons, normalizedDelta, worstSubgroupDelta };
}
