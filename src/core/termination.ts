import type { ResearchDecision, ResearchPhase } from "./types.js";
import type { ClaimAuditReport } from "./claim-audit.js";

/** Prevent a model from terminating an active campaign without evidence. */
export function enforceGoalTermination(decision: ResearchDecision, context: { currentPhase?: ResearchPhase } = {}): ResearchDecision {
  if (decision.decision === "stop" && decision.goalStatus === "met" && context.currentPhase && context.currentPhase !== "promotion") {
    return {
      ...decision,
      decision: "inspect",
      goalStatus: "active",
      nextAction: `${decision.nextAction} The campaign cannot terminate before the promotion phase has passed its evidence gates; continue the current phase first.`,
    };
  }
  if (decision.decision !== "stop" || decision.goalStatus === "met") return decision;
  return {
    ...decision,
    decision: "inspect",
    goalStatus: "active",
    nextAction: `${decision.nextAction} The campaign cannot stop while its ultimate goal is still active; gather evidence or identify a real blocker first.`,
  };
}

/** Keep completion claims behind a durable provenance gate. */
export function enforceClaimTermination(decision: ResearchDecision, audit: ClaimAuditReport): ResearchDecision {
  if (decision.decision !== "stop" && decision.goalStatus !== "met") return decision;
  if (audit.total === 0) {
    return {
      ...decision,
      decision: "inspect",
      goalStatus: "active",
      nextAction: `${decision.nextAction} Completion requires at least one durable evidence claim; record evaluator, artifact, observation, or review evidence first.`,
    };
  }
  if (audit.publishable) return decision;
  const blockers = [
    audit.unsupported ? `${audit.unsupported} unsupported` : "",
    audit.conflicted ? `${audit.conflicted} conflicted` : "",
    audit.provisional ? `${audit.provisional} provisional` : "",
    audit.literatureOnly ? `${audit.literatureOnly} literature-only` : "",
  ].filter(Boolean).join(", ");
  return {
    ...decision,
    decision: "inspect",
    goalStatus: "active",
    nextAction: `${decision.nextAction} Claim verification gate rejected completion: ${blockers}. Produce durable workspace evidence or resolve the conflicts before stopping.`,
  };
}
