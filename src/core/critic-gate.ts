import type { ResearchDecision } from "./types.js";

export type CriticVerdict = "proceed" | "revise" | "reject";

/** Apply an independent critic's veto before execution or campaign termination. */
export function applyCriticGate(decision: ResearchDecision, review?: { verdict: CriticVerdict }): { decision: ResearchDecision; blocked: boolean } {
  if (!review || review.verdict === "proceed") return { decision, blocked: false };
  if (decision.goalStatus === "blocked") return { decision, blocked: true };
  // A revise verdict means the critic identified unresolved evidence,
  // provenance, or falsification checks. Never execute the proposal while
  // those checks are merely described in prose; the next cycle must inspect
  // them and produce durable evidence before execution or termination.
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
