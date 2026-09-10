export interface ExternalValidationObservation {
  id: string;
  externalScore: number;
  validationScores: Record<string, number>;
}

export interface SplitBelief {
  split: string;
  observations: number;
  correlation: number | null;
  shrunkCorrelation: number;
  uncertainty: number;
  predictiveScore: number;
}

export interface DistributionBeliefReport {
  observations: number;
  splits: SplitBelief[];
  recommendedSplit: string | null;
  warning: string;
}

function correlation(left: number[], right: number[]): number | null {
  if (left.length < 3 || right.length < 3 || left.length !== right.length) return null;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
  const leftVariance = left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0);
  const rightVariance = right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0);
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator === 0 ? null : numerator / denominator;
}

/** Estimate which local split tracks external performance, conservatively. */
export function estimateDistributionBeliefs(observations: ExternalValidationObservation[]): DistributionBeliefReport {
  const splitNames = [...new Set(observations.flatMap((entry) => Object.keys(entry.validationScores)))].sort();
  const splits = splitNames.map((split) => {
    const pairs = observations.filter((entry) => Number.isFinite(entry.externalScore) && Number.isFinite(entry.validationScores[split]));
    const raw = correlation(pairs.map((entry) => entry.validationScores[split]), pairs.map((entry) => entry.externalScore));
    const shrinkage = pairs.length / (pairs.length + 3);
    const shrunkCorrelation = raw === null ? 0 : raw * shrinkage;
    const uncertainty = 1 / Math.sqrt(Math.max(1, pairs.length));
    return { split, observations: pairs.length, correlation: raw, shrunkCorrelation, uncertainty, predictiveScore: shrunkCorrelation - uncertainty };
  });
  const recommended = splits.filter((entry) => entry.observations >= 3).sort((left, right) => right.predictiveScore - left.predictiveScore)[0];
  return {
    observations: observations.length,
    splits,
    recommendedSplit: recommended?.split ?? null,
    warning: observations.length < 5 ? "Very few external observations; treat split ranking as weak evidence and preserve broad validation." : "Split ranking is advisory and should not replace leakage audits or multi-split evaluation.",
  };
}
