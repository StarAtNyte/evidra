import { ResearchDecisionSchema, type ResearchDecision } from "./types.js";
import { ResearchStore } from "./store.js";
import { createAblationPlan } from "./ablation.js";

export interface MaterializedDecision {
  decisionId: number;
  hypothesisIds: string[];
  claimIds: string[];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "hypothesis";
}

/**
 * Fingerprint the executable idea, not its supporting prose. Evidence can
 * legitimately change between cycles; repeating the same intervention cannot
 * create a new search direction unless the intervention itself changes.
 */
function hypothesisFingerprint(hypothesis: ResearchDecision["hypotheses"][number]): string {
  return [hypothesis.title, hypothesis.mechanism, hypothesis.proposedChange, hypothesis.falsificationTest]
    .map((value) => value.trim().toLowerCase().replace(/\s+/g, " "))
    .join("\u001f");
}

/** Turn a validated director decision into durable graph entities. */
export function materializeResearchDecision(store: ResearchStore, value: ResearchDecision, options: { evidenceSourceId?: string; evidenceScope?: string } = {}): MaterializedDecision {
  const decision = ResearchDecisionSchema.parse(value);
  const durableSourceIds = new Set(store.sources().map((source) => source.id));
  for (const hypothesis of decision.hypotheses) {
    const missingSourceIds = (hypothesis.evidenceSourceIds ?? []).filter((sourceId) => !durableSourceIds.has(sourceId));
    if (missingSourceIds.length > 0) throw new Error(`Hypothesis '${hypothesis.title}' cites unknown durable research source(s): ${missingSourceIds.join(", ")}`);
  }
  const decisionId = store.saveDecision(decision);
  const stamp = `${Date.now()}_${decisionId}`;
  const hypothesisIds: string[] = [];
  const claimIds: string[] = [];
  const priorHypotheses = store.hypotheses();
  const fingerprints = new Map<string, string>();
  for (const entry of priorHypotheses) {
    const payload = entry.payload as { fingerprint?: unknown; title?: unknown; mechanism?: unknown; proposedChange?: unknown; falsificationTest?: unknown };
    if (typeof payload.fingerprint === "string") fingerprints.set(payload.fingerprint, entry.id);
    else if ([payload.title, payload.mechanism, payload.proposedChange, payload.falsificationTest].every((value) => typeof value === "string")) {
      fingerprints.set(hypothesisFingerprint({ title: payload.title as string, mechanism: payload.mechanism as string, proposedChange: payload.proposedChange as string, falsificationTest: payload.falsificationTest as string } as ResearchDecision["hypotheses"][number]), entry.id);
    }
  }

  decision.hypotheses.forEach((hypothesis, index) => {
    const fingerprint = hypothesisFingerprint(hypothesis);
    const duplicateOf = fingerprints.get(fingerprint);
    const hypothesisId = duplicateOf ?? `hyp_${stamp}_${String(index + 1).padStart(2, "0")}_${slug(hypothesis.title)}`;
    hypothesisIds.push(hypothesisId);
    if (duplicateOf) {
      store.appendEvent("research.hypothesis.deduplicated", { decisionId, hypothesisId, duplicateOf, fingerprint, title: hypothesis.title });
    } else {
      fingerprints.set(fingerprint, hypothesisId);
      store.saveHypothesis({ id: hypothesisId, payload: { id: hypothesisId, ...hypothesis, fingerprint, searchOperator: decision.searchOperator, status: "proposed", decisionId } });
    }
    if (!duplicateOf && hypothesis.ablationFactors.length > 0) {
      store.appendEvent("research.ablation.plan", createAblationPlan({ hypothesisId, factors: hypothesis.ablationFactors }));
    }
    const linkedSourceIds = [
      ...(hypothesis.evidenceSourceIds ?? []).filter((sourceId) => durableSourceIds.has(sourceId)),
      ...(options.evidenceSourceId && durableSourceIds.has(options.evidenceSourceId) ? [options.evidenceSourceId] : []),
    ].filter((sourceId, sourceIndex, sourceIds) => sourceIds.indexOf(sourceId) === sourceIndex);
    hypothesis.evidence.forEach((statement, evidenceIndex) => {
      const claimId = `claim_${stamp}_${String(index + 1).padStart(2, "0")}_${evidenceIndex + 1}`;
      claimIds.push(claimId);
      const literature = linkedSourceIds.length > 0;
      store.saveClaim({ id: claimId, payload: { id: claimId, statement, scope: options.evidenceScope ?? (literature ? "durable literature source" : "director decision context"), confidence: literature ? 0.35 : 0.5, sourceType: literature ? "literature" : "observation", sourceId: linkedSourceIds[0] ?? decisionId.toString(), status: "active" } });
      store.saveEdge({ id: `edge_${claimId}_${hypothesisId}`, fromId: claimId, toId: hypothesisId, relation: "supports", confidence: literature ? 0.35 : 0.5, evidenceIds: [claimId] });
      for (const sourceId of linkedSourceIds) store.saveEdge({ id: `edge_${claimId}_${sourceId}`, fromId: claimId, toId: sourceId, relation: "derived_from", confidence: 0.35, evidenceIds: [claimId] });
    });
  });

  // Evolutionary offspring must point only to hypotheses materialized in this
  // decision or an earlier durable decision. Unknown IDs are ignored rather
  // than allowing model text to manufacture graph ancestry.
  const durableHypothesisIds = new Set(store.hypotheses().map((entry) => entry.id));
  decision.hypotheses.forEach((hypothesis, index) => {
    const hypothesisId = hypothesisIds[index];
    for (const parentId of hypothesis.parentHypothesisIds ?? []) {
      if (parentId === hypothesisId || !durableHypothesisIds.has(parentId)) continue;
      store.saveEdge({ id: `edge_${hypothesisId}_${parentId}`, fromId: hypothesisId, toId: parentId, relation: "depends_on", confidence: 0.8, evidenceIds: [] });
    }
  });

  const selected = decision.hypotheses.find((hypothesis) => hypothesis.title === decision.selectedHypothesis);
  if (selected) {
    const selectedId = hypothesisIds[decision.hypotheses.indexOf(selected)];
    store.saveEdge({ id: `edge_decision_${decisionId}_${selectedId}`, fromId: `decision_${decisionId}`, toId: selectedId, relation: "supports", confidence: 0.6, evidenceIds: claimIds });
  }
  return { decisionId, hypothesisIds, claimIds };
}
