import { classifyTechnique } from "./scout.js";
import type { UnitScore, UnitScoreTable } from "./unit-scores.js";

/**
 * Loss localization for the research director. Given per-unit evaluator
 * scores for one or more runs, it answers: where is the loss, how much of it
 * could plausibly be recovered, and which concrete hypotheses follow. The
 * "gap table" (score recoverable per segment) follows kernel-autoresearch's
 * floor-and-gap method; the routing estimate is cross-fitted so in-sample
 * selection noise is not reported as headroom.
 */
export interface LossRun {
  id: string;
  label?: string;
  table: UnitScoreTable;
}

export interface SegmentLoss {
  column: string;
  value: string;
  units: number;
  unitShare: number;
  meanScore: number;
  /** Oriented loss share: sum of (global mean - segment unit) / total; positive drags the aggregate down. */
  excessShare: number;
  /** Aggregate gain if this segment reached the global mean score (oriented). */
  recoverableToMean: number;
  /** Aggregate gain if this segment reached the best run's mean on it (multi-run only). */
  recoverableToBestRun?: number;
  bestRunId?: string;
}

export interface RoutingHeadroom {
  column: string;
  /** In-sample gain of picking the best run per segment value (optimistic). */
  inSampleGain: number;
  /** Two-fold cross-fitted gain: choose on one half, score on the other. */
  crossFittedGain: number;
  choices: Record<string, string>;
}

export interface LossHypothesis {
  title: string;
  formulationFamily: string;
  techniqueClass: string;
  mechanism: string;
  evidence: string[];
  /** Expected aggregate gain in unit-score units (oriented, positive is better). */
  expectedGain: number;
  /** Cheapest check that would falsify it (kernel-autoresearch's bound_test). */
  boundTest: string;
  /** True when it changes the method's structure rather than a parameter. */
  structural: boolean;
}

export interface LossAnalysisReport {
  schemaVersion: 1;
  primaryRunId: string;
  direction: "maximize" | "minimize";
  units: number;
  meanScore: number;
  /** Standard error of the primary mean; aggregate changes well below ~2x this are noise. */
  standardError: number;
  /** Share of oriented loss carried by the worst 10% of units (only when loss is non-negative). */
  worstDecileLossShare?: number;
  segments: SegmentLoss[];
  /** Top segments ranked by recoverable score: the gap table. */
  gapTable: SegmentLoss[];
  runs: Array<{ id: string; label?: string; units: number; meanScore: number; matchedWithPrimary: number; pairedImprovement?: number; pairedStandardError?: number }>;
  oracle?: { perUnitBestOfRuns: number; bestSingleRun: number; gain: number };
  routing: RoutingHeadroom[];
  /** Cross-fitted shrink-toward-fallback headroom (needs unit mixture inputs). */
  calibration: CalibrationHeadroom[];
  hypotheses: LossHypothesis[];
  notes: string[];
}

export interface LossAnalysisOptions {
  direction: "maximize" | "minimize";
  /** Numeric segment columns with more distinct values than this are bucketed into quantiles. */
  maxCategories?: number;
  buckets?: number;
  topSegments?: number;
  /** Minimum units for a segment to be reported. */
  minSegmentUnits?: number;
  /** Segment column that defines cross-fitting folds (e.g. respondent), so correlated units stay in one fold. */
  foldBy?: string;
}

export interface CalibrationHeadroom {
  /** Segment column the shrinkage weight is chosen per ("__all__" for one global weight). */
  column: string;
  /** Aggregate gain from mixing toward the fallback with the weight chosen on the other fold. */
  crossFittedGain: number;
  inSampleGain: number;
  weights: Record<string, number>;
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN;
}

function standardError(values: readonly number[]): number {
  if (values.length < 2) return Number.NaN;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance / values.length);
}

const SHRINK_GRID = [0, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5];

function mixedScore(mix: { logp: number; fallback: number; scale: number }, weight: number): number {
  if (weight === 0) return mix.logp / mix.scale;
  const a = Math.log(1 - weight) + mix.logp;
  const b = Math.log(weight) + mix.fallback;
  const high = Math.max(a, b);
  return (high + Math.log(Math.exp(a - high) + Math.exp(b - high))) / mix.scale;
}

