import { PhaseGoalSchema, type PhaseGoal, type ResearchPhase } from "./types.js";
import { auditSubtask, type SubtaskAudit, type SubtaskContract, type SubtaskObservation } from "./subtask-state.js";

export type ResearchStage = "orient" | "discover" | "validate";

const STAGE_PHASES: Record<ResearchStage, readonly ResearchPhase[]> = {
  orient: ["orientation", "baseline", "data_audit"],
  discover: ["validation", "hypothesis", "implementation"],
  validate: ["evaluation", "replication", "promotion"],
};

/** Map the detailed phase machine to the three user-facing research stages. */
export function researchStageForPhase(phase: ResearchPhase): ResearchStage {
  for (const [stage, phases] of Object.entries(STAGE_PHASES) as Array<[ResearchStage, readonly ResearchPhase[]]>) {
    if (phases.includes(phase)) return stage;
  }
  return "orient";
}

export interface ResearchStageProgress {
  stage: ResearchStage;
  completed: number;
  total: number;
  ratio: number;
  activePhase?: ResearchPhase;
  status: "pending" | "active" | "blocked" | "met";
}

/** Summarize durable phase goals without letting model prose advance a stage. */
export function researchStageProgress(goals: readonly Pick<PhaseGoal, "phase" | "status">[]): ResearchStageProgress[] {
  return (Object.keys(STAGE_PHASES) as ResearchStage[]).map((stage) => {
    const phaseSet = STAGE_PHASES[stage];
    const scoped = goals.filter((goal) => phaseSet.includes(goal.phase));
    const completed = scoped.filter((goal) => goal.status === "met").length;
    const active = scoped.find((goal) => goal.status === "active" || goal.status === "blocked");
    const status: ResearchStageProgress["status"] = active?.status ?? (scoped.length > 0 && completed === scoped.length ? "met" : completed > 0 ? "active" : "pending");
    return {
      stage,
      completed,
      total: phaseSet.length,
      ratio: phaseSet.length ? completed / phaseSet.length : 0,
      activePhase: active?.phase,
      status,
    };
  });
}

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

/** Merge independent domain and semantic checks into one conservative audit. */
export function mergePhaseGoalAudits(
  goal: Pick<PhaseGoal, "id" | "objective" | "completionCriteria">,
  domainAudit: SubtaskAudit,
  semanticCriteria: Array<{ criterionId: string; verdict: "pass" | "revise" | "reject"; evidence?: string[]; reasoning?: string }>,
  auditedAt?: string,
): SubtaskAudit {
  const contract = phaseGoalSubtaskContract(goal);
  return auditPhaseGoal(goal, contract.acceptanceCriteria.map((criterion) => {
    const domain = domainAudit.criteria.find((entry) => entry.id === criterion.id);
    const semantic = semanticCriteria.find((entry) => entry.criterionId === criterion.id);
    const evidenceIds = [...new Set([...(domain?.evidenceIds ?? []), ...(semantic?.evidence ?? [])])];
    return {
      criterionId: criterion.id,
      satisfied: domain?.satisfied === true && semantic?.verdict === "pass",
      source: "auditor" as const,
      evidenceIds,
      detail: semantic?.reasoning ?? "criterion required both domain and semantic verification",
    };
  }), auditedAt);
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
  falsifiableHypotheses?: number;
  selectedHypothesisFalsifiable?: boolean;
}

export interface PhaseGoalGate {
  met: boolean;
  missing: string[];
  /** Dense steering signal; this never overrides the all-required-checks gate. */
  progress: { completed: number; total: number; ratio: number };
}

