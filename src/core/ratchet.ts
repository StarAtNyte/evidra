export interface RatchetObservation {
  id: string;
  metric: number;
  accepted: boolean;
}

export interface RatchetReference {
  sourceId: string;
  metric: number;
  acceptedCount: number;
}

/** Select the best previously accepted metric without weakening the baseline. */
export function selectRatchetReference(
  baseline: { id: string; metric: number },
  observations: RatchetObservation[],
  direction: "maximize" | "minimize",
): RatchetReference {
  const accepted = observations.filter((observation) => observation.accepted && Number.isFinite(observation.metric));
  const candidates = [{ id: baseline.id, metric: baseline.metric }, ...accepted.map((observation) => ({ id: observation.id, metric: observation.metric }))];
  const best = candidates.reduce((current, candidate) => {
    const preferred = direction === "maximize" ? candidate.metric > current.metric : candidate.metric < current.metric;
    return preferred ? candidate : current;
  });
  return { sourceId: best.id, metric: best.metric, acceptedCount: accepted.length };
}
