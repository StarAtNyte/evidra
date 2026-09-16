export interface HypothesisQualityInput {
  title: string;
  mechanism: string;
  assumptions?: string[];
  evidence: string[];
  proposedChange: string;
  falsificationTest: string;
  expectedDelta: number;
  costGpuHours: number;
  implementationRisk: "low" | "medium" | "high";
  leakageRisk: "low" | "medium" | "high";
}

export interface HypothesisQuality {
  score: number;
  verdict: "strong" | "usable" | "weak";
  reasons: string[];
}

/** Score structural experiment quality without pretending to judge truth. */
export function assessHypothesisQuality(input: HypothesisQualityInput): HypothesisQuality {
  const reasons: string[] = [];
  let score = 0;
  if (input.title.trim().length >= 8) score += 0.1; else reasons.push("hypothesis title is underspecified");
  if (input.mechanism.trim().length >= 24) score += 0.18; else reasons.push("mechanism needs a concrete causal explanation");
  if ((input.assumptions ?? []).some((assumption) => assumption.trim().length > 0)) score += 0.05;
  else reasons.push("validity assumptions are not explicit");
  if (input.proposedChange.trim().length >= 16) score += 0.18; else reasons.push("proposed change is not concrete enough to implement");
  if (input.falsificationTest.trim().length >= 20) score += 0.2; else reasons.push("falsification test is missing or non-operational");
  if (input.evidence.length > 0) score += 0.14; else reasons.push("no supporting observation or source was attached");
  if (Number.isFinite(input.expectedDelta)) score += Math.min(0.1, Math.abs(input.expectedDelta)); else reasons.push("expected delta is not finite");
  if (Number.isFinite(input.costGpuHours) && input.costGpuHours >= 0) score += 0.05; else reasons.push("compute cost is invalid");
  if (input.implementationRisk !== "high") score += 0.03;
  if (input.leakageRisk === "low") score += 0.02;
  const bounded = Math.max(0, Math.min(1, score));
  return { score: bounded, verdict: bounded >= 0.75 ? "strong" : bounded >= 0.5 ? "usable" : "weak", reasons };
}