/** Deterministically check whether a model-reported phase completion has evidence. */
export function evaluatePhaseGoalEvidence(goal: Pick<PhaseGoal, "phase">, evidence: PhaseGoalEvidence): PhaseGoalGate {
  const has = (type: string): boolean => evidence.eventTypes.includes(type);
  const payloads = (type: string): unknown[] => evidence.eventPayloads.filter((event) => event.type === type).map((event) => event.payload);
  const missing: string[] = [];
  const checks: boolean[] = [];
  const requireCheck = (satisfied: boolean, message: string): void => {
    checks.push(satisfied);
    if (!satisfied) missing.push(message);
  };
  switch (goal.phase) {
    case "orientation": requireCheck(has("research.observation") || has("project.created"), "workspace observation"); break;
    case "baseline": {
      if (evidence.mode === "research") {
        requireCheck(has("research.observation"), "reference observation");
        break;
      }
      // A project can contain legacy and retried baselines. Evaluate the newest
      // successful record so a valid rerun can repair an older incomplete one.
      const baseline = payloads("baseline.completed").reverse().find((payload) => (payload as { exitCode?: unknown }).exitCode === 0);
      requireCheck(Boolean(baseline), "successful baseline");
      requireCheck(Boolean(baseline && typeof (baseline as { metric?: unknown }).metric === "number" && Number.isFinite((baseline as { metric?: number }).metric)), "parsed primary baseline metric");
      requireCheck(Boolean(baseline && Object.keys((baseline as { artifactChecksums?: Record<string, unknown> }).artifactChecksums ?? {}).length), "checksummed baseline artifacts");
      break;
    }
    case "data_audit": {
      const reports = payloads("data.audit.completed");
      requireCheck(reports.length > 0, "data audit report");
      if (reports.length) {
        const latest = reports.at(-1) as { fingerprint?: unknown; duplicateGroups?: unknown[]; distributionShift?: unknown[]; warnings?: unknown[] };
        const clean = (latest.duplicateGroups?.length ?? 0) === 0 && (latest.distributionShift?.length ?? 0) === 0 && (latest.warnings?.length ?? 0) === 0;
        const accepted = payloads("data.audit.accepted").some((payload) => {
          const value = payload as { accepted?: unknown; fingerprint?: unknown };
          return value.accepted === true && typeof latest.fingerprint === "string" && value.fingerprint === latest.fingerprint;
        });
        requireCheck(clean || accepted, "critical audit findings resolved or explicitly accepted");
      }
      break;
    }
    case "validation": {
      requireCheck(has("validation.policy.created"), "versioned validation policy");
      const policyLifecycle = evidence.eventPayloads.filter((event) => ["validation.policy.created", "validation.policy.locked", "validation.policy.unlocked"].includes(event.type));
      const latestPolicyEvent = policyLifecycle.at(-1)?.type;
      requireCheck(latestPolicyEvent === "validation.policy.locked", "validation policy locked");
      break;
    }
    case "hypothesis":
      requireCheck((evidence.hypotheses + (evidence.candidateHypotheses ?? 0)) >= 1, "durable hypothesis");
      requireCheck((evidence.falsifiableHypotheses ?? 0) >= 1, "falsifiable hypothesis");
      requireCheck(evidence.selectedHypothesisFalsifiable === true, "selected hypothesis has a falsification test");
      requireCheck(evidence.experiments >= 1 || has("experiment.created"), "experiment manifest");
      break;
    case "implementation": requireCheck(has("experiment.stage.smoke.completed") || has("experiment.stage.full_validation.completed"), "completed implementation or smoke stage"); break;
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
      requireCheck(validated, payloads("experiment.stage.full_validation.completed").some((payload) => (payload as { outcomeType?: unknown }).outcomeType && (payload as { outcomeType?: unknown }).outcomeType !== "metric")
        ? "completed evaluated run with the declared outcome evidence"
        : "completed evaluated run with primary metric");
      requireCheck(has("run.completed"), "completed evaluated run");
      if (evidence.mode !== "research") requireCheck(has("experiment.comparison.completed"), "baseline comparison");
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
      requireCheck(Boolean(replicationIds.size && evidence.runs >= 2 && successfulReplication), "independent replication run");
      break;
    }
    case "promotion": {
      requireCheck(payloads("experiment.gates.updated").some((payload) => { const value = payload as { leakageAuditPassed?: unknown; reviewerApproved?: unknown }; return value.leakageAuditPassed === true && value.reviewerApproved === true; }), "approved leakage and reviewer gates");
      requireCheck(payloads("experiment.validation.assessed").some((payload) => { const value = payload as { acceptance?: { accepted?: unknown } }; return value.acceptance?.accepted === true; }), "accepted validation assessment");
      const ablationPlans = payloads("research.ablation.plan");
      if (ablationPlans.length) requireCheck(payloads("research.ablation.evidence").some((payload) => (payload as { complete?: unknown }).complete === true), "complete ablation evidence");
      break;
    }
  }
  const completed = checks.filter(Boolean).length;
  return { met: missing.length === 0, missing, progress: { completed, total: checks.length, ratio: checks.length ? completed / checks.length : 1 } };
}