/** Cross-fitted per-segment shrinkage toward a fallback predictor (posthoc calibration as a headroom estimate). */
function calibrationHeadroom(units: readonly UnitScore[], split: Map<string, (unit: UnitScore) => string>, foldOf: (unit: UnitScore) => 0 | 1, sign: number): CalibrationHeadroom[] {
  const mixed = units.filter((unit) => unit.mix);
  if (mixed.length < 20 || sign < 0) return [];
  const columns: Array<[string, (unit: UnitScore) => string]> = [["__all__", () => "all"], ...split];
  const result: CalibrationHeadroom[] = [];
  for (const [column, keyOf] of columns) {
    // totals[fold][segment][w] = sum of mixed scores; base = w=0
    const totals: [Map<string, number[]>, Map<string, number[]>] = [new Map(), new Map()];
    for (const unit of mixed) {
      const key = keyOf(unit);
      const bucket = totals[foldOf(unit)];
      const row = bucket.get(key) ?? SHRINK_GRID.map(() => 0);
      SHRINK_GRID.forEach((weight, index) => { row[index] += mixedScore(unit.mix!, weight); });
      bucket.set(key, row);
    }
    const best = (row: number[]): number => row.reduce((bestIndex, value, index) => (value > row[bestIndex] ? index : bestIndex), 0);
    let inSample = 0; let cross = 0; const weights: Record<string, number> = {};
    const keys = new Set([...totals[0].keys(), ...totals[1].keys()]);
    for (const key of keys) {
      const left = totals[0].get(key); const right = totals[1].get(key);
      const combined = SHRINK_GRID.map((_, index) => (left?.[index] ?? 0) + (right?.[index] ?? 0));
      const chosen = best(combined);
      weights[key] = SHRINK_GRID[chosen];
      inSample += combined[chosen] - combined[0];
      if (left && right) cross += (right[best(left)] - right[0]) + (left[best(right)] - left[0]);
    }
    result.push({ column, crossFittedGain: cross / mixed.length, inSampleGain: inSample / mixed.length, weights: Object.fromEntries(Object.entries(weights).slice(0, 40)) });
  }
  return result.sort((left, right) => right.crossFittedGain - left.crossFittedGain);
}

/** Stable 2-fold split by unit id so cross-fitting is reproducible. */
function fold(unit: string): 0 | 1 {
  let hash = 2166136261;
  for (let index = 0; index < unit.length; index += 1) { hash ^= unit.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0) % 2 === 0 ? 0 : 1;
}

function segmenters(units: readonly UnitScore[], columns: readonly string[], maxCategories: number, buckets: number): Map<string, (unit: UnitScore) => string> {
  const result = new Map<string, (unit: UnitScore) => string>();
  for (const column of columns) {
    const values = units.map((unit) => unit.segments[column]);
    const distinct = new Set(values.map(String));
    const numeric = values.every((value) => typeof value === "number");
    if (numeric && distinct.size > maxCategories) {
      const sorted = (values as number[]).slice().sort((left, right) => left - right);
      const edges = Array.from({ length: buckets - 1 }, (_, index) => sorted[Math.floor(((index + 1) / buckets) * (sorted.length - 1))]);
      const uniqueEdges = [...new Set(edges)];
      result.set(column, (unit) => {
        const value = unit.segments[column] as number;
        const index = uniqueEdges.findIndex((edge) => value <= edge);
        const position = index === -1 ? uniqueEdges.length : index;
        const low = position === 0 ? sorted[0] : uniqueEdges[position - 1];
        const high = position === uniqueEdges.length ? sorted[sorted.length - 1] : uniqueEdges[position];
        return `q${position + 1}[${Number(low.toPrecision(4))}..${Number(high.toPrecision(4))}]`;
      });
    } else if (distinct.size > 1 && distinct.size <= Math.max(maxCategories, 200)) {
      result.set(column, (unit) => String(unit.segments[column]));
    }
  }
  return result;
}

