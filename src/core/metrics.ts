export type MetricDirection = "minimize" | "maximize";

export interface MetricDefinition {
  readonly name: string;
  readonly direction: MetricDirection;
  readonly description: string;
  compute(target: readonly unknown[], prediction: readonly unknown[]): number;
}

function paired(target: readonly unknown[], prediction: readonly unknown[]): Array<[unknown, unknown]> {
  if (target.length !== prediction.length || target.length === 0) throw new Error("Metric inputs must be non-empty and have equal length.");
  return target.map((value, index) => [value, prediction[index]]);
}

function numberPairs(target: readonly unknown[], prediction: readonly unknown[]): Array<[number, number]> {
  return paired(target, prediction).map(([actual, predicted]) => {
    const a = Number(actual); const p = Number(predicted);
    if (!Number.isFinite(a) || !Number.isFinite(p)) throw new Error("Regression metrics require finite numeric values.");
    return [a, p];
  });
}

function accuracy(target: readonly unknown[], prediction: readonly unknown[]): number {
  const pairs = paired(target, prediction);
  return pairs.filter(([actual, predicted]) => actual === predicted || String(actual) === String(predicted)).length / pairs.length;
}

function f1(target: readonly unknown[], prediction: readonly unknown[], average: "macro" | "micro"): number {
  const pairs = paired(target, prediction);
  const labels = [...new Set(pairs.flatMap(([actual, predicted]) => [String(actual), String(predicted)]))];
  let truePositive = 0; let falsePositive = 0; let falseNegative = 0;
  const scores = labels.map((label) => {
    let tp = 0; let fp = 0; let fn = 0;
    for (const [actual, predicted] of pairs) {
      const a = String(actual) === label; const p = String(predicted) === label;
      if (a && p) tp += 1;
      else if (!a && p) fp += 1;
      else if (a && !p) fn += 1;
    }
    truePositive += tp; falsePositive += fp; falseNegative += fn;
    const denominator = 2 * tp + fp + fn;
    return denominator ? (2 * tp) / denominator : 0;
  });
  if (average === "macro") return scores.reduce((sum, value) => sum + value, 0) / scores.length;
  const denominator = 2 * truePositive + falsePositive + falseNegative;
  return denominator ? (2 * truePositive) / denominator : 0;
}

function rmse(target: readonly unknown[], prediction: readonly unknown[]): number {
  const pairs = numberPairs(target, prediction);
  return Math.sqrt(pairs.reduce((sum, [actual, predicted]) => sum + (actual - predicted) ** 2, 0) / pairs.length);
}

function mae(target: readonly unknown[], prediction: readonly unknown[]): number {
  const pairs = numberPairs(target, prediction);
  return pairs.reduce((sum, [actual, predicted]) => sum + Math.abs(actual - predicted), 0) / pairs.length;
}

function logLoss(target: readonly unknown[], prediction: readonly unknown[]): number {
  const pairs = numberPairs(target, prediction);
  const epsilon = 1e-15;
  return -pairs.reduce((sum, [actual, predicted]) => {
    const probability = Math.min(1 - epsilon, Math.max(epsilon, predicted));
    return sum + (actual === 1 ? Math.log(probability) : Math.log(1 - probability));
  }, 0) / pairs.length;
}

