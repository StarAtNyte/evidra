export interface PromotionObservation {
  experimentId: string;
  reducedDelta: number;
  fullDelta: number;
}

export interface LearnedPromotionPolicy {
  minimumDelta: number;
  samples: number;
  successfulSamples: number;
  learned: boolean;
  rationale: string;
}

/** Extract paired reduced/full outcomes from the durable event stream. */
export function promotionObservations(events: Array<{ type: string; payload: unknown }>, direction: "maximize" | "minimize"): PromotionObservation[] {
  const reduced = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "experiment.stage.reduced_validation.promoted") continue;
    const payload = object(event.payload);
    const experimentId = typeof payload.experimentId === "string" ? payload.experimentId : undefined;
    const delta = number(payload.delta);
    if (experimentId && delta !== undefined) reduced.set(experimentId, delta);
  }
  const paired: PromotionObservation[] = [];
  for (const event of events) {
    if (event.type !== "experiment.comparison.completed") continue;
    const payload = object(event.payload);
    const experimentId = typeof payload.experimentId === "string" ? payload.experimentId : undefined;
    const comparison = object(payload.comparison);
    const rawDelta = number(comparison.delta);
    const reducedDelta = experimentId ? reduced.get(experimentId) : undefined;
    if (experimentId && reducedDelta !== undefined && rawDelta !== undefined) paired.push({ experimentId, reducedDelta, fullDelta: direction === "minimize" ? -rawDelta : rawDelta });
  }
  return paired;
}

/**
 * Learn a conservative reduced-validation gate from paired outcomes.
 * Insufficient or one-sided evidence always falls back to the manifest rule.
 */
export function learnPromotionPolicy(observations: PromotionObservation[], fallbackMinimumDelta: number, options: { minSamples?: number; targetFullDelta?: number } = {}): LearnedPromotionPolicy {
  const minSamples = Math.max(3, options.minSamples ?? 8);
  const target = options.targetFullDelta ?? 0;
  const valid = observations.filter((observation) => Number.isFinite(observation.reducedDelta) && Number.isFinite(observation.fullDelta));
  const successful = valid.filter((observation) => observation.fullDelta >= target);
  if (valid.length < minSamples || successful.length < 2) {
    return { minimumDelta: fallbackMinimumDelta, samples: valid.length, successfulSamples: successful.length, learned: false, rationale: `need at least ${minSamples} paired outcomes and two successful full evaluations` };
  }
  const sorted = successful.map((observation) => observation.reducedDelta).sort((left, right) => left - right);
  const lowerQuartile = sorted[Math.floor((sorted.length - 1) * 0.25)] ?? fallbackMinimumDelta;
  const minimumDelta = Math.max(fallbackMinimumDelta, lowerQuartile);
  return { minimumDelta, samples: valid.length, successfulSamples: successful.length, learned: true, rationale: `learned from the lower quartile of ${successful.length} successful reduced/full pairs` };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
