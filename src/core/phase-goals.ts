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
  return PHASES.map((template, index) => PhaseGoalSchema.parse({
    id: `goal_${mode}_${template.phase}`,
    phase: template.phase,
    title: template.title,
    objective: `${template.objective} Ultimate objective: ${ultimateGoal}`,
    completionCriteria: template.criteria,
    status: index === 0 ? "active" : "pending",
    evidenceIds: [],
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  }));
}

export function activePhaseGoal(goals: PhaseGoal[]): PhaseGoal | undefined {
  // A blocked goal is the next goal to revisit after the operator resolves its
  // bottleneck; never silently advance past it to a later pending phase.
  return goals.find((goal) => goal.status === "active") ?? goals.find((goal) => goal.status === "blocked") ?? goals.find((goal) => goal.status === "pending");
}

export interface PhaseGoalEvidence {
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
    case "baseline": if (!payloads("baseline.completed").some((payload) => (payload as { exitCode?: unknown }).exitCode === 0)) missing.push("successful baseline"); break;
    case "data_audit": if (!has("data.audit.completed")) missing.push("data audit report"); break;
    case "validation": if (!has("validation.policy.created")) missing.push("versioned validation policy"); break;
    case "hypothesis": if ((evidence.hypotheses + (evidence.candidateHypotheses ?? 0)) < 1) missing.push("durable hypothesis"); if (evidence.experiments < 1 && !has("experiment.created")) missing.push("experiment manifest"); break;
    case "implementation": if (!has("experiment.stage.smoke.completed") && !has("experiment.stage.full_validation.completed")) missing.push("completed implementation or smoke stage"); break;
    case "evaluation": if (!has("experiment.stage.full_validation.completed") || !has("run.completed")) missing.push("completed evaluated run"); break;
    case "replication": if (!has("replication.manifest.created") || evidence.runs < 2) missing.push("independent replication run"); break;
    case "promotion": if (!payloads("experiment.gates.updated").some((payload) => { const value = payload as { leakageAuditPassed?: unknown; reviewerApproved?: unknown }; return value.leakageAuditPassed === true && value.reviewerApproved === true; })) missing.push("approved leakage and reviewer gates"); break;
  }
  return { met: missing.length === 0, missing };
}