/** Decompose loss and estimate headroom. runs[0] is the primary run (usually the champion). */
export function analyzeUnitLoss(runs: readonly LossRun[], options: LossAnalysisOptions): LossAnalysisReport {
  if (!runs.length) throw new Error("analyzeUnitLoss needs at least one run");
  const sign = options.direction === "maximize" ? 1 : -1;
  const maxCategories = Math.max(2, options.maxCategories ?? 24);
  const buckets = Math.max(2, Math.min(20, options.buckets ?? 5));
  const topSegments = Math.max(1, options.topSegments ?? 12);
  const primary = runs[0];
  const units = primary.table.units;
  const foldOf = (unit: UnitScore): 0 | 1 => fold(options.foldBy ? String(unit.segments[options.foldBy] ?? unit.unit) : unit.unit);
  const scores = units.map((unit) => unit.score);
  const meanScore = mean(scores);
  const notes: string[] = [];
  const minSegmentUnits = Math.max(1, options.minSegmentUnits ?? Math.max(5, Math.floor(units.length * 0.002)));
  const byRun = runs.map((run) => new Map(run.table.units.map((unit) => [unit.unit, unit.score])));
  const shared = units.filter((unit) => byRun.every((map) => map.has(unit.unit)));
  if (runs.length > 1 && shared.length < units.length) notes.push(`${units.length - shared.length} primary units are missing from at least one comparison run; multi-run estimates use the ${shared.length} shared units.`);

  // Oriented loss = distance below the global mean; total excess equals 0 by construction, so report positive drag.
  const split = segmenters(units, primary.table.segmentColumns, maxCategories, buckets);
  const segments: SegmentLoss[] = [];
  const totalAbsoluteDeviation = units.reduce((sum, unit) => sum + Math.abs(unit.score - meanScore), 0) || 1;
  for (const [column, keyOf] of split) {
    const groups = new Map<string, UnitScore[]>();
    for (const unit of units) { const key = keyOf(unit); const bucket = groups.get(key); if (bucket) bucket.push(unit); else groups.set(key, [unit]); }
    for (const [value, members] of groups) {
      if (members.length < minSegmentUnits) continue;
      const segmentMean = mean(members.map((unit) => unit.score));
      const drag = sign * (meanScore - segmentMean) * members.length;
      const entry: SegmentLoss = {
        column,
        value,
        units: members.length,
        unitShare: members.length / units.length,
        meanScore: segmentMean,
        excessShare: drag / totalAbsoluteDeviation,
        recoverableToMean: Math.max(0, drag / units.length),
      };
      if (runs.length > 1) {
        const sharedMembers = members.filter((unit) => byRun.every((map) => map.has(unit.unit)));
        if (sharedMembers.length >= minSegmentUnits) {
          const runMeans = byRun.map((map) => mean(sharedMembers.map((unit) => map.get(unit.unit)!)));
          let bestIndex = 0;
          runMeans.forEach((value, index) => { if (sign * (value - runMeans[bestIndex]) > 0) bestIndex = index; });
          entry.recoverableToBestRun = Math.max(0, sign * (runMeans[bestIndex] - runMeans[0]) * sharedMembers.length / units.length);
          entry.bestRunId = runs[bestIndex].id;
        }
      }
      segments.push(entry);
    }
  }
  const gapTable = [...segments].sort((left, right) => Math.max(right.recoverableToMean, right.recoverableToBestRun ?? 0) - Math.max(left.recoverableToMean, left.recoverableToBestRun ?? 0)).slice(0, topSegments);

  let worstDecileLossShare: number | undefined;
  const losses = scores.map((score) => -sign * score);
  if (losses.every((loss) => loss >= 0) && losses.some((loss) => loss > 0)) {
    const sorted = [...losses].sort((left, right) => right - left);
    const total = sorted.reduce((sum, loss) => sum + loss, 0);
    worstDecileLossShare = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 10))).reduce((sum, loss) => sum + loss, 0) / total;
  }

  const runSummaries = runs.map((run, index) => {
    const map = byRun[index];
    const matched = units.filter((unit) => map.has(unit.unit));
    const differences = matched.map((unit) => sign * (map.get(unit.unit)! - unit.score));
    return {
      id: run.id,
      ...(run.label ? { label: run.label } : {}),
      units: run.table.units.length,
      meanScore: mean(run.table.units.map((unit) => unit.score)),
      matchedWithPrimary: matched.length,
      ...(index > 0 && matched.length > 1 ? { pairedImprovement: mean(differences), pairedStandardError: standardError(differences) } : {}),
    };
  });

  let oracle: LossAnalysisReport["oracle"];
  const routing: RoutingHeadroom[] = [];
  if (runs.length > 1 && shared.length) {
    const runMeans = byRun.map((map) => mean(shared.map((unit) => map.get(unit.unit)!)));
    const bestSingle = runMeans.reduce((best, value) => (sign * (value - best) > 0 ? value : best));
    const perUnitBest = mean(shared.map((unit) => byRun.reduce((best, map) => { const value = map.get(unit.unit)!; return sign * (value - best) > 0 ? value : best; }, byRun[0].get(unit.unit)!)));
    oracle = { perUnitBestOfRuns: perUnitBest, bestSingleRun: bestSingle, gain: sign * (perUnitBest - bestSingle) };
    for (const [column, keyOf] of split) {
      const inSample = new Map<string, number[]>();
      const perFold: [Map<string, number[]>, Map<string, number[]>] = [new Map(), new Map()];
      const counts: [Map<string, number>, Map<string, number>] = [new Map(), new Map()];
      for (const unit of shared) {
        const key = keyOf(unit);
        const f = foldOf(unit);
        const totals = inSample.get(key) ?? byRun.map(() => 0);
        const foldTotals = perFold[f].get(key) ?? byRun.map(() => 0);
        byRun.forEach((map, index) => { const value = map.get(unit.unit)!; totals[index] += value; foldTotals[index] += value; });
        inSample.set(key, totals);
        perFold[f].set(key, foldTotals);
        counts[f].set(key, (counts[f].get(key) ?? 0) + 1);
      }
      const argBest = (totals: number[]): number => totals.reduce((best, value, index) => (sign * (value - totals[best]) > 0 ? index : best), 0);
      const choices: Record<string, string> = {};
      let inSampleTotal = 0;
      for (const [key, totals] of inSample) { const index = argBest(totals); choices[key] = runs[index].id; inSampleTotal += totals[index]; }
      const inSampleGain = sign * (inSampleTotal / shared.length - bestSingle);
      // Cross-fit: choices from fold a, scored on fold b; fall back to the best single run for unseen segments.
      const bestSingleIndex = runMeans.indexOf(bestSingle);
      let crossTotal = 0;
      for (const [train, test] of [[0, 1], [1, 0]] as const) {
        for (const [key, totals] of perFold[test]) {
          const trainTotals = perFold[train].get(key);
          const index = trainTotals ? argBest(trainTotals) : bestSingleIndex;
          crossTotal += totals[index];
        }
      }
      routing.push({ column, inSampleGain, crossFittedGain: sign * (crossTotal / shared.length - bestSingle), choices: Object.fromEntries(Object.entries(choices).slice(0, 40)) });
    }
    routing.sort((left, right) => right.crossFittedGain - left.crossFittedGain);
  }

  const se = standardError(scores);
  const calibration = calibrationHeadroom(units, split, foldOf, sign);
  const hypotheses = lossHypotheses({ gapTable, routing, oracle, worstDecileLossShare, runs: runSummaries, standardError: se, segments, calibration });
  if (calibration.length && calibration[0].crossFittedGain <= Math.max(0, se * 0.1)) notes.push(`Cross-fitted shrinkage toward the fallback gains at most ${format(Math.max(0, calibration[0].crossFittedGain))} (in-sample ${format(Math.max(...calibration.map((entry) => entry.inSampleGain)))}): the model is not over-confident; post-hoc calibration is not where the loss is.`);
  if (runSummaries.slice(1).length && runSummaries.slice(1).every((run) => run.pairedImprovement !== undefined && run.pairedStandardError !== undefined && Math.abs(run.pairedImprovement) < 2 * run.pairedStandardError)) {
    notes.push("Every comparison run is within 2 paired standard errors of the primary: recent changes are indistinguishable from noise. Change structure (a different technique class), not knobs.");
  }
  return { schemaVersion: 1, primaryRunId: primary.id, direction: options.direction, units: units.length, meanScore, standardError: se, ...(worstDecileLossShare !== undefined ? { worstDecileLossShare } : {}), segments: segments.slice(0, 400), gapTable, runs: runSummaries, ...(oracle ? { oracle } : {}), routing: routing.slice(0, 12), calibration, hypotheses, notes };
}

