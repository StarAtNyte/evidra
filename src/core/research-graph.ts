import { ResearchDecisionSchema, type ResearchDecision } from "./types.js";
import { ResearchStore } from "./store.js";

export interface MaterializedDecision {
  decisionId: number;
  hypothesisIds: string[];
  claimIds: string[];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "hypothesis";
}

/** Turn a validated director decision into durable graph entities. */
export function materializeResearchDecision(store: ResearchStore, value: ResearchDecision, options: { evidenceSourceId?: string; evidenceScope?: string } = {}): MaterializedDecision {
  const decision = ResearchDecisionSchema.parse(value);
  const decisionId = store.saveDecision(decision);
  const stamp = `${Date.now()}_${decisionId}`;
  const hypothesisIds: string[] = [];
  const claimIds: string[] = [];

  decision.hypotheses.forEach((hypothesis, index) => {
    const hypothesisId = `hyp_${stamp}_${String(index + 1).padStart(2, "0")}_${slug(hypothesis.title)}`;
    hypothesisIds.push(hypothesisId);
    store.saveHypothesis({ id: hypothesisId, payload: { id: hypothesisId, ...hypothesis, searchOperator: decision.searchOperator, status: "proposed", decisionId } });
    hypothesis.evidence.forEach((statement, evidenceIndex) => {
      const claimId = `claim_${stamp}_${String(index + 1).padStart(2, "0")}_${evidenceIndex + 1}`;
      claimIds.push(claimId);
      const literature = Boolean(options.evidenceSourceId);
      store.saveClaim({ id: claimId, payload: { id: claimId, statement, scope: options.evidenceScope ?? "director decision context", confidence: literature ? 0.35 : 0.5, sourceType: literature ? "literature" : "observation", sourceId: options.evidenceSourceId ?? decisionId.toString(), status: "active" } });
      store.saveEdge({ id: `edge_${claimId}_${hypothesisId}`, fromId: claimId, toId: hypothesisId, relation: "supports", confidence: literature ? 0.35 : 0.5, evidenceIds: [claimId] });
      if (options.evidenceSourceId) {
        store.saveEdge({ id: `edge_${claimId}_${options.evidenceSourceId}`, fromId: claimId, toId: options.evidenceSourceId, relation: "derived_from", confidence: 0.35, evidenceIds: [claimId] });
      }
    });
  });

  const selected = decision.hypotheses.find((hypothesis) => hypothesis.title === decision.selectedHypothesis);
  if (selected) {
    const selectedId = hypothesisIds[decision.hypotheses.indexOf(selected)];
    store.saveEdge({ id: `edge_decision_${decisionId}_${selectedId}`, fromId: `decision_${decisionId}`, toId: selectedId, relation: "supports", confidence: 0.6, evidenceIds: claimIds });
  }
  return { decisionId, hypothesisIds, claimIds };
}
