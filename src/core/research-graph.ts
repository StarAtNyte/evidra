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
  return [hypothesis.title, hypothesis.mechanism, ...(hypothesis.assumptions ?? []), hypothesis.proposedChange, hypothesis.falsificationTest]
    .map((value) => value.trim().toLowerCase().replace(/\s+/g, " "))
    .join("\u001f");
}

/** Turn a validated director decision into durable graph entities. */
export function materializeResearchDecision(store: ResearchStore, value: ResearchDecision, options: { evidenceSourceId?: string; evidenceScope?: string } = {}): MaterializedDecision {
  const parsedDecision = ResearchDecisionSchema.parse(value);
  // Models sometimes refer to durable event families from their context
  // rather than the concrete source ID. Resolve only known aliases from the
  // latest persisted records; all other IDs remain strict and are rejected.
  const latestBaseline = store.eventsByType("baseline.completed").at(-1)?.payload as { runId?: unknown } | undefined;
  const latestObservation = store.eventsByType("research.observation").at(-1)?.payload as { sourceId?: unknown } | undefined;
  const aliases = new Map<string, string>();
  if (typeof latestBaseline?.runId === "string") aliases.set("baseline.completed", latestBaseline.runId);
  if (typeof latestObservation?.sourceId === "string") aliases.set("research.observation", latestObservation.sourceId);
  // Older controllers exposed baseline event timestamps and experiment IDs to
  // the director before materializing them as durable sources. Backfill those
  // execution records on reopen so a resumed campaign cannot crash merely
  // because its context was produced by an older runtime.
  const durableSourcesBeforeExecutionBackfill = store.sources();
  const durableSourceIdsBeforeExecutionBackfill = new Set(durableSourcesBeforeExecutionBackfill.map((source) => source.id));
  for (const event of store.eventsByType("baseline.completed")) {
    const payload = event.payload as { runId?: unknown; metric?: unknown };
    if (typeof payload.runId === "string" && typeof event.createdAt === "string") aliases.set(`baseline-${event.createdAt}`, payload.runId);
  }
  for (const experiment of store.experiments()) {
    if (durableSourceIdsBeforeExecutionBackfill.has(experiment.id)) continue;
    const payload = experiment.payload as { status?: unknown; runId?: unknown; metric?: unknown; title?: unknown };
    const run = typeof payload.runId === "string" ? store.runs().find((entry) => entry.id === payload.runId) : undefined;
    if (payload.status !== "completed" && !run) continue;
    const metric = run && typeof (run.payload as { metrics?: Record<string, unknown> }).metrics?.metric === "number"
      ? (run.payload as { metrics: { metric: number } }).metrics.metric
      : typeof payload.metric === "number" ? payload.metric : null;
    store.saveSource({
      id: experiment.id,
      payload: {
        id: experiment.id,
        title: typeof payload.title === "string" ? payload.title : `Evidra experiment ${experiment.id}`,
        url: `https://evidra.local/experiment/${experiment.id}`,
        retrievedAt: new Date().toISOString(),
        contentHash: experiment.id,
        evidenceClass: "implementation",
        claims: [metric === null ? "Experiment execution record recovered from durable state." : `Experiment metric: ${metric}`],
      },
    });
  }
  // Some older director turns placed a claim ID in evidenceSourceIds. Keep
  // the graph strict by translating only claims that already point to a
  // durable source; never promote an ungrounded claim into a source.
  const durableSourceIdsAfterExecutionBackfill = new Set(store.sources().map((source) => source.id));
  for (const claim of store.claims()) {
    const sourceId = (claim.payload as { sourceId?: unknown }).sourceId;
    if (typeof sourceId !== "string") continue;
    if (sourceId === claim.id && !durableSourceIdsAfterExecutionBackfill.has(claim.id)) {
      const payload = claim.payload as { statement?: unknown; scope?: unknown; confidence?: unknown; sourceType?: unknown };
      store.saveSource({
        id: claim.id,
        payload: {
          id: claim.id,
          title: `Evidra review claim ${claim.id}`,
          url: `https://evidra.local/claim/${claim.id}`,
          retrievedAt: new Date().toISOString(),
          contentHash: claim.id,
          evidenceClass: "review",
          claims: [typeof payload.statement === "string" ? payload.statement : "Recovered durable review claim."],
          scope: payload.scope ?? "research decision review",
          confidence: payload.confidence ?? null,
          sourceType: payload.sourceType ?? "review",
        },
      });
      aliases.set(claim.id, claim.id);
      continue;
    }
    if (durableSourceIdsAfterExecutionBackfill.has(sourceId)) aliases.set(claim.id, sourceId);
  }
  const decision = ResearchDecisionSchema.parse({
    ...parsedDecision,
    hypotheses: parsedDecision.hypotheses.map((hypothesis) => ({
      ...hypothesis,
      evidenceSourceIds: hypothesis.evidenceSourceIds.map((sourceId) => aliases.get(sourceId) ?? sourceId),
    })),
  });
  const durableSources = store.sources();
  const durableSourceIds = new Set(durableSources.map((source) => source.id));
  const supersededSourceIds = new Set(store.edges().filter((edge) => edge.relation === "supersedes").map((edge) => edge.toId));
  for (const hypothesis of decision.hypotheses) {
    const missingSourceIds = (hypothesis.evidenceSourceIds ?? []).filter((sourceId) => !durableSourceIds.has(sourceId));
    if (missingSourceIds.length > 0) throw new Error(`Hypothesis '${hypothesis.title}' cites unknown durable research source(s): ${missingSourceIds.join(", ")}`);
    if (hypothesis.sourceAdaptation) {
      const adaptationSourceIds = [...new Set([...(hypothesis.evidenceSourceIds ?? []), ...(options.evidenceSourceId ? [options.evidenceSourceId] : [])])];
      const staleSourceIds = adaptationSourceIds.filter((sourceId) => supersededSourceIds.has(sourceId) || (durableSources.find((entry) => entry.id === sourceId)?.payload as { status?: unknown } | undefined)?.status === "invalidated");
      if (staleSourceIds.length > 0) throw new Error(`Hypothesis '${hypothesis.title}' adapts superseded or invalidated source(s): ${staleSourceIds.join(", ")}`);
      const withoutClaims = (hypothesis.evidenceSourceIds ?? []).filter((sourceId) => {
        const source = durableSources.find((entry) => entry.id === sourceId);
        const payload = source?.payload && typeof source.payload === "object" ? source.payload as { claims?: unknown } : {};
        return !Array.isArray(payload.claims) || payload.claims.length === 0;
      });
      if (withoutClaims.length > 0) throw new Error(`Hypothesis '${hypothesis.title}' adapts source(s) without retrieved claims: ${withoutClaims.join(", ")}`);
    }
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
      store.saveClaim({ id: claimId, payload: { id: claimId, statement, scope: options.evidenceScope ?? (literature ? "durable literature source" : "director decision context"), confidence: literature ? 0.35 : 0.5, sourceType: literature ? "literature" : "observation", sourceId: linkedSourceIds[0] ?? `decision_${decisionId}`, status: "active" } });
      store.saveEdge({ id: `edge_${claimId}_${hypothesisId}`, fromId: claimId, toId: hypothesisId, relation: "supports", confidence: literature ? 0.35 : 0.5, evidenceIds: [claimId] });
      for (const sourceId of linkedSourceIds) store.saveEdge({ id: `edge_${claimId}_${sourceId}`, fromId: claimId, toId: sourceId, relation: "derived_from", confidence: 0.35, evidenceIds: [claimId] });
    });
  });

  // Preserve deliberate search diversity as graph evidence. This is not a
  // claim that two ideas are incompatible; it records that they explore
  // different formulation families and should not be collapsed into one
  // portfolio slot by downstream schedulers.
  for (let left = 0; left < decision.hypotheses.length; left += 1) {
    const leftFamily = decision.hypotheses[left]?.formulationFamily?.trim();
    if (!leftFamily) continue;
    for (let right = left + 1; right < decision.hypotheses.length; right += 1) {
      const rightFamily = decision.hypotheses[right]?.formulationFamily?.trim();
      if (!rightFamily || rightFamily.toLowerCase() === leftFamily.toLowerCase()) continue;
      const leftId = hypothesisIds[left];
      const rightId = hypothesisIds[right];
      if (leftId === rightId) continue;
      store.saveEdge({
        id: `edge_${decisionId}_${leftId}_${rightId}_diverse`,
        fromId: leftId,
        toId: rightId,
        relation: "diverse_from",
        confidence: 0.8,
        evidenceIds: [],
      });
    }
  }

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
