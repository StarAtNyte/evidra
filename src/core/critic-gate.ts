import type { ResearchDecision } from "./types.js";

export type CriticVerdict = "proceed" | "revise" | "reject";

export interface OpenCriticConstraint {
  verdict: Exclude<CriticVerdict, "proceed">;
  summary: string;
  objections: string[];
  requiredChecks: string[];
}

/**
 * Recover the latest unresolved critic request from durable events. The
 * controller deliberately does not rely on the short conversational window:
 * a restart or a busy cycle must not erase a safety-critical objection.
 */
export function latestOpenCriticConstraint(events: Array<{ type: string; payload: unknown }>): OpenCriticConstraint | undefined {
  for (const event of [...events].reverse()) {
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
    const rawReview = event.type === "research.critic.completed" && payload.review && typeof payload.review === "object"
      ? payload.review as Record<string, unknown>
      : event.type === "research.critic.gate" ? payload : undefined;
    if (!rawReview) continue;
    const verdict = rawReview.verdict;
    if (verdict === "proceed") return undefined;
    if (verdict !== "revise" && verdict !== "reject") continue;
    const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 12) : [];
    return {
      verdict,
      summary: typeof rawReview.summary === "string" ? rawReview.summary : "The independent critic left unresolved objections.",
      objections: strings(rawReview.objections),
      requiredChecks: strings(rawReview.requiredChecks),
    };
  }
  return undefined;
}

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
