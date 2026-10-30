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
  eventsByType(type: string): Array<{ payload: unknown; createdAt?: string }>;
}

/** Events of one type, limited to a campaign when its start time is given. */
function eventsSince(store: EventSource, type: string, since?: string): Array<{ payload: unknown; createdAt?: string }> {
  const events = store.eventsByType(type);
  if (!since) return events;
  const start = Date.parse(since);
  return events.filter((event) => !event.createdAt || Date.parse(event.createdAt) >= start);
}

/** Experiments that became the search champion, oldest first; `since` scopes them to a campaign. */
export function championExperimentIds(store: EventSource, since?: string): string[] {
  return eventsSince(store, "experiment.champion.updated", since).flatMap((event) => {
    const experimentId = (event.payload as { experimentId?: unknown } | undefined)?.experimentId;
    return typeof experimentId === "string" ? [experimentId] : [];
  });
}

/**
 * The implementation a new experiment should start from: the latest champion's
 * recorded source snapshot. Experiments then compound improvements instead of
 * restarting from the original commit.
 */
export function championImplementation(store: EventSource, since?: string): { experimentId: string; worktree: string; files: string[] } | undefined {
  const experimentId = championExperimentIds(store, since).at(-1);
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
  since?: string,
  limit = 30,
): { champion: { experimentId: string; idea: string; metric: number | null } | null; recent: ExperimentLogEntry[] } {
  const championIds = championExperimentIds(store, since);
  const champions = new Set(championIds);
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
  const championId = championIds.at(-1);
  const champion = entries.find((entry) => entry.experimentId === championId);
  return {
    champion: champion ? { experimentId: champion.experimentId, idea: champion.idea, metric: champion.metric } : null,
    recent: entries.slice(-limit),
  };
}

/**
 * The holdout score a new champion must not regress: the current champion's,
 * or the original solution's when no champion has been kept. Holdout scores
 * are recorded only as experiment.holdout.completed events and are never
 * shown to the research agents, so they cannot be optimized directly.
 */
export function holdoutReference(store: EventSource, since?: string): number | undefined {
  const kept = eventsSince(store, "experiment.holdout.completed", since)
    .map((event) => event.payload as { metric?: unknown; kept?: unknown } | undefined)
    .filter((payload) => payload?.kept === true && typeof payload.metric === "number" && Number.isFinite(payload.metric));
  return kept.at(-1)?.metric as number | undefined;
}

export function holdoutAllows(candidate: number | undefined, reference: number | undefined, direction: "maximize" | "minimize"): boolean {
  if (candidate === undefined || !Number.isFinite(candidate)) return false;
  if (reference === undefined) return true;
  return direction === "minimize" ? candidate <= reference : candidate >= reference;
}

/** Events research agents may see: everything except hidden holdout scores. */
export function isAgentVisibleEvent(event: { type: string }): boolean {
  return event.type !== "experiment.holdout.completed";
}