function hypothesis(input: Omit<LossHypothesis, "techniqueClass">): LossHypothesis {
  return { ...input, techniqueClass: classifyTechnique({ family: input.formulationFamily, title: input.title, mechanism: input.mechanism }) };
}

function format(value: number): string {
  return Number(value.toPrecision(3)).toString();
}

/** Turn the measured decomposition into concrete, falsifiable hypotheses for the director. */
function lossHypotheses(input: { gapTable: SegmentLoss[]; routing: RoutingHeadroom[]; oracle?: LossAnalysisReport["oracle"]; worstDecileLossShare?: number; runs: LossAnalysisReport["runs"]; standardError: number; segments: SegmentLoss[]; calibration: CalibrationHeadroom[] }): LossHypothesis[] {
  const result: LossHypothesis[] = [];
  const noise = Number.isFinite(input.standardError) ? input.standardError : 0;
  const worst = input.gapTable[0];
  if (worst && worst.recoverableToMean > 0) {
    result.push(hypothesis({
      title: `Targeted model for ${worst.column}=${worst.value}`,
      formulationFamily: "segment specialist / reweighting (data-centric)",
      mechanism: `${worst.column}=${worst.value} holds ${(worst.unitShare * 100).toFixed(1)}% of units but drags the aggregate by ${format(worst.recoverableToMean)}; a specialist (separate fit, reweighting, or extra features for this segment) can recover part of it without touching the rest.`,
      evidence: [`segment mean ${format(worst.meanScore)} vs gap-table rank 1, recoverable-to-mean ${format(worst.recoverableToMean)}`],
      expectedGain: worst.recoverableToMean * 0.3,
      boundTest: `Fit the specialist on training folds only and compare ${worst.column}=${worst.value} unit scores against the champion on held-out units; no paired gain there means no aggregate gain.`,
      structural: true,
    }));
  }
  const route = input.routing[0];
  if (route && route.crossFittedGain > Math.max(noise, 0)) {
    result.push(hypothesis({
      title: `Learned routing by ${route.column}`,
      formulationFamily: "learned routing / per-segment model selection",
      mechanism: `Picking the best existing run per ${route.column} value gains ${format(route.crossFittedGain)} cross-fitted (${format(route.inSampleGain)} in-sample). Train a router (or a fixed cross-fitted lookup) that chooses among the current candidates per segment.`,
      evidence: [`cross-fitted routing gain ${format(route.crossFittedGain)} vs primary SE ${format(noise)}`, `choices: ${Object.entries(route.choices).slice(0, 6).map(([key, run]) => `${key}->${run}`).join(", ")}`],
      expectedGain: route.crossFittedGain,
      boundTest: "Select the per-segment model on half of the training folds and score the other half; if the cross-fitted gain vanishes the routing is noise.",
      structural: true,
    }));
  }
  if (input.oracle && input.oracle.gain > Math.max(2 * noise, (route?.crossFittedGain ?? 0) * 1.5)) {
    result.push(hypothesis({
      title: "Cross-fitted stacking of complementary runs",
      formulationFamily: "stacking / learned blend",
      mechanism: `The per-unit oracle over existing runs beats the best single run by ${format(input.oracle.gain)}, much more than segment routing recovers, so the runs err on different units. A stacker using unit-level features (confidence, entropy, disagreement) can capture part of that complementarity.`,
      evidence: [`oracle ${format(input.oracle.perUnitBestOfRuns)} vs best single ${format(input.oracle.bestSingleRun)}`],
      expectedGain: input.oracle.gain * 0.25,
      boundTest: "Fit blend weights on out-of-fold predictions only; if out-of-fold blending does not beat the best single run, drop it.",
      structural: true,
    }));
  }
  const measuredCalibration = input.calibration[0];
  if (measuredCalibration && measuredCalibration.crossFittedGain > Math.max(0, noise * 0.1)) {
    result.push(hypothesis({
      title: `Cross-fitted shrinkage toward the fallback per ${measuredCalibration.column}`,
      formulationFamily: "segment-wise calibration (proper scoring)",
      mechanism: `Mixing predictions toward the fallback predictor with a weight chosen per ${measuredCalibration.column} on one fold and applied to the other gains ${format(measuredCalibration.crossFittedGain)} (in-sample ${format(measuredCalibration.inSampleGain)}).`,
      evidence: [`weights: ${Object.entries(measuredCalibration.weights).slice(0, 6).map(([key, weight]) => `${key}:${weight}`).join(", ")}`],
      expectedGain: measuredCalibration.crossFittedGain,
      boundTest: "Fit the weights on training folds only inside the submission and score held-out respondents.",
      structural: false,
    }));
  }
  const heterogeneous = input.calibration.length ? undefined : [...input.segments].filter((segment) => segment.units > 0).sort((left, right) => Math.abs(right.excessShare) - Math.abs(left.excessShare))[0];
  if (heterogeneous && Math.abs(heterogeneous.excessShare) > 0.05) {
    result.push(hypothesis({
      title: `Cross-fitted calibration per ${heterogeneous.column}`,
      formulationFamily: "segment-wise calibration (proper scoring)",
      mechanism: `Loss is strongly heterogeneous across ${heterogeneous.column} (one value carries ${(heterogeneous.excessShare * 100).toFixed(1)}% of the deviation). A per-segment temperature / isotonic map fitted out-of-fold often fixes systematic over- or under-confidence that a single global calibration misses.`,
      evidence: [`${heterogeneous.column}=${heterogeneous.value} mean ${format(heterogeneous.meanScore)}`],
      expectedGain: Math.max(0, heterogeneous.recoverableToMean * 0.2),
      boundTest: "Fit the calibration map on training folds and apply it to held-out units; reject if held-out log score does not improve.",
      structural: false,
    }));
    result.push(hypothesis({
      title: `Per-${heterogeneous.column} hyperparameter selection`,
      formulationFamily: "per-segment hyperparameter tuning",
      mechanism: `Segments of ${heterogeneous.column} differ a lot in difficulty, so a single global setting (regularization, temperature, neighbours, mixture weights) is a compromise. Select the setting per segment with nested cross-validation.`,
      evidence: [`heterogeneity in ${heterogeneous.column}`],
      expectedGain: Math.max(0, heterogeneous.recoverableToMean * 0.1),
      boundTest: "Nested CV: choose per-segment settings on inner folds, report outer-fold gain; reject if within noise.",
      structural: false,
    }));
  }
  if (input.worstDecileLossShare !== undefined && input.worstDecileLossShare > 0.3) {
    result.push(hypothesis({
      title: "Hard-example focus for the worst decile",
      formulationFamily: "hard-example reweighting (data-centric)",
      mechanism: `The worst 10% of units carry ${(input.worstDecileLossShare * 100).toFixed(0)}% of the loss. Inspect them (label noise, rare classes, out-of-distribution inputs) and handle them explicitly: robust loss, abstention toward the prior, or a dedicated model.`,
      evidence: [`worst-decile loss share ${format(input.worstDecileLossShare)}`],
      expectedGain: 0,
      boundTest: "Shrink worst-decile predictions toward the marginal prior on held-out folds; if loss does not drop, the hard units are not over-confident errors.",
      structural: true,
    }));
  }
  return result;
}

