import type { ResearchDecision } from "./types.js";

export interface StagnationResult {
  stagnant: boolean;
  cycles: number;
  signature: string;
}

export function decisionSignature(decision: Pick<ResearchDecision, "phase" | "decision" | "bottleneck" | "selectedHypothesis" | "nextAction">): string {
  return [decision.phase, decision.decision, decision.bottleneck, decision.selectedHypothesis ?? "none", decision.nextAction]
    .map((value) => value.trim().toLowerCase().replace(/\s+/g, " ")).join("|");
}

/** Stable research intent for common inspection loops whose prose keeps changing. */
export function decisionIntentSignature(decision: Pick<ResearchDecision, "phase" | "decision" | "bottleneck" | "selectedHypothesis" | "nextAction">): string | undefined {
  if (decision.decision !== "inspect") return undefined;
  const text = `${decision.bottleneck} ${decision.selectedHypothesis ?? ""} ${decision.nextAction}`.toLowerCase();
  const intent = /(?:fail(?:ure|ed)?|error|crash|unknown).{0,100}(?:run|evaluat|runner|estimator|input|telemetry|log)|(?:run|evaluat|runner|estimator|input|telemetry|log).{0,100}(?:fail(?:ure|ed)?|error|crash|unknown)/.test(text)
    ? "failure-provenance"
    : /(?:data|dataset|parquet).{0,100}(?:audit|leak|duplicat|integrity|schema|hash)|(?:audit|leak|duplicat|integrity|schema|hash).{0,100}(?:data|dataset|parquet)/.test(text)
      ? "data-integrity"
      : undefined;
  return intent ? `${decision.phase}|inspect|${intent}` : undefined;
}

/** Detect repeated active decisions without treating a new experiment or phase as stagnation. */
export function detectStagnation(decisions: Array<Pick<ResearchDecision, "phase" | "decision" | "bottleneck" | "selectedHypothesis" | "nextAction" | "goalStatus">>, threshold = 3): StagnationResult {
  const required = Math.max(2, Math.min(threshold, 10));
  const recent = decisions.slice(0, required);

  // Exact prose signatures miss a common agent loop: the controller explicitly
  // tells the director that a read-only request returned the same observation,
  // but the director rewrites its hypothesis/action and asks to inspect again.
  // Two consecutive inspect decisions carrying that explicit no-new-evidence
  // signal are stronger evidence of a loop than lexical similarity is. Trigger
  // the existing diversify-then-pause recovery without classifying ordinary
  // multi-step research inspections as stagnant.
  const noNewEvidence = /(?:same\s+(?:observation|result|output).{0,100}(?:earlier|previous|prior)|no\s+new\s+evidence|unchanged\s+(?:observation|result|output))/i;
  const repeatedNoEvidence = decisions.slice(0, 2);
  if (repeatedNoEvidence.length === 2
      && repeatedNoEvidence.every((decision) => decision.goalStatus === "active"
        && decision.decision === "inspect"
        && decision.phase === repeatedNoEvidence[0]!.phase
        && noNewEvidence.test(decision.nextAction))) {
    return { stagnant: true, cycles: 2, signature: `${repeatedNoEvidence[0]!.phase}|inspect|explicit-no-new-evidence` };
  }

  if (recent.length < required || recent.some((decision) => decision.goalStatus !== "active" || decision.decision === "run" || decision.decision === "replicate")) return { stagnant: false, cycles: recent.length, signature: recent[0] ? decisionSignature(recent[0]) : "" };

  // Inspectors can paraphrase the same unresolved failure/data audit on every
  // retry. Once the full window carries the same concrete intent, force the
  // existing diversify-then-pause recovery rather than waiting for exact
  // prose to repeat. Distinct topics and phases remain independent searches.
  const intent = decisionIntentSignature(recent[0]!);
  if (intent && recent.every((decision) => decisionIntentSignature(decision) === intent)) {
    return { stagnant: true, cycles: recent.length, signature: intent };
  }

  const signature = decisionSignature(recent[0]);
  return { stagnant: recent.every((decision) => decisionSignature(decision) === signature), cycles: recent.length, signature };
}
