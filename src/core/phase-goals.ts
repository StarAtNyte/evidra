import { PhaseGoalSchema, type PhaseGoal, type ResearchPhase } from "./types.js";

const PHASES: Array<{ phase: ResearchPhase; title: string; objective: string; criteria: string[] }> = [
  { phase: "orientation", title: "Understand the workspace", objective: "Inventory the repository, task, rules, data contract, and execution environment.", criteria: ["repository inventory recorded", "competition configuration loaded", "execution environment checked"] },
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
  return goals.find((goal) => goal.status === "active") ?? goals.find((goal) => goal.status === "pending");
}
