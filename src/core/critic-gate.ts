import type { ResearchDecision } from "./types.js";

export type CriticVerdict = "proceed" | "revise" | "reject";

export interface OpenCriticConstraint {
  verdict: Exclude<CriticVerdict, "proceed">;
  summary: string;
  objections: string[];
  requiredChecks: string[];
}

/** Explain how unresolved criticism constrains final claims without freezing gated phase work. */
export function formatOpenCriticConstraintGuidance(constraint: OpenCriticConstraint): string {
  return `\n\nOPEN CRITIC CONSTRAINT (${constraint.verdict}):\n${constraint.summary}\nObjections: ${constraint.objections.join("; ") || "none listed"}\nRequired checks: ${constraint.requiredChecks.join("; ") || "produce an independent evidence check"}\nKeep these checks visible. They block claims of completion, validation, promotion, or submission, never experiments.`;
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

/**
 * The critic reviews completion claims only. An unresolved objection keeps the
 * goal open and the campaign experimenting; it never blocks an attempt.
 */
export function applyCriticGate(decision: ResearchDecision, review?: { verdict: CriticVerdict }): { decision: ResearchDecision; blocked: boolean } {
  if (!review || review.verdict === "proceed") return { decision, blocked: false };
  return {
    blocked: true,
    decision: {
      ...decision,
      goalStatus: "active",
      decision: decision.decision === "stop" ? "inspect" : decision.decision,
      nextAction: `${decision.nextAction} Critic verdict is ${review.verdict}; the goal stays open: keep experimenting and resolve its objections before claiming completion.`,
    },
  };
}
