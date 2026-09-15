import type { ResearchDecision, ResearchPhase } from "./types.js";

export type DecisionAuditVerdict = "pass" | "revise" | "reject";

export interface DecisionAuditInput {
  currentPhase?: ResearchPhase;
  durableEventTypes?: ReadonlySet<string>;
  phaseAuditComplete?: boolean;
}

export interface DecisionAuditResult {
  verdict: DecisionAuditVerdict;
  summary: string;
  reasons: string[];
  requiredChecks: string[];
  evidence: string[];
}

/**
 * Controller-owned checks for a director decision. This intentionally does not
 * inspect the director's rationale: the audit is independent of persuasive
 * prose and only uses typed decisions plus durable evidence supplied by the
 * controller.
 */
export function auditResearchDecision(
  decision: Pick<ResearchDecision, "phase" | "decision" | "goalStatus" | "selectedHypothesis" | "hypotheses" | "toolCalls">,
  input: DecisionAuditInput = {},
): DecisionAuditResult {
  const reasons: string[] = [];
  const requiredChecks: string[] = [];
  const evidence: string[] = [];
  if (input.currentPhase && decision.phase !== input.currentPhase) reasons.push(`decision phase ${decision.phase} does not match active phase ${input.currentPhase}`);
  if (decision.decision === "run" && !decision.selectedHypothesis?.trim()) reasons.push("run decision has no selected hypothesis");
  if (decision.decision === "propose" && decision.hypotheses.length === 0) reasons.push("propose decision contains no hypothesis");
  if (decision.decision === "stop" && decision.goalStatus !== "met" && decision.goalStatus !== "blocked") reasons.push("stop decision is not backed by a met or blocked goal");
  if (decision.goalStatus === "met") {
    if (input.phaseAuditComplete === false) reasons.push("goal is marked met while the phase audit is incomplete");
    else if (input.phaseAuditComplete === true) evidence.push("subtask.audit:complete");
    else requiredChecks.push("durable phase audit");
  }
  const eventTypes = input.durableEventTypes;
  if (decision.decision === "run" && eventTypes && !eventTypes.has("hypothesis.created") && decision.hypotheses.length === 0) requiredChecks.push("durable hypothesis evidence");
  if (decision.toolCalls.some((call) => !call.name.trim())) reasons.push("decision contains a blank tool call name");
  if (reasons.length) return { verdict: "reject", summary: "Decision rejected by the controller-owned audit.", reasons, requiredChecks, evidence };
  if (requiredChecks.length) return { verdict: "revise", summary: "Decision requires durable evidence before it can proceed.", reasons, requiredChecks, evidence };
  return { verdict: "pass", summary: "Typed decision checks and available evidence passed.", reasons, requiredChecks, evidence };
}

/** Safely turn an unaudited execution/completion request into inspection. */
export function downgradeUnauditedDecision<T extends Pick<ResearchDecision, "decision" | "goalStatus" | "nextAction">>(decision: T, audit: DecisionAuditResult): T {
  if (audit.verdict === "pass") return decision;
  return {
    ...decision,
    decision: "inspect",
    goalStatus: "active",
    nextAction: `${decision.nextAction} (controller audit: ${[...audit.reasons, ...audit.requiredChecks].join(", ")})`,
  };
}
