import { PhaseGoalSchema, type PhaseGoal, type ResearchPhase } from "./types.js";
import { auditSubtask, type SubtaskAudit, type SubtaskContract, type SubtaskObservation } from "./subtask-state.js";

/** Create a short deterministic identity for one mode/objective goal set. */
export function phaseGoalSetId(ultimateGoal: string, mode: "research" | "challenge"): string {
  let hash = 2166136261;
  for (const character of `${mode}\u0000${ultimateGoal.trim().replace(/\s+/g, " ").toLowerCase()}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

const PHASES: Array<{ phase: ResearchPhase; title: string; objective: string; criteria: string[] }> = [
  { phase: "orientation", title: "Understand the workspace", objective: "Inventory the repository, research question, rules, data contract, and execution environment.", criteria: ["repository inventory recorded", "workspace configuration loaded", "execution environment checked"] },
  { phase: "baseline", title: "Establish a trusted baseline", objective: "Run the canonical evaluator and record reproducible baseline metrics and logs.", criteria: ["baseline exits successfully", "primary metric parsed", "baseline artifacts checksummed"] },
  { phase: "data_audit", title: "Audit data and leakage", objective: "Find distribution problems, duplicates, leakage paths, and invalid assumptions before optimization.", criteria: ["data audit report recorded", "leakage audit completed", "critical findings resolved or explicitly accepted"] },
  { phase: "validation", title: "Lock validation policy", objective: "Choose a versioned validation and split policy that reflects plausible hidden test environments.", criteria: ["split version recorded", "primary metric defined", "validation policy locked"] },
  { phase: "hypothesis", title: "Find the highest-information hypothesis", objective: "Generate, rank, and select a falsifiable improvement with an explicit test and cost.", criteria: ["hypothesis graph populated", "selected hypothesis has a falsification test", "experiment manifest created"] },
  { phase: "implementation", title: "Implement an isolated experiment", objective: "Implement the selected change in a clean worktree and pass smoke checks.", criteria: ["isolated worktree created", "change implemented", "smoke checks pass"] },
  { phase: "evaluation", title: "Evaluate with evidence", objective: "Run the experiment, capture artifacts, recompute metrics, and compare against baseline.", criteria: ["run completed", "metrics and logs checksummed", "statistical comparison recorded"] },
  { phase: "replication", title: "Independently replicate", objective: "Repeat promising improvements with an independent seed or implementation before acceptance.", criteria: ["replication manifest created", "replication run completed", "replication agrees within configured tolerance"] },
  { phase: "promotion", title: "Promote only verified work", objective: "Require leakage clearance, review approval, and complete provenance before promotion or submission.", criteria: ["all evidence gates pass", "review approval recorded", "promotion provenance written"] },
];

/** Adapt the durable phase machine to the generic auditable-subtask contract. */
export function phaseGoalSubtaskContract(goal: Pick<PhaseGoal, "id" | "objective" | "completionCriteria">): SubtaskContract {
  return {
    id: goal.id,
    objective: goal.objective,
    acceptanceCriteria: goal.completionCriteria.map((description, index) => ({
      id: `criterion_${index + 1}`,
      description,
      required: true,
    })),
    scope: "phase_goal",
  };
}

/**
 * Run the generic auditor for a phase goal. The phase-specific gate remains
 * responsible for interpreting domain evidence; this adapter makes its final
 * decision auditable and prevents executor prose from satisfying a phase.
 */
export function auditPhaseGoal(goal: Pick<PhaseGoal, "id" | "objective" | "completionCriteria">, observations: SubtaskObservation[], auditedAt?: string): SubtaskAudit {
  return auditSubtask(phaseGoalSubtaskContract(goal), observations, auditedAt);
}

/** Convert the domain gate into a conservative structured audit for persistence. */
export function auditPhaseGoalGate(goal: Pick<PhaseGoal, "id" | "objective" | "completionCriteria">, gate: PhaseGoalGate, evidenceIds: string[] = [], auditedAt?: string): SubtaskAudit {
  const observations: SubtaskObservation[] = phaseGoalSubtaskContract(goal).acceptanceCriteria.map((criterion) => ({
    criterionId: criterion.id,
    // The domain gate is the verifier for the phase. Never infer partial
    // success from an agent's status; an unmet gate blocks the whole subtask.
    satisfied: gate.met,
    source: "auditor",
    evidenceIds: gate.met ? evidenceIds : [],
    detail: gate.met ? "phase domain gate passed" : `phase domain gate missing: ${gate.missing.join(", ")}`,
  }));
  return auditPhaseGoal(goal, observations, auditedAt);
}

/** Event families that can satisfy phase completion; correctness must read the durable history. */
export const PHASE_GOAL_EVENT_TYPES = [
  "research.observation", "project.created", "baseline.completed", "data.audit.completed", "data.audit.accepted",
  "validation.policy.created", "validation.policy.locked", "validation.policy.unlocked", "hypothesis.created", "experiment.created", "experiment.stage.smoke.completed",
  "experiment.stage.full_validation.completed", "run.completed", "experiment.comparison.completed", "replication.manifest.created", "experiment.autonomous.replication.completed",
  "experiment.gates.updated", "experiment.validation.assessed", "research.ablation.plan", "research.ablation.evidence",
] as const;

export function definePhaseGoals(ultimateGoal: string, mode: "research" | "challenge"): PhaseGoal[] {
  const now = new Date().toISOString();
  const goalSetId = phaseGoalSetId(ultimateGoal, mode);
  return PHASES.map((template, index) => {
    const researchBaseline = mode === "research" && template.phase === "baseline";
    const phase = researchBaseline
      ? { ...template, title: "Establish a trusted reference", objective: "Record a durable reference observation for the research workspace before forming conclusions.", criteria: ["reference observation recorded", "workspace state captured"] }
      : template;
    return PhaseGoalSchema.parse({
    id: `goal_${mode}_${goalSetId}_${template.phase}`,
    goalSetId,
    phase: phase.phase,
    title: phase.title,
    objective: `${phase.objective} Ultimate objective: ${ultimateGoal}`,
    completionCriteria: phase.criteria,
    status: index === 0 ? "active" : "pending",
    evidenceIds: [],
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    });
  });
}

export function activePhaseGoal(goals: PhaseGoal[], mode?: "research" | "challenge"): PhaseGoal | undefined {
  const scoped = mode ? phaseGoalsForMode(goals, mode) : goals;
  // A blocked goal is the next goal to revisit after the operator resolves its
  // bottleneck; never silently advance past it to a later pending phase.
  return scoped.find((goal) => goal.status === "active") ?? scoped.find((goal) => goal.status === "blocked") ?? scoped.find((goal) => goal.status === "pending");
}

/** Keep research and challenge phase machines independent in one project store. */
export function phaseGoalsForMode(goals: PhaseGoal[], mode: "research" | "challenge", goalSetId?: string): PhaseGoal[] {
  const modeGoals = goals.filter((goal) => goal.id.startsWith(`goal_${mode}_`));
  if (!goalSetId) return modeGoals;
  return modeGoals.filter((goal) => goal.goalSetId === goalSetId || goal.id.startsWith(`goal_${mode}_${goalSetId}_`));
}

/** Keep phase-gate evidence inside the objective's durable creation boundary. */
export function phaseGoalEventsSince<T extends { createdAt: string }>(goal: Pick<PhaseGoal, "createdAt">, events: T[]): T[] {
  const boundary = Date.parse(goal.createdAt);
  return Number.isFinite(boundary) ? events.filter((event) => Date.parse(event.createdAt) >= boundary) : [];
}

/** Count durable records created after a phase goal began. */
export function phaseGoalRecordsSince<T extends { createdAt: string }>(goal: Pick<PhaseGoal, "createdAt">, records: T[]): number {
  return phaseGoalEventsSince(goal, records).length;
}

export interface PhaseGoalEvidence {
  mode?: "research" | "challenge";
  eventTypes: string[];
  eventPayloads: Array<{ type: string; payload: unknown }>;
  hypotheses: number;
  experiments: number;
  runs: number;
  artifacts: number;
  candidateHypotheses?: number;
}

export interface PhaseGoalGate {
  met: boolean;
  missing: string[];
}

/** Deterministically check whether a model-reported phase completion has evidence. */
export function evaluatePhaseGoalEvidence(goal: Pick<PhaseGoal, "phase">, evidence: PhaseGoalEvidence): PhaseGoalGate {
  const has = (type: string): boolean => evidence.eventTypes.includes(type);
  const payloads = (type: string): unknown[] => evidence.eventPayloads.filter((event) => event.type === type).map((event) => event.payload);
  const missing: string[] = [];
  switch (goal.phase) {
    case "orientation": if (!has("research.observation") && !has("project.created")) missing.push("workspace observation"); break;
    case "baseline": {
      if (evidence.mode === "research") {
        if (!has("research.observation")) missing.push("reference observation");
        break;
      }
      // A project can contain legacy and retried baselines. Evaluate the newest
      // successful record so a valid rerun can repair an older incomplete one.
      const baseline = payloads("baseline.completed").reverse().find((payload) => (payload as { exitCode?: unknown }).exitCode === 0);
      if (!baseline) missing.push("successful baseline");
      else if (typeof (baseline as { metric?: unknown }).metric !== "number" || !Number.isFinite((baseline as { metric?: number }).metric)) missing.push("parsed primary baseline metric");
      else if (!Object.keys((baseline as { artifactChecksums?: Record<string, unknown> }).artifactChecksums ?? {}).length) missing.push("checksummed baseline artifacts");
      break;
    }
    case "data_audit": {
      const reports = payloads("data.audit.completed");
      if (!reports.length) missing.push("data audit report");
      else {
        const latest = reports.at(-1) as { fingerprint?: unknown; duplicateGroups?: unknown[]; distributionShift?: unknown[]; warnings?: unknown[] };
        const clean = (latest.duplicateGroups?.length ?? 0) === 0 && (latest.distributionShift?.length ?? 0) === 0 && (latest.warnings?.length ?? 0) === 0;
        const accepted = payloads("data.audit.accepted").some((payload) => {
          const value = payload as { accepted?: unknown; fingerprint?: unknown };
          return value.accepted === true && typeof latest.fingerprint === "string" && value.fingerprint === latest.fingerprint;
        });
        if (!clean && !accepted) missing.push("critical audit findings resolved or explicitly accepted");
      }
      break;
    }
    case "validation": {
      if (!has("validation.policy.created")) missing.push("versioned validation policy");
      const policyLifecycle = evidence.eventPayloads.filter((event) => ["validation.policy.created", "validation.policy.locked", "validation.policy.unlocked"].includes(event.type));
      const latestPolicyEvent = policyLifecycle.at(-1)?.type;
      if (latestPolicyEvent !== "validation.policy.locked") missing.push("validation policy locked");
      break;
    }
    case "hypothesis": if ((evidence.hypotheses + (evidence.candidateHypotheses ?? 0)) < 1) missing.push("durable hypothesis"); if (evidence.experiments < 1 && !has("experiment.created")) missing.push("experiment manifest"); break;
    case "implementation": if (!has("experiment.stage.smoke.completed") && !has("experiment.stage.full_validation.completed")) missing.push("completed implementation or smoke stage"); break;
    case "evaluation": {
      const validated = payloads("experiment.stage.full_validation.completed").some((payload) => {
        const value = payload as { exitCode?: unknown; metric?: unknown; outcomeType?: unknown; declaredArtifactCount?: unknown; verificationPassed?: unknown };
        const successful = value.exitCode === undefined || value.exitCode === 0;
        if (!successful) return false;
        // Scalar metrics require a finite primary value. Other outcomes are
        // evaluated by successful execution plus their declared artifacts or
        // verifier evidence; they must not be forced through a fake score.
        if (value.outcomeType && value.outcomeType !== "metric") return Number(value.declaredArtifactCount ?? 0) > 0 || Number(value.verificationPassed ?? 0) > 0;
        return typeof value.metric === "number" && Number.isFinite(value.metric);
      });
      if (!validated) missing.push(payloads("experiment.stage.full_validation.completed").some((payload) => (payload as { outcomeType?: unknown }).outcomeType && (payload as { outcomeType?: unknown }).outcomeType !== "metric")
        ? "completed evaluated run with the declared outcome evidence"
        : "completed evaluated run with primary metric");
      else if (!has("run.completed")) missing.push("completed evaluated run");
      else if (evidence.mode !== "research" && !has("experiment.comparison.completed")) missing.push("baseline comparison");
      break;
    }
    case "replication": {
      const replicationIds = new Set(payloads("replication.manifest.created").map((payload) => (payload as { replicationId?: unknown }).replicationId).filter((value): value is string => typeof value === "string"));
      const successfulReplication = payloads("experiment.autonomous.replication.completed").some((payload) => {
        const value = payload as { replicationId?: unknown; exitCode?: unknown };
        return value.exitCode === 0 && typeof value.replicationId === "string" && replicationIds.has(value.replicationId);
      }) || evidence.eventPayloads.some((event) => {
        if (event.type !== "run.completed") return false;
        const value = event.payload as { experimentId?: unknown; exitCode?: unknown };
        return value.exitCode === 0 && typeof value.experimentId === "string" && replicationIds.has(value.experimentId);
      });
      if (!replicationIds.size || evidence.runs < 2 || !successfulReplication) missing.push("independent replication run");
      break;
    }
    case "promotion": {
      if (!payloads("experiment.gates.updated").some((payload) => { const value = payload as { leakageAuditPassed?: unknown; reviewerApproved?: unknown }; return value.leakageAuditPassed === true && value.reviewerApproved === true; })) missing.push("approved leakage and reviewer gates");
      if (!payloads("experiment.validation.assessed").some((payload) => { const value = payload as { acceptance?: { accepted?: unknown } }; return value.acceptance?.accepted === true; })) missing.push("accepted validation assessment");
      const ablationPlans = payloads("research.ablation.plan");
      if (ablationPlans.length && !payloads("research.ablation.evidence").some((payload) => (payload as { complete?: unknown }).complete === true)) missing.push("complete ablation evidence");
      break;
    }
  }
  return { met: missing.length === 0, missing };
}
