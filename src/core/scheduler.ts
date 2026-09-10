import { PriorityInputSchema, type PriorityInput } from "./types.js";

export interface PriorityBreakdown extends PriorityInput {
  numerator: number;
  denominator: number;
  priority: number;
}

export interface ExperimentCandidate extends PriorityInput {
  id: string;
  title: string;
  mechanism?: string;
}

export interface ReducedPromotionInput {
  candidateMetric: number | undefined;
  baselineMetric: number | undefined;
  direction: "maximize" | "minimize";
  minimumDelta?: number;
  tolerance?: number;
}

export interface ReducedPromotionDecision {
  promote: boolean;
  delta: number | undefined;
  threshold: number;
  reason: string;
}

/** Decide whether a cheap reduced run earns the right to consume full-validation compute. */
export function evaluateReducedPromotion(input: ReducedPromotionInput): ReducedPromotionDecision {
  const threshold = Math.max(0, input.minimumDelta ?? 0) - Math.max(0, input.tolerance ?? 0);
  if (!Number.isFinite(input.candidateMetric)) return { promote: false, delta: undefined, threshold, reason: "reduced validation emitted no finite candidate metric" };
  if (!Number.isFinite(input.baselineMetric)) return { promote: true, delta: undefined, threshold, reason: "no finite baseline metric is available; preserving the candidate for full validation" };
  const delta = input.direction === "maximize" ? input.candidateMetric! - input.baselineMetric! : input.baselineMetric! - input.candidateMetric!;
  const promote = delta >= threshold;
  return { promote, delta, threshold, reason: promote ? `reduced delta ${delta} meets promotion threshold ${threshold}` : `reduced delta ${delta} is below promotion threshold ${threshold}` };
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2));
}

/** Estimate novelty against prior directions using explainable lexical overlap. */
export function experimentNovelty(candidate: Pick<ExperimentCandidate, "title" | "mechanism">, prior: Array<Pick<ExperimentCandidate, "title" | "mechanism">>): number {
  if (!prior.length) return 1;
  const current = tokens(`${candidate.title} ${candidate.mechanism ?? ""}`);
  if (!current.size) return 0;
  let highestSimilarity = 0;
  for (const entry of prior.slice(-100)) {
    const other = tokens(`${entry.title} ${entry.mechanism ?? ""}`);
    const intersection = [...current].filter((token) => other.has(token)).length;
    const union = new Set([...current, ...other]).size;
    highestSimilarity = Math.max(highestSimilarity, union ? intersection / union : 0);
  }
  return Math.max(0, Math.min(1, 1 - highestSimilarity));
}

/** Rank candidates while rewarding information value that is not redundant with prior work. */
export function rankExperimentCandidates<T extends ExperimentCandidate>(candidates: T[], prior: Array<Pick<ExperimentCandidate, "title" | "mechanism">>): Array<T & PriorityBreakdown & { novelty: number }> {
  return candidates.map((candidate) => {
    const novelty = experimentNovelty(candidate, prior);
    const scored = scorePriority({ ...candidate, diversityValue: Math.max(candidate.diversityValue, novelty) });
    return { ...candidate, ...scored, novelty };
  }).sort((left, right) => right.priority - left.priority);
}

/**
 * Cost-aware research priority. The weights are deliberately explicit so the
 * director can explain why one hypothesis was scheduled ahead of another.
 */
export function scorePriority(input: PriorityInput): PriorityBreakdown {
  const value = PriorityInputSchema.parse(input);
  const numerator = value.probabilityOfSuccess * (
    value.expectedDelta + value.informationValue + value.diversityValue
  );
  const denominator = Math.max(0.01, value.gpuCost + value.llmCost + value.engineeringCost + value.risk);
  return { ...value, numerator, denominator, priority: numerator / denominator };
}

export function rankPriorities<T extends PriorityInput>(items: T[]): Array<T & PriorityBreakdown> {
  return items.map((item) => ({ ...item, ...scorePriority(item) })).sort((left, right) => right.priority - left.priority);
}
