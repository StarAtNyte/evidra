import type { ResearchDecision } from "./types.js";

export interface RubricCriterion {
  id: string;
  title: string;
  weight: number;
  score: number;
  rationale: string;
  required: boolean;
}

export interface ResearchRubricContext {
  baselineAvailable?: boolean;
  sourceCount?: number;
  evidenceConflicts?: number;
}

export interface ResearchRubricAssessment {
  score: number;
  threshold: number;
  verdict: "strong" | "usable" | "weak";
  criteria: RubricCriterion[];
  gaps: string[];
}

function bounded(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Evaluate the research decision contract before spending compute.
 * This is deliberately deterministic and evidence-shaped: it grades the
 * decision structure, not the model's prose or confidence.
 */
export function assessResearchDecisionRubric(decision: ResearchDecision, context: ResearchRubricContext = {}): ResearchRubricAssessment {
  const hypotheses = decision.hypotheses;
  const executable = decision.decision === "run" || decision.decision === "replicate";
  const completeHypotheses = hypotheses.filter((hypothesis) =>
    hypothesis.mechanism.trim() && hypothesis.proposedChange.trim() && hypothesis.falsificationTest.trim()).length;
  const families = new Set(hypotheses.map((hypothesis) => hypothesis.formulationFamily));
  const evidenceCount = hypotheses.reduce((sum, hypothesis) => sum + hypothesis.evidence.length, 0);
  const criteria: RubricCriterion[] = [
    {
      id: "action-closure",
      title: "Action closure",
      weight: 0.2,
      score: bounded(decision.nextAction.trim().length > 8 ? 1 : 0),
      rationale: decision.nextAction.trim().length > 8 ? "The next action is concrete." : "The next action is missing or too vague.",
      required: true,
    },
    {
      id: "falsifiability",
      title: "Falsifiable hypotheses",
      weight: 0.2,
      score: hypotheses.length ? completeHypotheses / hypotheses.length : decision.decision === "inspect" ? 1 : 0,
      rationale: hypotheses.length ? `${completeHypotheses}/${hypotheses.length} hypotheses contain mechanism, change, and falsification.` : "No hypotheses are required for an inspection decision.",
      required: executable || decision.decision === "propose",
    },
    {
      id: "evidence",
      title: "Evidence grounding",
      weight: 0.2,
      score: bounded((evidenceCount > 0 ? 0.6 : 0) + (context.baselineAvailable ? 0.25 : 0) + (context.sourceCount && context.sourceCount > 0 ? 0.15 : 0)),
      rationale: evidenceCount || context.baselineAvailable || context.sourceCount ? "The decision has observable evidence or source context." : "No baseline, source, or hypothesis evidence is attached.",
      required: executable || decision.decision === "propose",
    },
    {
      id: "verification",
      title: "Verification contract",
      weight: 0.2,
      score: hypotheses.length ? hypotheses.filter((hypothesis) => hypothesis.outcomeType !== "metric" ? Boolean(hypothesis.expectedOutcome) : Number.isFinite(hypothesis.expectedMetricDelta.median)).length / hypotheses.length : decision.decision === "inspect" ? 1 : 0,
      rationale: hypotheses.length ? "Each hypothesis declares a measurable or explicitly verifiable outcome." : "Inspection has no candidate outcome to verify.",
      required: executable || decision.decision === "propose",
    },
    {
      id: "diversity",
      title: "Formulation diversity",
      weight: 0.1,
      score: hypotheses.length ? bounded(families.size / Math.min(3, hypotheses.length)) : 1,
      rationale: `${families.size} formulation family/families are represented.`,
      required: hypotheses.length > 1,
    },
    {
      id: "risk-awareness",
      title: "Risk and conflict awareness",
      weight: 0.1,
      score: context.evidenceConflicts && context.evidenceConflicts > 0
        ? (decision.searchOperator === "audit" || decision.phase === "validation" ? 1 : 0.25)
        : hypotheses.length ? bounded(hypotheses.reduce((sum, hypothesis) => sum + (hypothesis.leakageRisk === "low" ? 1 : hypothesis.leakageRisk === "medium" ? 0.6 : 0.2), 0) / hypotheses.length) : 1,
      rationale: context.evidenceConflicts && context.evidenceConflicts > 0 ? "Conflicting evidence requires audit or validation before exploitation." : "Candidate risks are explicitly represented.",
      required: context.evidenceConflicts !== undefined && context.evidenceConflicts > 0,
    },
  ];
  const score = criteria.reduce((sum, criterion) => sum + criterion.score * criterion.weight, 0);
  const gaps = criteria.filter((criterion) => criterion.required && criterion.score < 0.7).map((criterion) => `${criterion.title}: ${criterion.rationale}`);
  const threshold = 0.7;
  return { score, threshold, verdict: score >= threshold ? "strong" : score >= 0.5 ? "usable" : "weak", criteria, gaps };
}
