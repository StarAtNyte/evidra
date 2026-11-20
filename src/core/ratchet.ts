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

/** The recorded source snapshot of an experiment, used to seed later attempts from it. */
export function implementationOf(store: EventSource, experimentId: string): { experimentId: string; worktree: string; files: string[] } | undefined {
  const snapshot = store.eventsByType("experiment.implementation.completed").reverse()
    .map((event) => event.payload as { experimentId?: unknown; worktree?: unknown; files?: unknown } | undefined)
    .find((payload) => payload?.experimentId === experimentId);
  if (!snapshot || typeof snapshot.worktree !== "string" || !snapshot.files || typeof snapshot.files !== "object") return undefined;
  return { experimentId, worktree: snapshot.worktree, files: Object.keys(snapshot.files as Record<string, unknown>) };
}

/** The latest champion's implementation. */
export function championImplementation(store: EventSource, since?: string): { experimentId: string; worktree: string; files: string[] } | undefined {
  const experimentId = championExperimentIds(store, since).at(-1);
  return experimentId ? implementationOf(store, experimentId) : undefined;
}

export interface ExperimentLogEntry {
  experimentId: string;
  idea: string;
  family: string;
  status: string;
  metric: number | null;
  kept: boolean;
}

/** Method family names are free text from the director; compare them case- and space-insensitively. */
export function normalizeFamily(name: unknown): string {
  return typeof name === "string" && name.trim() ? name.trim().toLowerCase().replace(/\s+/g, " ") : "unspecified";
}

type SearchStore = EventSource & {
  experiments(): Array<{ id: string; payload: unknown; createdAt?: string }>;
  runs(): Array<{ id: string; payload: unknown }>;
  hypotheses(): Array<{ id: string; payload: unknown }>;
};

/** Every attempt in the campaign, oldest first. */
function campaignAttempts(store: SearchStore, metricName: string, since?: string): ExperimentLogEntry[] {
  const champions = new Set(championExperimentIds(store, since));
  const runs = new Map(store.runs().map((run) => [run.id, run.payload as { metrics?: Record<string, unknown> }]));
  const hypotheses = new Map(store.hypotheses().map((entry) => [entry.id, entry.payload as { title?: unknown; formulationFamily?: unknown }]));
  const start = since ? Date.parse(since) : undefined;
  return store.experiments()
    .filter((entry) => start === undefined || !entry.createdAt || Date.parse(entry.createdAt) >= start)
    .sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? ""))
    .map((entry): ExperimentLogEntry => {
      const payload = entry.payload as { hypothesisId?: unknown; status?: unknown; runId?: unknown };
      const hypothesis = typeof payload.hypothesisId === "string" ? hypotheses.get(payload.hypothesisId) : undefined;
      const value = typeof payload.runId === "string" ? runs.get(payload.runId)?.metrics?.[metricName] : undefined;
      return {
        experimentId: entry.id,
        idea: typeof hypothesis?.title === "string" ? hypothesis.title : "unknown",
        family: normalizeFamily(hypothesis?.formulationFamily),
        status: typeof payload.status === "string" ? payload.status : "unknown",
        metric: typeof value === "number" && Number.isFinite(value) ? value : null,
        kept: champions.has(entry.id),
      };
    });
}

/**
 * A compact results log in the spirit of autoresearch's results.tsv: every
 * attempt, its family, its score, and whether it became the champion.
 */
export function experimentLog(store: SearchStore, metricName: string, since?: string, limit = 30): { champion: { experimentId: string; idea: string; metric: number | null } | null; recent: ExperimentLogEntry[] } {
  const entries = campaignAttempts(store, metricName, since);
  const championId = championExperimentIds(store, since).at(-1);
  const champion = entries.find((entry) => entry.experimentId === championId);
  return {
    champion: champion ? { experimentId: champion.experimentId, idea: champion.idea, metric: champion.metric } : null,
    recent: entries.slice(-limit),
  };
}

/** A family is young until it has had this many attempts to improve on its own best. */
export const YOUNG_FAMILY_ATTEMPTS = 3;
/** One experiment in this many goes to a new or young family. */
export const EXPLORATION_PERIOD = 3;

export interface FamilySummary {
  family: string;
  attempts: number;
  best: { experimentId: string; idea: string; metric: number } | null;
  attemptsSinceImprovement: number;
  young: boolean;
}

/**
 * The per-family archive. Each family keeps its own best, so a new architecture
 * is refined from its own best attempt instead of being judged at once against
 * a champion that has had many rounds of tuning.
 */
export function familySummaries(entries: readonly ExperimentLogEntry[], direction: "maximize" | "minimize"): FamilySummary[] {
  const families = new Map<string, FamilySummary>();
  for (const entry of entries) {
    if (entry.status !== "completed" && entry.status !== "failed") continue;
    const summary = families.get(entry.family) ?? { family: entry.family, attempts: 0, best: null, attemptsSinceImprovement: 0, young: true };
    summary.attempts += 1;
    const improves = entry.metric !== null && (!summary.best || (direction === "minimize" ? entry.metric < summary.best.metric : entry.metric > summary.best.metric));
    if (improves && entry.metric !== null) {
      summary.best = { experimentId: entry.experimentId, idea: entry.idea, metric: entry.metric };
      summary.attemptsSinceImprovement = 0;
    } else {
      summary.attemptsSinceImprovement += 1;
    }
    summary.young = summary.attempts < YOUNG_FAMILY_ATTEMPTS;
    families.set(entry.family, summary);
  }
  return [...families.values()];
}

