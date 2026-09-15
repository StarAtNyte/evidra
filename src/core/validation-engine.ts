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
  /** Whether a distinct child experiment manifest produced a valid result. */
  independentReplicationObserved?: boolean;
  subgroupDeltas?: number[];
  requiresSubgroupAnalysis?: boolean;
  subgroupAnalysisObserved?: boolean;
  probabilityThreshold?: number;
  /** Number of candidate comparisons in the current search family/campaign. */
  comparisonCount?: number;
  /** Production paths can require a paired randomization test in addition to bootstrap evidence. */
  requirePermutationTest?: boolean;
  /** Absolute normalized-gain threshold that triggers the extra scrutiny gate. */
  largeGainThreshold?: number;
  /** Result of the manifest's optional strict fold/seed coverage contract. */
  evaluationCoverage?: boolean;
  /** Secondary objectives are protected from regression but do not replace the primary gate. */
  secondaryMetrics?: Array<{ name: string; direction: "minimize" | "maximize"; minimumDelta?: number; maximumRegression?: number }>;
}

export interface ValidationAcceptance {
  accepted: boolean;
  comparison: RunComparison;
  gates: {
    minimumDelta: boolean;
    statisticalConfidence: boolean;
    permutationConfidence: boolean;
    replication: boolean;
    subgroupRegression: boolean;
    subgroupAnalysis?: boolean;
    leakageAudit: boolean;
    review: boolean;
    unexpectedGainReview: boolean;
    secondaryMetrics: boolean;
  };
  reasons: string[];
  normalizedDelta: number | null;
  worstSubgroupDelta: number | null;
  adjustedProbabilityThreshold: number;
  secondaryAssessments: Array<{
    name: string;
    direction: "minimize" | "maximize";
    normalizedDelta: number | null;
    minimumDelta: number;
    maximumRegression: number;
    evidence: RunComparison["evidence"];
    passed: boolean;
  }>;
}

export interface SplitRunPair {
  split: string;
  baseline: RunResult;
  candidate: RunResult;
}

/** Re-open only the replication gate after a verified child confirms the improvement. */
export function applyIndependentReplicationEvidence(acceptance: ValidationAcceptance, observed: boolean): ValidationAcceptance {
  if (!observed) return acceptance;
  const gates = { ...acceptance.gates, replication: true, unexpectedGainReview: acceptance.gates.unexpectedGainReview || acceptance.gates.review };
  return {
    ...acceptance,
    accepted: Object.values(gates).every(Boolean),
    gates,
    reasons: acceptance.reasons.filter((reason) => !/independently executed child experiment is required/i.test(reason)),
  };
}

export interface MultiSplitValidation {
  accepted: boolean;
  splits: Array<{ split: string; comparison: RunComparison; normalizedDelta: number | null; passed: boolean }>;
  worstNormalizedDelta: number | null;
  reasons: string[];
  secondaryMetrics: Array<{
    name: string;
    splits: Array<{ split: string; normalizedDelta: number | null; passed: boolean }>;
    passed: boolean;
  }>;
}

