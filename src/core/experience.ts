import { capabilityGaps, validateTrajectoryStructure, type TrajectoryEvent, type TrajectoryQuality } from "./trajectories.js";
import type { CapabilityTier } from "./capability-router.js";

export type ExperienceAdmission = "candidate" | "replay-only" | "quarantined";

export interface ExperienceRecord {
  schemaVersion: 1;
  trajectoryId: string;
  scene: { task: string; domain: string; context: string; askingOrDoing: "asking" | "doing" | "unknown" };
  goal: { objective: string; acceptance: string; relation: "new" | "continued" | "modified" | "resumed" | "unknown" };
  outcome: { status: "success" | "partial" | "failure" | "unknown"; evidence: string[] };
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
  const admission: ExperienceAdmission = structure.status === "quarantined" || input.quality.structural.verdict === "FAIL"
    ? "quarantined"
    : structure.status === "recoverable" || input.quality.overall === "FAIL"
      ? "replay-only"
      : "candidate";
  const status = outcomeFor(input.quality);
  return {
    schemaVersion: 1,
    trajectoryId: input.trajectoryId,
    scene: {
      task: text(scene.task ?? payload.mode, "research").toLowerCase(),
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
    quality: input.quality,
    routing: input.routing,
    gaps: capabilityGaps(input.quality),
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