/** True when the last EXPLORATION_PERIOD - 1 attempts all went to mature families. */
export function isExplorationTurn(entries: readonly ExperimentLogEntry[]): boolean {
  const attempts = entries.filter((entry) => entry.status === "completed" || entry.status === "failed");
  const window = EXPLORATION_PERIOD - 1;
  if (attempts.length < window) return false;
  const seen = new Map<string, number>();
  const matureAtAttempt = attempts.map((entry) => {
    const prior = seen.get(entry.family) ?? 0;
    seen.set(entry.family, prior + 1);
    return prior >= YOUNG_FAMILY_ATTEMPTS;
  });
  return matureAtAttempt.slice(-window).every(Boolean);
}

/** On an exploration turn, prefer a hypothesis from a new or young family. */
export function explorationHypothesis<T extends { title: string; formulationFamily?: string }>(hypotheses: readonly T[], families: readonly FamilySummary[]): T | undefined {
  const known = new Map(families.map((summary) => [summary.family, summary]));
  return hypotheses.find((hypothesis) => known.get(normalizeFamily(hypothesis.formulationFamily))?.young ?? true);
}

/** The experiment a new attempt should build on: its family's best, else the champion. */
export function parentExperimentId(store: SearchStore, metricName: string, direction: "maximize" | "minimize", family: string, since?: string): string | undefined {
  const best = familySummaries(campaignAttempts(store, metricName, since), direction).find((summary) => summary.family === normalizeFamily(family))?.best;
  return best?.experimentId ?? championExperimentIds(store, since).at(-1);
}

