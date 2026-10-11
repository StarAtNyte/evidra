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

export const MAX_PROGRESS_LINE_CHARS = 64 * 1024;

function orderedReference(reference: LearningPoint[]): LearningPoint[] {
  return reference.filter((point) => Number.isFinite(point.step) && Number.isFinite(point.metric))
    .map((point) => ({ ...point })).sort((left, right) => left.step - right.step);
}

function expectedAt(ordered: LearningPoint[], step: number): number | undefined {
  if (!ordered.length) return undefined;
  let low = 0;
  let high = ordered.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ordered[middle].step <= step) low = middle + 1;
    else high = middle;
  }
  return ordered[Math.max(0, low - 1)].metric;
}

function behindReference(point: LearningPoint, expected: number, config: EarlyStoppingConfig): boolean {
  return config.direction === "maximize"
    ? point.metric + Math.max(0, config.minimumImprovement) < expected
    : point.metric - Math.max(0, config.minimumImprovement) > expected;
}

function stoppingDecision(latest: LearningPoint | undefined, reference: LearningPoint[], config: EarlyStoppingConfig, count: number): EarlyStoppingDecision {
  if (!config.enabled || !latest || !reference.length) return { stop: false, reason: "early stopping is inactive until a reference curve and progress point are available", observed: latest, underperformingPoints: 0 };
  if (latest.step < Math.max(0, config.warmupSteps)) return { stop: false, reason: "warmup window is not complete", observed: latest, underperformingPoints: 0 };
  const expectedMetric = expectedAt(reference, latest.step)!;
  const gap = config.direction === "maximize" ? latest.metric - expectedMetric : expectedMetric - latest.metric;
  const patience = Math.max(1, Math.floor(finitePositive(config.patience, 3)));
  return {
    stop: count >= patience,
    reason: count >= patience
      ? `observed ${config.metric} is behind the reference curve for ${count} consecutive points`
      : count > 0
      ? `observed ${config.metric} is behind the reference curve for ${count} consecutive points; ${patience} are required`
      : behindReference(latest, expectedMetric, config)
      ? "awaiting fresh ordered progress after ambiguous telemetry"
      : `observed ${config.metric} remains within the reference tolerance (${gap.toFixed(6)} signed gap)`,
    observed: latest, expectedMetric, gap, underperformingPoints: count,
  };
}

export function assessEarlyStopping(observed: LearningPoint[], reference: LearningPoint[], config: EarlyStoppingConfig): EarlyStoppingDecision {
  // A repeated step is one observation, not extra patience evidence.
  const unique = new Map<number, LearningPoint>();
  for (const point of observed) if (Number.isFinite(point.step) && Number.isFinite(point.metric)) unique.set(point.step, point);
  const points = [...unique.values()].sort((left, right) => left.step - right.step);
  const ordered = orderedReference(reference);
  let count = 0;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const expected = expectedAt(ordered, points[index].step);
    if (expected === undefined || !behindReference(points[index], expected, config)) break;
    count += 1;
  }
  return stoppingDecision(points.at(-1), ordered, config, count);
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
  const step = typeof stepValue === "number" ? stepValue : Number(typeof stepValue === "string" && stepValue.trim() ? stepValue : NaN);
  const metric = typeof metricValue === "number" ? metricValue : Number(typeof metricValue === "string" && metricValue.trim() ? metricValue : NaN);
  if (Number.isFinite(step) && Number.isFinite(metric)) return { step, metric };
  const stepMatch = line.match(/(?:step|iteration|epoch)\s*[:=]\s*(\d+(?:\.\d+)?)/i);
  const metricMatch = line.match(new RegExp(`${metricName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`, "i"));
  if (!stepMatch || !metricMatch) return undefined;
  const textStep = Number(stepMatch[1]);
  const textMetric = Number(metricMatch[1]);
  return Number.isFinite(textStep) && Number.isFinite(textMetric) ? { step: textStep, metric: textMetric } : undefined;
}

/** Extract a deterministic learning curve from a worker's captured output. */
export function parseLearningCurve(output: string, metricName: string): LearningPoint[] {
  const points = new Map<number, LearningPoint>();
  for (const line of output.split("\n")) {
    if (line.length > MAX_PROGRESS_LINE_CHARS) continue;
    const point = progressPoint(line.trim(), metricName);
    if (point) points.set(point.step, point);
  }
  return [...points.values()].sort((left, right) => left.step - right.step);
}

/**
 * Build a conservative reference curve from comparable historical curves.
 * Exact step matches are intentional: interpolation could manufacture a
 * stopping signal for a schedule that was never actually observed.
 */
export function deriveReferenceCurve(curves: LearningPoint[][], minimumCurves = 2): LearningPoint[] {
  const required = Math.max(2, Math.floor(minimumCurves));
  const byStep = new Map<number, number[]>();
  for (const curve of curves) {
    const seen = new Set<number>();
    for (const point of curve) {
      if (seen.has(point.step) || !Number.isFinite(point.step) || !Number.isFinite(point.metric)) continue;
      seen.add(point.step);
      byStep.set(point.step, [...(byStep.get(point.step) ?? []), point.metric]);
    }
  }
  return [...byStep.entries()]
    .filter(([, metrics]) => metrics.length >= required)
    .sort(([left], [right]) => left - right)
    .map(([step, metrics]) => {
      const sorted = [...metrics].sort((left, right) => left - right);
      return { step, metric: sorted[Math.floor((sorted.length - 1) / 2)] };
    });
}

export class EarlyStoppingMonitor {
  private remainder = "";
  private discardingLine = false;
  private latest: LearningPoint | undefined;
  private underperformingPoints = 0;
  private readonly config: EarlyStoppingConfig;
  private readonly reference: LearningPoint[];

  constructor(config: EarlyStoppingConfig, reference: LearningPoint[]) {
    this.config = { ...config };
    this.reference = orderedReference(reference);
  }

  private accept(line: string): void {
    const point = progressPoint(line.trim(), this.config.metric);
    if (!point) return;
    if (this.latest && point.step <= this.latest.step) {
      if (point.step === this.latest.step && point.metric === this.latest.metric) return;
      // A late record or correction makes the preceding streak ambiguous.
      // Rebuild patience from fresh increasing steps rather than replaying an
      // unbounded history or counting repeated old records as new evidence.
      this.underperformingPoints = 0;
      if (point.step < this.latest.step) return;
    }
    this.latest = point;
    const expected = expectedAt(this.reference, point.step);
    this.underperformingPoints = expected !== undefined && behindReference(point, expected, this.config)
      ? Math.min(Number.MAX_SAFE_INTEGER, this.underperformingPoints + 1) : 0;
  }

  observe(chunk: string): EarlyStoppingDecision {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf("\n", offset);
      const end = newline < 0 ? chunk.length : newline;
      if (!this.discardingLine) {
        if (end - offset > MAX_PROGRESS_LINE_CHARS - this.remainder.length) {
          // Discard the entire record, including its later suffix. Parsing a
          // clipped suffix could manufacture a metric from arbitrary output.
          this.remainder = "";
          this.discardingLine = true;
          this.underperformingPoints = 0;
        } else this.remainder += chunk.slice(offset, end);
      }
      if (newline < 0) break;
      if (!this.discardingLine) this.accept(this.remainder);
      this.remainder = "";
      this.discardingLine = false;
      offset = newline + 1;
    }
    return stoppingDecision(this.latest, this.reference, this.config, this.underperformingPoints);
  }
}
