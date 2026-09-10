import type { ResearchDecision } from "./types.js";
import type { ClaimAuditReport } from "./claim-audit.js";

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

/** Keep completion claims behind a durable provenance gate. */
export function enforceClaimTermination(decision: ResearchDecision, audit: ClaimAuditReport): ResearchDecision {
  if ((decision.decision !== "stop" && decision.goalStatus !== "met") || audit.total === 0 || audit.publishable) return decision;
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
