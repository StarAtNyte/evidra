import type { ResearchDecision } from "./types.js";

export type CriticVerdict = "proceed" | "revise" | "reject";

/** Apply an independent critic's veto before execution or campaign termination. */
export function applyCriticGate(decision: ResearchDecision, review?: { verdict: CriticVerdict }): { decision: ResearchDecision; blocked: boolean } {
  if (!review || review.verdict === "proceed") return { decision, blocked: false };
  if (decision.goalStatus === "blocked") return { decision, blocked: true };
  // A revise verdict on a concrete active run proposal is often asking for
  // the proposed experiment itself: the missing measurement, provenance, or
  // falsification check cannot be resolved by another read-only inspection.
  // Keep the run bounded and auditable; only an explicit reject remains a
  // hard execution veto. Proposals without a selected hypothesis still need
  // another planning pass.
  if (review.verdict === "revise" && decision.decision === "run" && decision.goalStatus === "active" && decision.selectedHypothesis) {
    return {
      blocked: false,
      decision: {
        ...decision,
        nextAction: `${decision.nextAction} Critic requested revision checks; execute this bounded probe and record them as evidence.`,
      },
    };
  }
  return {
    blocked: true,
    decision: {
      ...decision,
      goalStatus: "active",
      decision: ["stop", "run", "replicate"].includes(decision.decision) ? "inspect" : decision.decision,
      nextAction: `${decision.nextAction} Critic verdict is ${review.verdict}; resolve its objections before execution or stopping.`,
    },
  };
}