/** Compact, token-bounded view for the director's context. */
export function lossAnalysisBrief(report: LossAnalysisReport): Record<string, unknown> {
  return {
    primaryRunId: report.primaryRunId,
    units: report.units,
    meanScore: report.meanScore,
    noiseFloor: { standardError: report.standardError, minimumDetectableAggregateChange: 2 * report.standardError },
    ...(report.worstDecileLossShare !== undefined ? { worstDecileLossShare: report.worstDecileLossShare } : {}),
    gapTable: report.gapTable.slice(0, 8).map((segment) => ({ segment: `${segment.column}=${segment.value}`, unitShare: segment.unitShare, meanScore: segment.meanScore, recoverableToMean: segment.recoverableToMean, ...(segment.recoverableToBestRun !== undefined ? { recoverableToBestRun: segment.recoverableToBestRun, bestRunId: segment.bestRunId } : {}) })),
    runs: report.runs,
    ...(report.oracle ? { oracle: { ...report.oracle, note: "optimistic upper bound: per-unit best-of-runs also picks up per-unit noise" } } : {}),
    routing: report.routing.slice(0, 4).map((entry) => ({ column: entry.column, crossFittedGain: entry.crossFittedGain, inSampleGain: entry.inSampleGain })),
    calibration: report.calibration.slice(0, 4).map((entry) => ({ per: entry.column, crossFittedGain: entry.crossFittedGain, inSampleGain: entry.inSampleGain })),
    dataHypotheses: report.hypotheses,
    notes: report.notes,
  };
}

