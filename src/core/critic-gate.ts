import { ResearchHypothesisSchema, type ResearchDecision } from "./types.js";

type ResearchHypothesis = ResearchDecision["hypotheses"][number];

export type CriticVerdict = "proceed" | "revise" | "reject";

export interface OpenCriticConstraint {
  verdict: Exclude<CriticVerdict, "proceed">;
  summary: string;
  objections: string[];
  requiredChecks: string[];
}

/**
 * In autonomous modes, honor an explicit bounded-exploration recommendation
 * even if the director mislabeled its selected, falsifiable run as `inspect`.
 * This never clears critic objections or permits promotion/submission.
 */
export function promoteExplicitExploratoryRun(
  decision: ResearchDecision,
  review: { verdict: CriticVerdict; summary?: string } | undefined,
  canRunIsolatedExperiments: boolean,
): { decision: ResearchDecision; promoted: boolean } {
  if (!canRunIsolatedExperiments || review?.verdict !== "revise" || !/exploratory/i.test(review.summary ?? "")) {
    return { decision, promoted: false };
  }
  if (decision.decision !== "inspect" || decision.goalStatus !== "active" || !decision.selectedHypothesis) {
    return { decision, promoted: false };
  }
  const selected = decision.hypotheses.find((hypothesis) => hypothesis.title === decision.selectedHypothesis);
  if (!selected?.falsificationTest.trim()
    || !/exploratory/i.test(decision.rationale)
    || !/\brun\b/i.test(decision.nextAction)) {
    return { decision, promoted: false };
  }
  return {
    promoted: true,
    decision: {
      ...decision,
      decision: "run",
      nextAction: `${decision.nextAction} Evidra is honoring the explicit exploratory recommendation; unresolved critic objections still block validation, promotion, and submission.`,
    },
  };
}

/**
 * Turn an explicit operator instruction to continue with an isolated
 * exploratory experiment into an executable choice when the director is
 * looping on validation-only hypotheses. This is deliberately narrower than
 * general autonomy: it requires an active goal, non-rejecting critic, an
 * experiment-permitting steering message, and a durable, falsifiable,
 * non-audit proposal that has not already been scheduled. Validation and
 * external-action gates remain unchanged.
 */
export function promoteOperatorSteeredExploration(
  decision: ResearchDecision,
  review: { verdict: CriticVerdict } | undefined,
  canRunIsolatedExperiments: boolean,
  steering: string[],
  durableHypotheses: Array<{ id: string; payload: unknown }>,
  scheduledHypothesisIds: Set<string> = new Set(),
): { decision: ResearchDecision; promoted: boolean; hypothesisId?: string } {
  const instruction = steering.join("\n");
  const explicitlyRequestsExploration = /\b(?:isolated|bounded|exploratory)\b.{0,120}\bexperiment\b/i.test(instruction)
    && /\b(?:blockers?|uncertainties?)\b.{0,120}\b(?:validation|promotion|submission)\b.{0,30}\bonly\b|\bdo not block\b.{0,120}\bexperiment\b/i.test(instruction);
  if (!explicitlyRequestsExploration || !canRunIsolatedExperiments || review?.verdict === "reject" || decision.goalStatus !== "active") {
    return { decision, promoted: false };
  }

  const selectedIsExperiment = decision.hypotheses.find((hypothesis) =>
    hypothesis.title === decision.selectedHypothesis
      && !/^(?:data|validation|audit)$/i.test(hypothesis.formulationFamily)
      && hypothesis.falsificationTest.trim().length > 0,
  );
  let candidate: ResearchHypothesis | undefined = selectedIsExperiment;
  let candidateId: string | undefined;
  if (!candidate) {
    const stored = durableHypotheses.find((entry) => {
      if (scheduledHypothesisIds.has(entry.id)) return false;
      const payload = entry.payload && typeof entry.payload === "object" ? entry.payload as Record<string, unknown> : {};
      if (payload.status !== "proposed") return false;
      const parsed = ResearchHypothesisSchema.safeParse(payload);
      return parsed.success
        && !/^(?:data|validation|audit)$/i.test(parsed.data.formulationFamily)
        && parsed.data.falsificationTest.trim().length > 0
        && parsed.data.proposedChange.trim().length > 0;
    });
    if (stored) {
      const parsed = ResearchHypothesisSchema.safeParse(stored.payload);
      if (parsed.success) {
        candidate = parsed.data;
        candidateId = stored.id;
      }
    }
  }
  if (!candidate || decision.decision === "run") return { decision, promoted: false };

  const hypotheses = decision.hypotheses.filter((hypothesis) =>
    !/^(?:data|validation|audit)$/i.test(hypothesis.formulationFamily),
  ).slice(0, 4);
  if (!hypotheses.some((hypothesis) => hypothesis.title === candidate?.title)) hypotheses.push(candidate);
  return {
    promoted: true,
    ...(candidateId ? { hypothesisId: candidateId } : {}),
    decision: {
      ...decision,
      decision: "run",
      hypotheses,
      selectedHypothesis: candidate.title,
      rationale: `${decision.rationale} The operator explicitly authorized this isolated exploratory experiment; unresolved validation, promotion, and submission checks remain open.`,
      nextAction: `Run the falsifiable proposal '${candidate.title}' in an isolated experiment; preserve all outcomes and keep unresolved checks as blockers to validation, promotion, and submission.`,
    },
  };
}

/** Explain how unresolved criticism constrains final claims without freezing gated phase work. */
export function formatOpenCriticConstraintGuidance(constraint: OpenCriticConstraint): string {
  return `\n\nOPEN CRITIC CONSTRAINT (${constraint.verdict}):\n${constraint.summary}\nObjections: ${constraint.objections.join("; ") || "none listed"}\nRequired checks: ${constraint.requiredChecks.join("; ") || "produce an independent evidence check"}\nKeep unresolved checks visible. A bounded internal phase goal may be marked met only when its own deterministic domain gate and durable subtask audit pass; that is not a claim that the ultimate objective or candidate is complete or validated. Do not claim ultimate-goal completion, final-candidate validation, promotion, or submission until the relevant checks are resolved. A revise verdict permits bounded exploratory execution only when the selected hypothesis has an explicit falsification test; label it exploratory and preserve the open limitations. An explicit reject verdict still blocks execution.`;
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
  // "Revise" holds claims of completion, promotion, or submission, but must
  // not deadlock a campaign that can make safe empirical progress. Permit a
  // bounded exploratory run only when it is tied to a selected, explicitly
  // falsifiable hypothesis. The unresolved critic checks remain attached to
  // the decision as a limitation; validation gates still control acceptance.
  if (review.verdict === "revise" && decision.decision === "run" && decision.selectedHypothesis) {
    const selected = decision.hypotheses.find((hypothesis) => hypothesis.title === decision.selectedHypothesis);
    if (selected?.falsificationTest.trim()) {
      return {
        blocked: false,
        decision: {
          ...decision,
          nextAction: `${decision.nextAction} Exploratory run only: critic revision remains open; do not claim validation, promotion, or submission until its checks are resolved.`,
        },
      };
    }
  }
  // Explicit rejection remains a veto. A revise verdict also prevents
  // unsupported stopping or unfalsifiable execution.
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
