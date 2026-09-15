import { capabilityGaps, validateTrajectoryStructure, type TrajectoryEvent, type TrajectoryQuality } from "./trajectories.js";
import type { CapabilityTier } from "./capability-router.js";
import { redactStructured } from "./redaction.js";
import type { ReplayWorld } from "./replay-simulator.js";

export type ExperienceAdmission = "candidate" | "replay-only" | "quarantined";

export interface ExperienceRecord {
  schemaVersion: 1;
  trajectoryId: string;
  scene: { task: string; domain: string; context: string; askingOrDoing: "asking" | "doing" | "unknown" };
  goal: { objective: string; acceptance: string; relation: "new" | "continued" | "modified" | "resumed" | "unknown" };
  outcome: { status: "success" | "partial" | "failure" | "unknown"; evidence: string[] };
  verification?: { declared: number; executed: number; passed: number; failed: number; independent: boolean };
  quality: TrajectoryQuality;
  routing?: { predictedTier: CapabilityTier; tierScores?: Record<CapabilityTier, number>; provider?: string; model?: string };
  gaps: string[];
  admission: ExperienceAdmission;
  events: TrajectoryEvent[];
}

export interface CapabilityProfile {
  total: number;
  eligible: number;
  quarantined: number;
  byTier: Record<CapabilityTier, number>;
  byOutcome: Record<"success" | "partial" | "failure" | "unknown", number>;
  gaps: Record<string, number>;
}

export interface CurriculumSelection {
  stage: 1 | 2 | 3;
  trajectoryIds: string[];
  rationale: string;
}

export interface CurriculumReplay {
  trajectoryId: string;
  objective: string;
  acceptance: string;
  outcome: ExperienceRecord["outcome"]["status"];
  evidence: string[];
  gaps: string[];
  quality: TrajectoryQuality["overall"];
}

/**
 * Project durable experiences into an offline replay world. The utility is
 * deliberately supplied by the caller: trajectory quality is not the same
 * thing as task success, and different research/challenge evaluators need
 * different objective semantics.
 */
