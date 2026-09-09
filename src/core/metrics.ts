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
  for (const item of ordered) { if (item.actual === 1) positiveRankSum += rank; rank += 1; }
  return (positiveRankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
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
  { name: "spearman", direction: "maximize", description: "Spearman rank correlation.", compute: spearman },
];

const aliases = new Map([["f1_macro", "macro_f1"], ["f1_micro", "micro_f1"], ["roc_auc", "auroc"], ["mse", "rmse"]]);

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
