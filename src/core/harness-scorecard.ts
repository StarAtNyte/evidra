export type ScoreDirection = "maximize" | "minimize";

export interface HarnessTrial {
  harness: string;
  task: string;
  direction: ScoreDirection;
  baselineMetric: number;
  candidateMetric?: number;
  validRun: boolean;
  durationSeconds: number;
  recovered: boolean;
  reproducible: boolean;
}

export interface HarnessScorecard {
  harness: string;
  trials: number;
  validRunRate: number;
  improvementRate: number;
  meanDelta: number | null;
  medianTimeToEvidenceSeconds: number | null;
  recoveryRate: number;
  reproducibilityRate: number;
  competitiveScore: number;
}

function delta(trial: HarnessTrial): number | undefined {
  if (!trial.validRun || trial.candidateMetric === undefined || !Number.isFinite(trial.candidateMetric) || !Number.isFinite(trial.baselineMetric)) return undefined;
  return trial.direction === "maximize" ? trial.candidateMetric - trial.baselineMetric : trial.baselineMetric - trial.candidateMetric;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Compare research harnesses under identical task/budget arms. Invalid or
 * unmeasured runs never count as improvements, preventing optimistic scores
 * from agents that produce impressive narratives without durable evidence.
 */
export function scoreHarnessTrials(trials: HarnessTrial[]): HarnessScorecard[] {
  const grouped = new Map<string, HarnessTrial[]>();
  for (const trial of trials) grouped.set(trial.harness, [...(grouped.get(trial.harness) ?? []), trial]);
  return [...grouped.entries()].map(([harness, entries]) => {
    const deltas = entries.map(delta).filter((value): value is number => value !== undefined);
    const improvements = deltas.filter((value) => value > 0).length;
    const reproducible = entries.filter((entry) => entry.validRun && entry.reproducible).length;
    const recovery = entries.filter((entry) => entry.recovered).length;
    const valid = entries.filter((entry) => entry.validRun).length;
    const validRate = valid / entries.length;
    const improvementRate = improvements / entries.length;
    const recoveryRate = recovery / entries.length;
    const reproducibilityRate = reproducible / entries.length;
    // Evidence quality is a first-class part of competitiveness. The score is
    // deliberately bounded and comparable across task metrics.
    const competitiveScore = 100 * (0.45 * improvementRate + 0.25 * validRate + 0.15 * reproducibilityRate + 0.15 * recoveryRate);
    return {
      harness,
      trials: entries.length,
      validRunRate: validRate,
      improvementRate,
      meanDelta: deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : null,
      medianTimeToEvidenceSeconds: median(entries.filter((entry) => entry.validRun && Number.isFinite(entry.durationSeconds)).map((entry) => entry.durationSeconds)),
      recoveryRate,
      reproducibilityRate,
      competitiveScore,
    };
  }).sort((a, b) => b.competitiveScore - a.competitiveScore);
}