export function experienceReplayWorld(
  records: ExperienceRecord[],
  utilityFor: (record: ExperienceRecord) => number | undefined,
  options: { limit?: number; rootId?: string; objectiveValuesFor?: (record: ExperienceRecord) => Record<string, number> | undefined } = {},
): ReplayWorld | undefined {
  const limit = Math.max(0, Math.min(256, options.limit ?? 48));
  const rootId = options.rootId ?? "experience-root";
  const selected = records
    .filter((item) => item.admission !== "quarantined")
    .slice(-limit);
  if (!selected.length) return undefined;
  const projected = selected.map((item) => ({ item, utility: utilityFor(item) })).filter((entry): entry is { item: ExperienceRecord; utility: number } => entry.utility !== undefined);
  if (!projected.length) return undefined;
  const ids = new Set(projected.map(({ item }) => item.trajectoryId));
  if (ids.has(rootId)) throw new Error(`Replay root '${rootId}' collides with an experience trajectory ID.`);
  const nodes = projected.map(({ item, utility }) => {
    const durationMinutes = item.events.reduce((maximum, event) => {
      const payload = record(event.payload);
      const minutes = typeof payload.durationMinutes === "number" ? payload.durationMinutes : typeof payload.durationMs === "number" ? payload.durationMs / 60_000 : undefined;
      return typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0 ? Math.max(maximum, minutes) : maximum;
    }, 0);
    const rawParent = item.events.map((event) => record(event.payload).parentTrajectoryId).find((value) => typeof value === "string");
    const parentId = typeof rawParent === "string" && ids.has(rawParent) ? rawParent : rootId;
    const objectiveValues = options.objectiveValuesFor?.(item);
    return {
      id: item.trajectoryId,
      parentId,
      utility,
      ...(objectiveValues && Object.keys(objectiveValues).length ? { objectiveValues } : {}),
      outcomeType: "other" as const,
      costMinutes: durationMinutes,
      valid: item.admission === "candidate",
    };
  });
  return {
    rootId,
    direction: "maximize",
    nodes: [{ id: rootId, parentId: null, utility: 0, outcomeType: "system", costMinutes: 0, valid: false }, ...nodes],
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function outcomeFor(quality: TrajectoryQuality): ExperienceRecord["outcome"]["status"] {
  if (quality.overall === "PASS") return "success";
  if (quality.overall === "FAIL") return "failure";
  if (quality.overall === "WARN") return "partial";
  return "unknown";
}

function storedRouting(payload: Record<string, unknown>): ExperienceRecord["routing"] | undefined {
  const value = record(payload.routing);
  const tier = value.predictedTier;
  if (tier !== "C0" && tier !== "C1" && tier !== "C2" && tier !== "C3") return undefined;
  const rawScores = record(value.tierScores);
  const tierScores = Object.fromEntries(["C0", "C1", "C2", "C3"].filter((key) => typeof rawScores[key] === "number").map((key) => [key, rawScores[key]])) as Record<CapabilityTier, number>;
  return { predictedTier: tier, ...(Object.keys(tierScores).length ? { tierScores } : {}), ...(typeof value.provider === "string" ? { provider: value.provider } : {}), ...(typeof value.model === "string" ? { model: value.model } : {}) };
}

function storedVerification(payload: Record<string, unknown>): ExperienceRecord["verification"] | undefined {
  const value = record(payload.verification);
  if (!["declared", "executed", "passed", "failed"].every((key) => typeof value[key] === "number" && Number.isInteger(value[key]) && (value[key] as number) >= 0) || typeof value.independent !== "boolean") return undefined;
  return {
    declared: value.declared as number,
    executed: value.executed as number,
    passed: value.passed as number,
    failed: value.failed as number,
    independent: value.independent,
  };
}

/** Convert a validated trajectory into a reusable, provenance-preserving experience unit. */
export function buildExperienceRecord(input: {
  trajectoryId: string;
  payload: unknown;
  quality: TrajectoryQuality;
  routing?: ExperienceRecord["routing"];
}): ExperienceRecord {
  const payload = record(input.payload);
  const events = Array.isArray(payload.events) ? payload.events as TrajectoryEvent[] : [];
  const structure = validateTrajectoryStructure(events);
  const goal = record(payload.goal);
  const scene = record(payload.scene);
  const objective = text(payload.objective ?? goal.objective, "unspecified objective");
  const status = outcomeFor(input.quality);
  const routing = input.routing ?? storedRouting(payload);
  const manifest = record(payload.manifest);
  const acceptance = record(manifest.acceptance);
  const replicationRequired = acceptance.requireReplication === true && typeof manifest.parent !== "string";
  const verification = storedVerification(payload);
  const weakVerification = Boolean(verification && (verification.failed > 0 || verification.executed !== verification.declared || verification.passed !== verification.executed || (verification.declared >= 2 && !verification.independent)));
  const admission: ExperienceAdmission = structure.status === "quarantined" || input.quality.structural.verdict === "FAIL"
    ? "quarantined"
    : weakVerification || replicationRequired || structure.status === "recoverable" || input.quality.overall === "FAIL"
      ? "replay-only"
      : "candidate";
  return {
    schemaVersion: 1,
    trajectoryId: input.trajectoryId,
    scene: {
      task: text(scene.task ?? payload.mode, payload.manifest ? "experiment" : "research").toLowerCase(),
      domain: text(scene.domain ?? payload.domain, "general"),
      context: text(scene.context, "workbench"),
      askingOrDoing: scene.askingOrDoing === "asking" || scene.askingOrDoing === "doing" ? scene.askingOrDoing : "unknown",
    },
    goal: {
      objective,
      acceptance: text(goal.acceptance ?? payload.stopCondition, "not specified"),
      relation: ["new", "continued", "modified", "resumed"].includes(String(goal.relation)) ? String(goal.relation) as ExperienceRecord["goal"]["relation"] : "unknown",
    },
    outcome: { status, evidence: input.quality.goalAttainment.evidence },
    ...(verification ? { verification } : {}),
    quality: input.quality,
    routing,
    gaps: [...capabilityGaps(input.quality), ...(replicationRequired ? ["independent replication required"] : [])],
    admission,
    events,
  };
}

export function capabilityProfile(records: ExperienceRecord[]): CapabilityProfile {
  const profile: CapabilityProfile = {
    total: records.length,
    eligible: records.filter((item) => item.admission === "candidate").length,
    quarantined: records.filter((item) => item.admission === "quarantined").length,
    byTier: { C0: 0, C1: 0, C2: 0, C3: 0 },
    byOutcome: { success: 0, partial: 0, failure: 0, unknown: 0 },
    gaps: {},
  };
  for (const item of records) {
    if (item.routing?.predictedTier) profile.byTier[item.routing.predictedTier] += 1;
    profile.byOutcome[item.outcome.status] += 1;
    for (const gap of item.gaps) profile.gaps[gap] = (profile.gaps[gap] ?? 0) + 1;
  }
  return profile;
}

/** Select a three-stage mixture: bounded coverage, broad coverage, then high-demand replay. */
export function selectCurriculum(records: ExperienceRecord[], limit = 12): CurriculumSelection[] {
  const usable = records.filter((item) => item.admission !== "quarantined");
  const ordered = [...usable].sort((a, b) => {
    const tier = (item: ExperienceRecord) => item.routing?.predictedTier ? Number(item.routing.predictedTier.slice(1)) : 0;
    return tier(a) - tier(b) || a.trajectoryId.localeCompare(b.trajectoryId);
  });
  const capped = ordered.slice(0, Math.max(0, limit));
  const first = capped.filter((item) => !item.routing?.predictedTier || item.routing.predictedTier === "C0" || item.routing.predictedTier === "C1").slice(0, Math.ceil(capped.length / 3));
  const remaining = capped.filter((item) => !first.includes(item));
  const second = remaining.slice(0, Math.ceil(capped.length / 3));
  const third = remaining.slice(Math.ceil(capped.length / 3));
  return [
    { stage: 1, trajectoryIds: first.map((item) => item.trajectoryId), rationale: "start with bounded, structurally clean experiences" },
    { stage: 2, trajectoryIds: second.map((item) => item.trajectoryId), rationale: "expand across observed tasks and outcomes" },
    { stage: 3, trajectoryIds: third.map((item) => item.trajectoryId), rationale: "introduce higher-demand and replay-worthy experiences" },
  ];
}

/**
 * Materialize the selected curriculum into a small prompt-safe replay. IDs
 * alone are not useful to an agent; replay must carry the lesson while
 * remaining bounded and explicitly tied to the original trajectory.
 */
export function curriculumReplay(records: ExperienceRecord[], selection: CurriculumSelection[], limit = 6): CurriculumReplay[] {
  const selected = new Set(selection.flatMap((stage) => stage.trajectoryIds));
  return records
    .filter((record) => selected.has(record.trajectoryId) && record.admission !== "quarantined")
    .slice(0, Math.max(0, limit))
    .map((record) => ({
      trajectoryId: record.trajectoryId,
      objective: record.goal.objective.slice(0, 500),
      acceptance: record.goal.acceptance.slice(0, 300),
      outcome: record.outcome.status,
      evidence: record.outcome.evidence.slice(0, 4),
      gaps: record.gaps.slice(0, 8),
      quality: record.quality.overall,
    }));
}

/** Serialize only admissible experience for replay, analysis, or later post-training. */
export function experienceJsonl(records: ExperienceRecord[], includeReplay = false): string {
  return records
    .filter((item) => item.admission === "candidate" || (includeReplay && item.admission === "replay-only"))
    .map((item) => JSON.stringify(redactStructured(item)))
    .join("\n") + (records.some((item) => item.admission === "candidate" || (includeReplay && item.admission === "replay-only")) ? "\n" : "");
}