/** Render the report as markdown for humans (`evidra analyze loss`). */
export function renderLossAnalysis(report: LossAnalysisReport): string {
  const lines = [
    `# Loss analysis: ${report.primaryRunId}`,
    "",
    `${report.units} units, mean score ${format(report.meanScore)} (${report.direction}), SE ${format(report.standardError)}; aggregate changes below ~${format(2 * report.standardError)} are noise.${report.worstDecileLossShare !== undefined ? ` Worst decile carries ${(report.worstDecileLossShare * 100).toFixed(0)}% of the loss.` : ""}`,
    "",
    "## Gap table (score recoverable per segment)",
    "",
    "| segment | units | share | mean | to mean | to best run |",
    "|---|---|---|---|---|---|",
    ...report.gapTable.map((segment) => `| ${segment.column}=${segment.value} | ${segment.units} | ${(segment.unitShare * 100).toFixed(1)}% | ${format(segment.meanScore)} | ${format(segment.recoverableToMean)} | ${segment.recoverableToBestRun !== undefined ? `${format(segment.recoverableToBestRun)} (${segment.bestRunId})` : "-"} |`),
    "",
  ];
  if (report.runs.length > 1) {
    lines.push("## Runs", "", "| run | units | mean | paired vs primary | SE |", "|---|---|---|---|---|",
      ...report.runs.map((run) => `| ${run.id} | ${run.units} | ${format(run.meanScore)} | ${run.pairedImprovement !== undefined ? format(run.pairedImprovement) : "-"} | ${run.pairedStandardError !== undefined ? format(run.pairedStandardError) : "-"} |`), "");
  }
  if (report.oracle) lines.push(`Per-unit oracle over runs: ${format(report.oracle.perUnitBestOfRuns)} vs best single ${format(report.oracle.bestSingleRun)} (gain ${format(report.oracle.gain)}).`, "");
  if (report.calibration.length) lines.push("## Calibration headroom (cross-fitted shrink toward fallback)", "", "| per | cross-fitted gain | in-sample gain |", "|---|---|---|", ...report.calibration.slice(0, 8).map((entry) => `| ${entry.column} | ${format(entry.crossFittedGain)} | ${format(entry.inSampleGain)} |`), "");
  if (report.routing.length) lines.push("## Routing headroom", "", "| column | cross-fitted gain | in-sample gain |", "|---|---|---|", ...report.routing.slice(0, 8).map((entry) => `| ${entry.column} | ${format(entry.crossFittedGain)} | ${format(entry.inSampleGain)} |`), "");
  if (report.hypotheses.length) lines.push("## Hypotheses from the data", "", ...report.hypotheses.flatMap((entry) => [`- **${entry.title}** (${entry.techniqueClass}, expected +${format(entry.expectedGain)}${entry.structural ? ", structural" : ""}): ${entry.mechanism}`, `  - bound test: ${entry.boundTest}`]), "");
  if (report.notes.length) lines.push("## Notes", "", ...report.notes.map((note) => `- ${note}`), "");
  return lines.join("\n");
}