/** Count every attempted metric candidate in a dataset family, not only wins. */
export function comparisonFamilySize(manifests: Array<{ datasetVersion?: unknown; outcomeType?: unknown }>, datasetVersion: string): number {
  return Math.max(1, manifests.filter((manifest) =>
    manifest.datasetVersion === datasetVersion && (manifest.outcomeType === undefined || manifest.outcomeType === "metric")).length);
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
  // A large relative jump is valuable evidence, but also a common signature
  // of leakage, split mismatch, or evaluator mistakes. Require the stronger
  // independent-review path for such results even when ordinary replication
  // was disabled for a small probe.
  const baselineScale = Math.abs(comparison.baseline ?? 0);
  const scrutinyThreshold = input.largeGainThreshold !== undefined ? input.largeGainThreshold : Math.max(0.05, baselineScale * 0.25);
  const unexpectedGain = normalizedDelta !== null && normalizedDelta >= scrutinyThreshold;
  const probabilityThreshold = input.probabilityThreshold ?? 0.95;
  const comparisonCount = Math.max(1, Math.floor(input.comparisonCount ?? 1));
  // Bonferroni-style family-wise correction prevents a campaign from treating
  // one lucky result among many hypotheses as statistically convincing.
  const adjustedProbabilityThreshold = 1 - ((1 - probabilityThreshold) / comparisonCount);
  const secondaryResults = (input.secondaryMetrics ?? []).map((objective) => {
    const secondary = compareRuns(input.baseline, input.candidate, objective.name, objective.direction === "minimize");
    const normalized = secondary.delta === null ? null : objective.direction === "minimize" ? -secondary.delta : secondary.delta;
    const minimumDelta = objective.minimumDelta ?? 0;
    const maximumRegression = objective.maximumRegression ?? 0;
    return { name: objective.name, direction: objective.direction, normalizedDelta: normalized, minimumDelta, maximumRegression, evidence: secondary.evidence, passed: normalized !== null && normalized >= minimumDelta - maximumRegression };
  });
  const gates = {
    minimumDelta: normalizedDelta !== null && normalizedDelta >= input.minimumDelta,
    statisticalConfidence: comparison.evidence === "replicated" && (comparison.probabilityImproved ?? 0) >= adjustedProbabilityThreshold,
    permutationConfidence: !input.requirePermutationTest || (comparison.permutationPValue !== undefined && comparison.permutationPValue <= (1 - adjustedProbabilityThreshold)),
    replication: !input.requireReplication || input.independentReplicationObserved === true,
    subgroupRegression: !input.subgroupDeltas?.length || input.subgroupDeltas.every((delta) => delta >= -input.maximumRegressionShift),
    subgroupAnalysis: !input.requiresSubgroupAnalysis || input.subgroupAnalysisObserved === true,
    leakageAudit: input.leakageAuditPassed,
    review: input.reviewerApproved,
    unexpectedGainReview: !unexpectedGain || (input.independentReplicationObserved === true && input.reviewerApproved),
    evaluationCoverage: input.evaluationCoverage !== false,
    secondaryMetrics: secondaryResults.every((result) => result.passed),
  };
  const worstSubgroupDelta = input.subgroupDeltas?.length ? Math.min(...input.subgroupDeltas) : null;
  const reasons: string[] = [];
  if (!gates.minimumDelta) reasons.push(`normalized delta ${normalizedDelta ?? "missing"} is below required ${input.minimumDelta}`);
  if (!gates.statisticalConfidence) reasons.push(`replicated improvement probability ${(comparison.probabilityImproved ?? 0).toFixed(3)} is below family-wise threshold ${adjustedProbabilityThreshold.toFixed(3)} across ${comparisonCount} comparison(s)`);
  if (!gates.permutationConfidence) reasons.push(`paired sign-permutation p-value ${(comparison.permutationPValue ?? 1).toFixed(4)} exceeds family-wise alpha ${(1 - adjustedProbabilityThreshold).toFixed(4)}`);
  if (!gates.replication) reasons.push("an independently executed child experiment is required");
  if (!gates.subgroupRegression) reasons.push(`worst subgroup delta ${worstSubgroupDelta?.toFixed(6)} exceeds allowed regression ${input.maximumRegressionShift}`);
  if (!gates.subgroupAnalysis) reasons.push("declared secondary splits have no subgroup evidence");
  if (!gates.leakageAudit) reasons.push("leakage audit has not passed");
  if (!gates.review) reasons.push("independent reviewer approval is missing");
  if (!gates.unexpectedGainReview) reasons.push(`unexpectedly large normalized gain ${normalizedDelta?.toFixed(6) ?? "missing"} exceeds scrutiny threshold ${scrutinyThreshold.toFixed(6)}; require independent replication and review`);
  if (!gates.evaluationCoverage) reasons.push("declared fold/seed evaluation matrix is incomplete or missing the primary metric");
  if (!gates.secondaryMetrics) reasons.push(`secondary metric gate failed: ${secondaryResults.filter((result) => !result.passed).map((result) => `${result.name}=${result.normalizedDelta ?? "missing"}`).join(", ")}`);
  return { accepted: Object.values(gates).every(Boolean), comparison, gates, reasons, normalizedDelta, worstSubgroupDelta, adjustedProbabilityThreshold, secondaryAssessments: secondaryResults };
}

/** Compare every required validation environment, preserving split identity. */
export function evaluateMultiSplitValidation(input: {
  runs: SplitRunPair[];
  metric: string;
  direction: "minimize" | "maximize";
  minimumDelta: number;
  secondaryMetrics?: Array<{ name: string; direction: "minimize" | "maximize"; minimumDelta?: number; maximumRegression?: number }>;
}): MultiSplitValidation {
  const lowerIsBetter = input.direction === "minimize";
  const splits = input.runs.map((entry) => {
    const comparison = compareRuns(entry.baseline, entry.candidate, input.metric, lowerIsBetter);
    const normalizedDelta = comparison.delta === null ? null : lowerIsBetter ? -comparison.delta : comparison.delta;
    return { split: entry.split, comparison, normalizedDelta, passed: normalizedDelta !== null && normalizedDelta >= input.minimumDelta };
  });
  const observed = splits.map((entry) => entry.normalizedDelta).filter((delta): delta is number => delta !== null);
  const worstNormalizedDelta = observed.length ? Math.min(...observed) : null;
  const reasons = splits.filter((entry) => !entry.passed).map((entry) => `${entry.split}: normalized delta ${entry.normalizedDelta ?? "missing"} is below required ${input.minimumDelta}`);
  const secondaryMetrics = (input.secondaryMetrics ?? []).map((objective) => {
    const objectiveSplits = input.runs.map((entry) => {
      const comparison = compareRuns(entry.baseline, entry.candidate, objective.name, objective.direction === "minimize");
      const normalizedDelta = comparison.delta === null ? null : objective.direction === "minimize" ? -comparison.delta : comparison.delta;
      const passed = normalizedDelta !== null && normalizedDelta >= (objective.minimumDelta ?? 0) - (objective.maximumRegression ?? 0);
      return { split: entry.split, normalizedDelta, passed };
    });
    return { name: objective.name, splits: objectiveSplits, passed: objectiveSplits.length > 0 && objectiveSplits.every((entry) => entry.passed) };
  });
  for (const objective of secondaryMetrics) {
    if (!objective.passed) reasons.push(`secondary metric '${objective.name}' regressed or is missing on one or more validation splits`);
  }
  return { accepted: splits.length > 0 && reasons.length === 0, splits, worstNormalizedDelta, reasons, secondaryMetrics };
}
