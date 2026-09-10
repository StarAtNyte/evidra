import type { ResearchDecision } from "./types.js";

/** Prevent a model from terminating an active campaign without evidence. */
export function enforceGoalTermination(decision: ResearchDecision): ResearchDecision {
  if (decision.decision !== "stop" || decision.goalStatus === "met") return decision;
  return {
    ...decision,
    decision: "inspect",
    goalStatus: "active",
    nextAction: `${decision.nextAction} The campaign cannot stop while its ultimate goal is still active; gather evidence or identify a real blocker first.`,
  };
}
