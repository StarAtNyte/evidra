import type { ResearchDecision } from "./types.js";

export interface StagnationResult {
  stagnant: boolean;
  cycles: number;
  signature: string;
}

export function decisionSignature(decision: Pick<ResearchDecision, "phase" | "decision" | "bottleneck" | "selectedHypothesis" | "nextAction">): string {
  return [decision.phase, decision.decision, decision.bottleneck, decision.selectedHypothesis ?? "none", decision.nextAction]
    .map((value) => value.trim().toLowerCase().replace(/\s+/g, " ")).join("|");
}

/** Detect repeated active decisions without treating a new experiment or phase as stagnation. */
export function detectStagnation(decisions: Array<Pick<ResearchDecision, "phase" | "decision" | "bottleneck" | "selectedHypothesis" | "nextAction" | "goalStatus">>, threshold = 3): StagnationResult {
  const required = Math.max(2, Math.min(threshold, 10));
  const recent = decisions.slice(0, required);
  if (recent.length < required || recent.some((decision) => decision.goalStatus !== "active" || decision.decision === "run" || decision.decision === "replicate")) return { stagnant: false, cycles: recent.length, signature: recent[0] ? decisionSignature(recent[0]) : "" };
  const signature = decisionSignature(recent[0]);
  return { stagnant: recent.every((decision) => decisionSignature(decision) === signature), cycles: recent.length, signature };
}
