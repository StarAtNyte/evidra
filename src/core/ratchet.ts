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

interface EventSource {
  eventsByType(type: string): Array<{ payload: unknown }>;
}

/** Experiments that became the search champion, oldest first. */
export function championExperimentIds(store: EventSource): string[] {
  return store.eventsByType("experiment.champion.updated").flatMap((event) => {
    const experimentId = (event.payload as { experimentId?: unknown } | undefined)?.experimentId;
    return typeof experimentId === "string" ? [experimentId] : [];
  });
}

/**
 * The implementation a new experiment should start from: the latest champion's
 * recorded source snapshot. Experiments then compound improvements instead of
 * restarting from the original commit.
 */
export function championImplementation(store: EventSource): { experimentId: string; worktree: string; files: string[] } | undefined {
  const experimentId = championExperimentIds(store).at(-1);
  if (!experimentId) return undefined;
  const snapshot = store.eventsByType("experiment.implementation.completed").reverse()
    .map((event) => event.payload as { experimentId?: unknown; worktree?: unknown; files?: unknown } | undefined)
    .find((payload) => payload?.experimentId === experimentId);
  if (!snapshot || typeof snapshot.worktree !== "string" || !snapshot.files || typeof snapshot.files !== "object") return undefined;
  return { experimentId, worktree: snapshot.worktree, files: Object.keys(snapshot.files as Record<string, unknown>) };
}

export interface ExperimentLogEntry {
  experimentId: string;
  idea: string;
  family: string;
  status: string;
  metric: number | null;
  kept: boolean;
}

/**
 * A compact results log in the spirit of autoresearch's results.tsv: every
 * attempt, its family, its score, and whether it became the champion.
 */
export function experimentLog(
  store: EventSource & {
    experiments(): Array<{ id: string; payload: unknown }>;
    runs(): Array<{ id: string; payload: unknown }>;
    hypotheses(): Array<{ id: string; payload: unknown }>;
  },
  metricName: string,
  limit = 30,
): { champion: { experimentId: string; idea: string; metric: number | null } | null; recent: ExperimentLogEntry[] } {
  const champions = new Set(championExperimentIds(store));
  const runs = new Map(store.runs().map((run) => [run.id, run.payload as { metrics?: Record<string, unknown> }]));
  const hypotheses = new Map(store.hypotheses().map((entry) => [entry.id, entry.payload as { title?: unknown; formulationFamily?: unknown }]));
  const entries = store.experiments().map((entry): ExperimentLogEntry => {
    const payload = entry.payload as { hypothesisId?: unknown; status?: unknown; runId?: unknown };
    const hypothesis = typeof payload.hypothesisId === "string" ? hypotheses.get(payload.hypothesisId) : undefined;
    const value = typeof payload.runId === "string" ? runs.get(payload.runId)?.metrics?.[metricName] : undefined;
    return {
      experimentId: entry.id,
      idea: typeof hypothesis?.title === "string" ? hypothesis.title : "unknown",
      family: typeof hypothesis?.formulationFamily === "string" ? hypothesis.formulationFamily : "other",
      status: typeof payload.status === "string" ? payload.status : "unknown",
      metric: typeof value === "number" && Number.isFinite(value) ? value : null,
      kept: champions.has(entry.id),
    };
  });
  const championId = championExperimentIds(store).at(-1);
  const champion = entries.find((entry) => entry.experimentId === championId);
  return {
    champion: champion ? { experimentId: champion.experimentId, idea: champion.idea, metric: champion.metric } : null,
    recent: entries.slice(-limit),
  };
}
