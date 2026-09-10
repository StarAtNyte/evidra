/**
 * Evidence-safe early stopping for workers that emit JSON progress records.
 *
 * A worker is stopped only when its observed learning curve is persistently
 * behind a comparable historical curve. A single noisy point can never stop
 * a run, and a policy without a reference curve is inert.
 */

export interface LearningPoint {
  step: number;
  metric: number;
}

export interface EarlyStoppingConfig {
  enabled: boolean;
  metric: string;
  direction: "maximize" | "minimize";
  warmupSteps: number;
  patience: number;
  minimumImprovement: number;
}

export interface EarlyStoppingDecision {
  stop: boolean;
  reason: string;
  observed?: LearningPoint;
  expectedMetric?: number;
  gap?: number;
  underperformingPoints: number;
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function expectedAt(reference: LearningPoint[], step: number): number | undefined {
  const ordered = reference.filter((point) => Number.isFinite(point.step) && Number.isFinite(point.metric)).sort((left, right) => left.step - right.step);
  if (!ordered.length) return undefined;
  const before = ordered.filter((point) => point.step <= step).at(-1);
  return (before ?? ordered[0]).metric;
}

export function assessEarlyStopping(
  observed: LearningPoint[],
  reference: LearningPoint[],
  config: EarlyStoppingConfig,
): EarlyStoppingDecision {
  const points = observed.filter((point) => Number.isFinite(point.step) && Number.isFinite(point.metric)).sort((left, right) => left.step - right.step);
  const latest = points.at(-1);
  if (!config.enabled || !latest || reference.length === 0) return { stop: false, reason: "early stopping is inactive until a reference curve and progress point are available", observed: latest, underperformingPoints: 0 };
  if (latest.step < Math.max(0, config.warmupSteps)) return { stop: false, reason: "warmup window is not complete", observed: latest, underperformingPoints: 0 };
  const expectedMetric = expectedAt(reference, latest.step);
  if (expectedMetric === undefined) return { stop: false, reason: "reference curve has no usable metric", observed: latest, underperformingPoints: 0 };
  const gap = config.direction === "maximize" ? latest.metric - expectedMetric : expectedMetric - latest.metric;
  const underperforming = config.direction === "maximize"
    ? latest.metric + Math.max(0, config.minimumImprovement) < expectedMetric
    : latest.metric - Math.max(0, config.minimumImprovement) > expectedMetric;
  let underperformingPoints = 0;
  for (const point of points.slice().reverse()) {
    const expected = expectedAt(reference, point.step);
    if (expected === undefined) break;
    const behind = config.direction === "maximize"
      ? point.metric + Math.max(0, config.minimumImprovement) < expected
      : point.metric - Math.max(0, config.minimumImprovement) > expected;
    if (!behind) break;
    underperformingPoints += 1;
  }
  const patience = Math.max(1, Math.floor(finitePositive(config.patience, 3)));
  return {
    stop: underperformingPoints >= patience,
    reason: underperformingPoints >= patience
      ? `observed ${config.metric} is behind the reference curve for ${underperformingPoints} consecutive points`
      : `observed ${config.metric} remains within the reference tolerance (${gap.toFixed(6)} signed gap)`,
    observed: latest,
    expectedMetric,
    gap,
    underperformingPoints,
  };
}

function progressPoint(line: string, metricName: string): LearningPoint | undefined {
  let value: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
  } catch { /* allow human-readable progress lines below */ }
  const nested = value?.progress && typeof value.progress === "object" && !Array.isArray(value.progress) ? value.progress as Record<string, unknown> : value;
  const stepValue = nested?.step ?? nested?.iteration ?? nested?.epoch;
  const metricValue = nested?.[metricName] ?? (nested?.metrics && typeof nested.metrics === "object" && !Array.isArray(nested.metrics) ? (nested.metrics as Record<string, unknown>)[metricName] : undefined);
  const step = typeof stepValue === "number" ? stepValue : Number(typeof stepValue === "string" ? stepValue : NaN);
  const metric = typeof metricValue === "number" ? metricValue : Number(typeof metricValue === "string" ? metricValue : NaN);
  if (Number.isFinite(step) && Number.isFinite(metric)) return { step, metric };
  const stepMatch = line.match(/(?:step|iteration|epoch)\s*[:=]\s*(\d+(?:\.\d+)?)/i);
  const metricMatch = line.match(new RegExp(`${metricName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`, "i"));
  if (!stepMatch || !metricMatch) return undefined;
  return { step: Number(stepMatch[1]), metric: Number(metricMatch[1]) };
}

export class EarlyStoppingMonitor {
  private readonly observed: LearningPoint[] = [];
  private remainder = "";
  private lastStep: number | undefined;

  constructor(private readonly config: EarlyStoppingConfig, private readonly reference: LearningPoint[]) {}

  observe(chunk: string): EarlyStoppingDecision {
    this.remainder += chunk;
    const lines = this.remainder.split("\n");
    this.remainder = lines.pop() ?? "";
    for (const line of lines) {
      const point = progressPoint(line.trim(), this.config.metric);
      if (!point || point.step === this.lastStep) continue;
      this.lastStep = point.step;
      this.observed.push(point);
    }
    return assessEarlyStopping(this.observed, this.reference, this.config);
  }
}
