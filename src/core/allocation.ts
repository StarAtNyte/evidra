import type { TrajectoryQuality } from "./trajectories.js";

export type AllocationFocus = "breadth" | "tool-reliability" | "evidence-validation" | "recovery" | "goal-clarity" | "termination";

export interface AllocationInput {
  trajectories: Array<{ quality: unknown }>;
  phase?: string;
  evidenceConflicts?: { contradictions: number; duplicates: number };
  /** Recent executor failures, kept separate from trajectory quality so the controller can choose a repair route. */
  failureClasses?: string[];
  /** Latest deterministic prediction analysis, when an artifact exposed a concrete failure slice. */
  predictionAnalysis?: { errorRate?: number; worstSlices?: number; worstGroups?: number };
}

export interface ResearchAllocation {
  focus: AllocationFocus;
  priority: "normal" | "high" | "critical";
  strategy: string;
  reasons: string[];
  failedTrajectories: number;
}

function verdict(quality: unknown, key: keyof TrajectoryQuality): string {
  const dimension = (quality as Partial<TrajectoryQuality> | null)?.[key];
  return dimension && typeof dimension === "object" && "verdict" in dimension ? String((dimension as { verdict: string }).verdict) : "NOT_EVALUATED";
}

/** Convert observed trajectory deficiencies into the next research allocation. */
export function allocateNextResearch(input: AllocationInput): ResearchAllocation {
  const contradictions = input.evidenceConflicts?.contradictions ?? 0;
  const duplicates = input.evidenceConflicts?.duplicates ?? 0;
  const failureClasses = input.failureClasses ?? [];
  if (failureClasses.length) {
    const counts = new Map<string, number>();
    for (const failureClass of failureClasses) counts.set(failureClass, (counts.get(failureClass) ?? 0) + 1);
    const [failureClass, count] = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
    const route = failureClass === "data_missing" ? ["evidence-validation", "Refresh the data contract and audit missing inputs before allocating compute."]
      : failureClass === "dependency" ? ["recovery", "Repair or provision the dependency in the selected execution image before retrying."]
        : failureClass === "auth" || failureClass === "rate_limit" ? ["recovery", "Repair provider access or route to the configured alternate provider before retrying."]
          : failureClass === "invalid_metric" || failureClass === "corrupt_artifact" ? ["evidence-validation", "Repair the output contract and run the independent artifact/metric verifier before changing the hypothesis."]
            : failureClass === "cuda_oom" || failureClass === "timeout" || failureClass === "disk" || failureClass === "transient_cloud" ? ["recovery", "Change the resource route or bounded retry policy; do not repeat the same failed execution unchanged."]
              : ["recovery", "Classify and reproduce the failure with one controlled environmental change before selecting another expensive experiment."];
    return {
      focus: route[0] as AllocationFocus,
      priority: count >= 2 ? "critical" : "high",
      failedTrajectories: input.trajectories.filter((entry) => (entry.quality as { overall?: string } | null)?.overall === "FAIL").length,
      strategy: route[1],
      reasons: [`${count} recent run(s) classified as ${failureClass}`, ...(input.phase ? [`active phase: ${input.phase}`] : [])],
    };
  }
  if (contradictions > 0 || duplicates > 0) return {
    focus: "evidence-validation",
    priority: contradictions > 0 ? "critical" : "high",
    failedTrajectories: input.trajectories.filter((entry) => (entry.quality as { overall?: string } | null)?.overall === "FAIL").length,
    strategy: "Resolve conflicting or duplicate evidence with source-level review and an independent falsification check before selecting another expensive experiment.",
    reasons: [`${contradictions} contradiction(s) and ${duplicates} duplicate claim(s) require review`, ...(input.phase ? [`active phase: ${input.phase}`] : [])],
  };
  const predictionAnalysis = input.predictionAnalysis;
  const hasTargetedPredictionFailure = (predictionAnalysis?.worstSlices ?? 0) > 0 || (predictionAnalysis?.worstGroups ?? 0) > 0;
  if (hasTargetedPredictionFailure) return {
    focus: "evidence-validation",
    priority: (predictionAnalysis?.errorRate ?? 0) >= 0.25 ? "critical" : "high",
    failedTrajectories: input.trajectories.filter((entry) => (entry.quality as { overall?: string } | null)?.overall === "FAIL").length,
    strategy: "Target the highest-error prediction slices with a controlled diagnostic or subgroup experiment before changing the global method.",
    reasons: [
      `${predictionAnalysis?.worstSlices ?? 0} worst prediction slice(s) and ${predictionAnalysis?.worstGroups ?? 0} worst group(s) are available`,
      ...(Number.isFinite(predictionAnalysis?.errorRate) ? [`observed error rate ${(predictionAnalysis?.errorRate ?? 0) * 100}%`] : []),
      ...(input.phase ? [`active phase: ${input.phase}`] : []),
    ],
  };
  const quality = input.trajectories.map((entry) => entry.quality);
  const failed = quality.filter((item) => (item as { overall?: string } | null)?.overall === "FAIL").length;
  if (!quality.length) return {
    focus: "breadth", priority: "normal", failedTrajectories: 0,
    strategy: "Establish broad evidence coverage before specializing; inspect the workspace, data, evaluator, and strongest simple baseline.",
    reasons: ["no evaluated trajectories are available yet"],
  };
  const dimensions: Array<[AllocationFocus, keyof TrajectoryQuality, string, string]> = [
    ["tool-reliability", "toolUse", "Replay tool calls with explicit call/result closure and smaller bounded actions.", "tool-call reliability is under-evaluated or failing"],
    ["evidence-validation", "evidenceConsistency", "Add independent checks, provenance, leakage audits, and a second evaluator before promoting claims.", "evidence consistency is weak"],
    ["recovery", "errorRecovery", "Reproduce the failure, vary one environmental factor, and add a bounded retry or alternate route.", "execution failures are not recovering cleanly"],
    ["goal-clarity", "goalAttainment", "Rewrite the phase acceptance criteria into a measurable falsifiable target before running another expensive experiment.", "runs finish without proving the goal"],
    ["termination", "termination", "Repair lifecycle closure: define one terminal outcome, persist it, and verify resume/stop behavior.", "trajectory termination is incomplete or ambiguous"],
  ];
  let selected = dimensions[0];
  let selectedCount = 0;
  for (const candidate of dimensions) {
    const count = quality.filter((item) => ["FAIL", "WARN"].includes(verdict(item, candidate[1]))).length;
    if (count > selectedCount) { selected = candidate; selectedCount = count; }
  }
  if (selectedCount === 0) return {
    focus: "breadth", priority: "normal", failedTrajectories: failed,
    strategy: "Maintain broad coverage and test the next highest-information hypothesis with independent replication.",
    reasons: ["no recurring capability deficiency was observed"],
  };
  return {
    focus: selected[0],
    priority: selectedCount >= 2 || failed >= 2 ? "critical" : "high",
    failedTrajectories: failed,
    strategy: selected[2],
    reasons: [`${selectedCount} recent trajectory(ies): ${selected[3]}`, ...(input.phase ? [`active phase: ${input.phase}`] : [])],
  };
}
