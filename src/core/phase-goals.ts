import { PhaseGoalSchema, type PhaseGoal, type ResearchPhase } from "./types.js";

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

export function definePhaseGoals(ultimateGoal: string, mode: "research" | "challenge"): PhaseGoal[] {
  const now = new Date().toISOString();
  return PHASES.map((template, index) => {
    const researchBaseline = mode === "research" && template.phase === "baseline";
    const phase = researchBaseline
      ? { ...template, title: "Establish a trusted reference", objective: "Record a durable reference observation for the research workspace before forming conclusions.", criteria: ["reference observation recorded", "workspace state captured"] }
      : template;
    return PhaseGoalSchema.parse({
    id: `goal_${mode}_${template.phase}`,
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
export function phaseGoalsForMode(goals: PhaseGoal[], mode: "research" | "challenge"): PhaseGoal[] {
  return goals.filter((goal) => goal.id.startsWith(`goal_${mode}_`));
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
      const baseline = payloads("baseline.completed").find((payload) => (payload as { exitCode?: unknown }).exitCode === 0);
      if (!baseline) missing.push("successful baseline");
      else if (typeof (baseline as { metric?: unknown }).metric !== "number" || !Number.isFinite((baseline as { metric?: number }).metric)) missing.push("parsed primary baseline metric");
      else if (!Object.keys((baseline as { artifactChecksums?: Record<string, unknown> }).artifactChecksums ?? {}).length) missing.push("checksummed baseline artifacts");
      break;
    }
    case "data_audit": if (!has("data.audit.completed")) missing.push("data audit report"); break;
    case "validation": if (!has("validation.policy.created")) missing.push("versioned validation policy"); break;
    case "hypothesis": if ((evidence.hypotheses + (evidence.candidateHypotheses ?? 0)) < 1) missing.push("durable hypothesis"); if (evidence.experiments < 1 && !has("experiment.created")) missing.push("experiment manifest"); break;
    case "implementation": if (!has("experiment.stage.smoke.completed") && !has("experiment.stage.full_validation.completed")) missing.push("completed implementation or smoke stage"); break;
    case "evaluation": {
      const validated = payloads("experiment.stage.full_validation.completed").some((payload) => {
        const value = payload as { exitCode?: unknown; metric?: unknown };
        return (value.exitCode === undefined || value.exitCode === 0) && typeof value.metric === "number" && Number.isFinite(value.metric);
      });
      if (!validated) missing.push("completed evaluated run with primary metric");
      else if (!has("run.completed")) missing.push("completed evaluated run");
      else if (evidence.mode !== "research" && !has("experiment.comparison.completed")) missing.push("baseline comparison");
      break;
    }
    case "replication": if (!has("replication.manifest.created") || evidence.runs < 2) missing.push("independent replication run"); break;
    case "promotion": if (!payloads("experiment.gates.updated").some((payload) => { const value = payload as { leakageAuditPassed?: unknown; reviewerApproved?: unknown }; return value.leakageAuditPassed === true && value.reviewerApproved === true; })) missing.push("approved leakage and reviewer gates"); break;
  }
  return { met: missing.length === 0, missing };
}
