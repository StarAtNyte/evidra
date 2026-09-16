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
  confidenceInterval: [number, number];
  predictiveScore: number;
}

export interface DistributionBeliefReport {
  observations: number;
  splits: SplitBelief[];
  recommendedSplit: string | null;
  warning: string;
}

/** Convert durable submission payloads into safe, finite external observations. */
export function distributionObservationsFromSubmissions(entries: Array<{ id?: string; payload: unknown }>): ExternalValidationObservation[] {
  return entries.flatMap((entry, index) => {
    const payload = entry.payload && typeof entry.payload === "object" ? entry.payload as { publicScore?: unknown; validationScores?: unknown } : {};
    if (typeof payload.publicScore !== "number" || !Number.isFinite(payload.publicScore) || !payload.validationScores || typeof payload.validationScores !== "object" || Array.isArray(payload.validationScores)) return [];
    const validationScores = Object.fromEntries(Object.entries(payload.validationScores).filter(([, value]) => typeof value === "number" && Number.isFinite(value)) as Array<[string, number]>);
    if (!Object.keys(validationScores).length) return [];
    return [{ id: entry.id ?? `submission-${index}`, externalScore: payload.publicScore, validationScores }];
  });
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

function correlationInterval(value: number | null, observations: number): [number, number] {
  if (value === null || observations < 4) return [-1, 1];
  // Fisher's z interval is substantially more conservative than 1/sqrt(n)
  // near +/-1 and avoids treating a tiny leaderboard sample as certainty.
  const bounded = Math.max(-0.999999, Math.min(0.999999, value));
  const z = 0.5 * Math.log((1 + bounded) / (1 - bounded));
  const standardError = 1 / Math.sqrt(Math.max(1, observations - 3));
  const lowerZ = z - 1.96 * standardError;
  const upperZ = z + 1.96 * standardError;
  const fromZ = (score: number): number => Math.max(-1, Math.min(1, (Math.exp(2 * score) - 1) / (Math.exp(2 * score) + 1)));
  return [fromZ(lowerZ), fromZ(upperZ)];
}

/** Estimate which local split tracks external performance, conservatively. */
export function estimateDistributionBeliefs(observations: ExternalValidationObservation[]): DistributionBeliefReport {
  const splitNames = [...new Set(observations.flatMap((entry) => Object.keys(entry.validationScores)))].sort();
  const splits = splitNames.map((split) => {
    const pairs = observations.filter((entry) => Number.isFinite(entry.externalScore) && Number.isFinite(entry.validationScores[split]));
    const raw = correlation(pairs.map((entry) => entry.validationScores[split]), pairs.map((entry) => entry.externalScore));
    const shrinkage = pairs.length / (pairs.length + 3);
    const shrunkCorrelation = raw === null ? 0 : raw * shrinkage;
    const confidenceInterval = correlationInterval(raw, pairs.length);
    const uncertainty = (confidenceInterval[1] - confidenceInterval[0]) / 2;
    return { split, observations: pairs.length, correlation: raw, shrunkCorrelation, uncertainty, confidenceInterval, predictiveScore: shrunkCorrelation - uncertainty };
  });
  const recommended = splits.filter((entry) => entry.observations >= 3).sort((left, right) => right.predictiveScore - left.predictiveScore)[0];
  return {
    observations: observations.length,
    splits,
    recommendedSplit: recommended?.split ?? null,
    warning: observations.length < 5 ? "Very few external observations; treat split ranking as weak evidence and preserve broad validation." : "Split ranking is advisory and should not replace leakage audits or multi-split evaluation.",
  };
}