/** The director's view of the search: champion, families, recent attempts, and whether this is an exploration turn. */
export function searchState(store: SearchStore, metricName: string, direction: "maximize" | "minimize", since?: string): { champion: ReturnType<typeof experimentLog>["champion"]; families: FamilySummary[]; explorationTurn: boolean; experimentLog: ExperimentLogEntry[] } {
  const entries = campaignAttempts(store, metricName, since);
  const log = experimentLog(store, metricName, since);
  return { champion: log.champion, families: familySummaries(entries, direction), explorationTurn: isExplorationTurn(entries), experimentLog: log.recent };
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

/** How the ratchet decides whether a completed run becomes the champion. */
export interface RatchetPolicy {
  /** auto: paired bootstrap when both runs have unit scores, else the scalar comparison. */
  mode: "auto" | "scalar" | "paired";
  confidence: number;
  /** Accept only when the CI lower bound on mean per-unit improvement exceeds this. */
  minLowerBound: number;
  iterations: number;
  /** Below this many matched units the paired test is not trusted; fall back (auto) or reject (paired). */
  minUnits: number;
  clusterBy?: string;
  trim: number;
  /** Segment column (for example dataset) for per-stratum gates. */
  segmentColumn?: string;
  /** Segments whose own paired CI lower bound must also clear minLowerBound (the deciding splits). */
  requireSegments?: string[];
  /** Segments that must not show a CI-significant loss (upper bound < 0); unevaluated guards are reported, not blocking. */
  guardSegments?: string[];
}

export interface SegmentEvidence {
  segment: string;
  role: "require" | "guard";
  paired?: import("./unit-scores.js").PairedBootstrapResult;
  passed: boolean | null;
  note: string;
}

export const DEFAULT_RATCHET_POLICY: RatchetPolicy = { mode: "auto", confidence: 0.95, minLowerBound: 0, iterations: 2000, minUnits: 30, trim: 0 };

export function resolveRatchetPolicy(config: Partial<RatchetPolicy> | undefined): RatchetPolicy {
  return { ...DEFAULT_RATCHET_POLICY, ...Object.fromEntries(Object.entries(config ?? {}).filter(([, value]) => value !== undefined)) } as RatchetPolicy;
}

/**
 * Verdicts follow the kernel-autoresearch convention: KEEP needs the paired CI
 * above the bar; a CI that straddles it is NOISY rather than a win, so a lucky
 * draw on one aggregate number cannot climb the ratchet.
 */
export type RatchetVerdict = "keep" | "no_gain" | "regressed" | "noisy" | "insufficient_units";

export interface RatchetDecision {
  accept: boolean;
  verdict: RatchetVerdict;
  mode: "scalar" | "paired_bootstrap";
  reason: string;
  scalarImproved: boolean;
  paired?: import("./unit-scores.js").PairedBootstrapResult;
  segments?: SegmentEvidence[];
}

/** Judge per-segment evidence: required segments must clear the bar, guards must not lose significantly. */
export function judgeSegments(perSegment: Record<string, import("./unit-scores.js").PairedBootstrapResult | undefined>, policy: RatchetPolicy): SegmentEvidence[] {
  const evidence: SegmentEvidence[] = [];
  for (const segment of policy.requireSegments ?? []) {
    const paired = perSegment[segment];
    if (!paired || paired.matched < policy.minUnits) evidence.push({ segment, role: "require", ...(paired ? { paired } : {}), passed: false, note: `required segment ${segment} has ${paired?.matched ?? 0} matched units` });
    else evidence.push({ segment, role: "require", paired, passed: paired.lower > policy.minLowerBound, note: `${segment} CI [${paired.lower.toPrecision(3)}, ${paired.upper.toPrecision(3)}]` });
  }
  for (const segment of policy.guardSegments ?? []) {
    const paired = perSegment[segment];
    if (!paired || paired.matched < policy.minUnits) evidence.push({ segment, role: "guard", ...(paired ? { paired } : {}), passed: null, note: `guard ${segment} not evaluated` });
    else evidence.push({ segment, role: "guard", paired, passed: paired.upper >= 0, note: `${segment} CI [${paired.lower.toPrecision(3)}, ${paired.upper.toPrecision(3)}]` });
  }
  return evidence;
}

/** Apply per-segment gates on top of an overall decision. */
export function applySegmentGates(decision: RatchetDecision, segments: SegmentEvidence[]): RatchetDecision {
  if (!segments.length) return decision;
  const failedRequire = segments.filter((entry) => entry.role === "require" && entry.passed === false);
  const failedGuard = segments.filter((entry) => entry.role === "guard" && entry.passed === false);
  const unevaluated = segments.filter((entry) => entry.passed === null).map((entry) => entry.segment);
  const suffix = `${unevaluated.length ? `; unevaluated guards: ${unevaluated.join(", ")}` : ""}`;
  if (!decision.accept) return { ...decision, segments, reason: `${decision.reason}${suffix}` };
  if (failedGuard.length) return { ...decision, accept: false, verdict: "regressed", segments, reason: `guard segment loss: ${failedGuard.map((entry) => entry.note).join("; ")}` };
  if (failedRequire.length) return { ...decision, accept: false, verdict: "noisy", segments, reason: `required segments not resolved: ${failedRequire.map((entry) => entry.note).join("; ")}` };
  return { ...decision, segments, reason: `${decision.reason}; all required segments clear: ${segments.filter((entry) => entry.role === "require").map((entry) => entry.note).join("; ")}${suffix}` };
}

/** Decide one ratchet step from the scalar comparison and, when available, per-unit paired evidence. */
export function decideRatchet(input: { scalarImproved: boolean; scalarDelta: number | null; paired?: import("./unit-scores.js").PairedBootstrapResult; policy: RatchetPolicy }): RatchetDecision {
  const { policy, paired, scalarImproved } = input;
  const scalar = (reason: string): RatchetDecision => ({ accept: scalarImproved, verdict: scalarImproved ? "keep" : (input.scalarDelta ?? 0) < 0 ? "regressed" : "no_gain", mode: "scalar", reason, scalarImproved });
  if (policy.mode === "scalar") return scalar("ratchet.mode is scalar");
  if (!paired) {
    if (policy.mode === "paired") return { accept: false, verdict: "insufficient_units", mode: "paired_bootstrap", reason: "ratchet.mode is paired but unit scores are missing for the candidate or the reference", scalarImproved };
    return scalar("no per-unit scores for both runs; scalar comparison");
  }
  if (paired.matched < policy.minUnits) {
    if (policy.mode === "paired") return { accept: false, verdict: "insufficient_units", mode: "paired_bootstrap", reason: `only ${paired.matched} matched units (< ${policy.minUnits})`, scalarImproved, paired };
    return { ...scalar(`only ${paired.matched} matched units (< ${policy.minUnits}); scalar comparison`), paired };
  }
  const level = `${Math.round(paired.confidence * 100)}% CI [${paired.lower.toPrecision(4)}, ${paired.upper.toPrecision(4)}]`;
  if (paired.lower > policy.minLowerBound && !scalarImproved) return { accept: false, verdict: "no_gain", mode: "paired_bootstrap", reason: `${level} clears ${policy.minLowerBound} but the aggregate metric did not improve; both must agree`, scalarImproved, paired };
  if (paired.lower > policy.minLowerBound) return { accept: true, verdict: "keep", mode: "paired_bootstrap", reason: `${level} lower bound > ${policy.minLowerBound} over ${paired.matched} units`, scalarImproved, paired };
  if (paired.upper < 0) return { accept: false, verdict: "regressed", mode: "paired_bootstrap", reason: `${level} is entirely below 0`, scalarImproved, paired };
  if (paired.upper <= policy.minLowerBound) return { accept: false, verdict: "no_gain", mode: "paired_bootstrap", reason: `${level} cannot clear ${policy.minLowerBound}`, scalarImproved, paired };
  return { accept: false, verdict: "noisy", mode: "paired_bootstrap", reason: `${level} straddles ${policy.minLowerBound}; the difference is not resolved by these units`, scalarImproved, paired };
}