function auroc(target: readonly unknown[], prediction: readonly unknown[]): number {
  const pairs = numberPairs(target, prediction);
  const positives = pairs.filter(([actual]) => actual === 1).length;
  const negatives = pairs.length - positives;
  if (!positives || !negatives) throw new Error("AUROC requires both positive and negative examples.");
  const ordered = pairs.map(([actual, score], index) => ({ actual, score, index })).sort((left, right) => left.score - right.score || left.index - right.index);
  let rank = 1; let positiveRankSum = 0;
  // AUROC is the probability that a random positive outranks a random
  // negative. Tied scores receive their average rank; assigning arrival
  // order would make the metric depend on input ordering.
  for (let index = 0; index < ordered.length;) {
    let end = index + 1;
    while (end < ordered.length && ordered[end].score === ordered[index].score) end += 1;
    const averageRank = (rank + (rank + end - index - 1)) / 2;
    for (let tie = index; tie < end; tie += 1) if (ordered[tie].actual === 1) positiveRankSum += averageRank;
    rank += end - index;
    index = end;
  }
  return (positiveRankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/** Binary average precision for one ranked list (the single-query MAP case). */
function averagePrecision(target: readonly unknown[], prediction: readonly unknown[]): number {
  const pairs = numberPairs(target, prediction);
  const positives = pairs.filter(([actual]) => actual > 0).length;
  if (!positives) throw new Error("Average precision requires at least one positive example.");
  const ordered = pairs
    .map(([actual, score], index) => ({ actual, score, index }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  let seenRelevant = 0;
  let precisionSum = 0;
  for (const [index, item] of ordered.entries()) {
    if (item.actual <= 0) continue;
    seenRelevant += 1;
    precisionSum += seenRelevant / (index + 1);
  }
  return precisionSum / positives;
}

/** NDCG for one ranked list, using predictions as ranking scores. */
function ndcg(target: readonly unknown[], prediction: readonly unknown[]): number {
  const pairs = numberPairs(target, prediction);
  const ordered = pairs
    .map(([relevance, score], index) => ({ relevance: Math.max(0, relevance), score, index }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const gain = (relevance: number, position: number): number => (2 ** relevance - 1) / Math.log2(position + 2);
  const dcg = ordered.reduce((sum, item, index) => sum + gain(item.relevance, index), 0);
  const ideal = pairs
    .map(([relevance]) => Math.max(0, relevance))
    .sort((left, right) => right - left)
    .reduce((sum, relevance, index) => sum + gain(relevance, index), 0);
  return ideal ? dcg / ideal : 0;
}

/** Quadratic weighted kappa for ordinal integer labels. */
function quadraticWeightedKappa(target: readonly unknown[], prediction: readonly unknown[]): number {
  const pairs = paired(target, prediction).map(([actual, predicted]) => [Number(actual), Number(predicted)] as [number, number]);
  if (pairs.some(([actual, predicted]) => !Number.isInteger(actual) || !Number.isInteger(predicted))) throw new Error("Quadratic weighted kappa requires integer ordinal labels.");
  const labels = [...new Set(pairs.flatMap(([actual, predicted]) => [actual, predicted]))].sort((left, right) => left - right);
  if (labels.length < 2) return 1;
  const index = new Map(labels.map((label, position) => [label, position]));
  const observed = labels.map(() => labels.map(() => 0));
  const actualTotals = labels.map(() => 0);
  const predictedTotals = labels.map(() => 0);
  for (const [actual, predicted] of pairs) {
    const a = index.get(actual)!; const p = index.get(predicted)!;
    observed[a][p] += 1; actualTotals[a] += 1; predictedTotals[p] += 1;
  }
  const denominator = pairs.length;
  let observedLoss = 0; let expectedLoss = 0;
  for (let actual = 0; actual < labels.length; actual += 1) {
    for (let predicted = 0; predicted < labels.length; predicted += 1) {
      const weight = ((actual - predicted) / (labels.length - 1)) ** 2;
      observedLoss += weight * observed[actual][predicted] / denominator;
      expectedLoss += weight * actualTotals[actual] * predictedTotals[predicted] / (denominator ** 2);
    }
  }
  return expectedLoss === 0 ? (observedLoss === 0 ? 1 : 0) : 1 - observedLoss / expectedLoss;
}

function binaryOverlap(target: readonly unknown[], prediction: readonly unknown[], mode: "iou" | "dice"): number {
  const pairs = paired(target, prediction);
  let intersection = 0; let targetPositive = 0; let predictionPositive = 0;
  for (const [actual, predicted] of pairs) {
    const a = Number(actual) >= 0.5; const p = Number(predicted) >= 0.5;
    if (a) targetPositive += 1;
    if (p) predictionPositive += 1;
    if (a && p) intersection += 1;
  }
  const denominator = mode === "iou" ? targetPositive + predictionPositive - intersection : targetPositive + predictionPositive;
  return denominator === 0 ? 1 : (mode === "iou" ? intersection : 2 * intersection) / denominator;
}

function rank(values: number[]): number[] {
  return values.map((value) => 1 + values.filter((other) => other < value).length + (values.filter((other) => other === value).length - 1) / 2);
}

function spearman(target: readonly unknown[], prediction: readonly unknown[]): number {
  const pairs = numberPairs(target, prediction);
  const actual = rank(pairs.map(([value]) => value));
  const predicted = rank(pairs.map(([, value]) => value));
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const actualMean = mean(actual); const predictedMean = mean(predicted);
  const numerator = actual.reduce((sum, value, index) => sum + (value - actualMean) * (predicted[index] - predictedMean), 0);
  const denominator = Math.sqrt(actual.reduce((sum, value) => sum + (value - actualMean) ** 2, 0) * predicted.reduce((sum, value) => sum + (value - predictedMean) ** 2, 0));
  return denominator ? numerator / denominator : 0;
}

export const METRIC_REGISTRY: readonly MetricDefinition[] = [
  { name: "accuracy", direction: "maximize", description: "Exact classification accuracy.", compute: accuracy },
  { name: "macro_f1", direction: "maximize", description: "Unweighted mean F1 across labels.", compute: (target, prediction) => f1(target, prediction, "macro") },
  { name: "micro_f1", direction: "maximize", description: "Global F1 across labels.", compute: (target, prediction) => f1(target, prediction, "micro") },
  { name: "rmse", direction: "minimize", description: "Root mean squared error.", compute: rmse },
  { name: "mae", direction: "minimize", description: "Mean absolute error.", compute: mae },
  { name: "log_loss", direction: "minimize", description: "Binary logarithmic loss for probabilities.", compute: logLoss },
  { name: "auroc", direction: "maximize", description: "Binary area under the ROC curve.", compute: auroc },
  { name: "average_precision", direction: "maximize", description: "Area under the precision-recall curve for one ranked list.", compute: averagePrecision },
  { name: "ndcg", direction: "maximize", description: "Normalized discounted cumulative gain for one ranked list.", compute: ndcg },
  { name: "quadratic_weighted_kappa", direction: "maximize", description: "Agreement on ordinal labels with quadratic disagreement weights.", compute: quadraticWeightedKappa },
  { name: "iou", direction: "maximize", description: "Binary intersection over union.", compute: (target, prediction) => binaryOverlap(target, prediction, "iou") },
  { name: "dice", direction: "maximize", description: "Binary Dice overlap coefficient.", compute: (target, prediction) => binaryOverlap(target, prediction, "dice") },
  { name: "spearman", direction: "maximize", description: "Spearman rank correlation.", compute: spearman },
];

const aliases = new Map([
  ["f1_macro", "macro_f1"], ["f1_micro", "micro_f1"], ["roc_auc", "auroc"], ["mse", "rmse"],
  ["ap", "average_precision"], ["map", "average_precision"], ["qwk", "quadratic_weighted_kappa"],
  ["intersection_over_union", "iou"], ["f1_overlap", "dice"],
]);

export function metricDefinition(name: string): MetricDefinition {
  const canonical = aliases.get(name.toLowerCase()) ?? name.toLowerCase();
  const definition = METRIC_REGISTRY.find((metric) => metric.name === canonical);
  if (!definition) throw new Error(`No built-in metric '${name}' is registered; use the workspace evaluator for custom metrics.`);
  return definition;
}

export function computeMetric(name: string, target: readonly unknown[], prediction: readonly unknown[]): number {
  const value = metricDefinition(name).compute(target, prediction);
  if (!Number.isFinite(value)) throw new Error(`Metric '${name}' produced a non-finite result.`);
  return value;
}
