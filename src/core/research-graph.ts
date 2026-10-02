import { createHash } from "node:crypto";
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

/** Make external score observations citeable without pretending they are literature. */
export function materializeExternalScoreSources(store: ResearchStore): Map<string, string> {
  type ScoreObservation = { id: string; externalId?: string; score: number; platform: string; observedAt: string; externalUrl?: string; bundleId?: string };
  const aliases = new Map<string, string>();
  const latest = new Map<string, ScoreObservation>();
  const byProviderId = new Map<string, string>();
  for (const submission of store.submissions()) {
    const payload = submission.payload && typeof submission.payload === "object" ? submission.payload as Record<string, unknown> : {};
    const receipt = payload.receipt && typeof payload.receipt === "object" ? payload.receipt as Record<string, unknown> : {};
    const providerIds = new Set<string>();
    for (const candidate of [receipt.submissionId, payload.providerSubmissionId, payload.externalId]) {
      if (typeof candidate === "string" && candidate.trim()) providerIds.add(candidate.trim());
    }
    // Command adapters may preserve the provider's receipt text without a
    // normalized ID field. Recover only the explicit "submission id …" form;
    // never infer an ID from a URL or arbitrary receipt prose.
    if (typeof receipt.stdout === "string") {
      for (const match of receipt.stdout.matchAll(/\bsubmission\s+id\s+([A-Za-z0-9_-]+)/gi)) providerIds.add(match[1]);
    }
    for (const providerId of providerIds) byProviderId.set(providerId, submission.id);
    if (submission.status !== "scored" || typeof payload.publicScore !== "number" || !Number.isFinite(payload.publicScore)) continue;
    const externalId = providerIds.values().next().value as string | undefined;
    latest.set(submission.id, {
      id: submission.id,
      ...(externalId ? { externalId } : {}),
      score: payload.publicScore,
      platform: typeof payload.platform === "string" ? payload.platform : "external evaluator",
      observedAt: typeof payload.recordedAt === "string" && Number.isFinite(Date.parse(payload.recordedAt)) ? payload.recordedAt : submission.updatedAt,
      bundleId: submission.id,
    });
  }
  for (const event of store.eventsByTypes(["submission.score.observed", "submission.score.recorded", "submission.score.polled"])) {
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
    if (typeof payload.score !== "number" || !Number.isFinite(payload.score)) continue;
    const externalId = [payload.externalId, payload.providerSubmissionId].find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim();
    const statedId = typeof payload.id === "string" && payload.id.trim() ? payload.id.trim() : externalId;
    if (!statedId) continue;
    const bundleId = store.submissions().find((submission) => submission.id === statedId)?.id
      ?? (externalId ? byProviderId.get(externalId) : undefined);
    const id = bundleId ?? statedId;
    const observedAt = [payload.observedAt, payload.recordedAt, event.createdAt].find((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value))) ?? new Date().toISOString();
    const prior = latest.get(id);
    if (prior && Date.parse(prior.observedAt) > Date.parse(observedAt)) continue;
    // Later score-recorded events often contain only the internal bundle ID.
    // Preserve the provider ID recovered from the receipt instead of erasing
    // the alias when an equally-timestamped event is replayed.
    const resolvedExternalId = externalId ?? prior?.externalId;
    latest.set(id, {
      id,
      ...(resolvedExternalId ? { externalId: resolvedExternalId } : {}),
      score: payload.score,
      platform: typeof payload.platform === "string" ? payload.platform : "external evaluator",
      observedAt,
      ...(typeof payload.sourceUrl === "string" && /^https:\/\//i.test(payload.sourceUrl) ? { externalUrl: payload.sourceUrl } : {}),
      ...(bundleId ? { bundleId } : {}),
    });
  }

  const existing = new Map(store.sources().map((source) => [source.id, source]));
  for (const observation of latest.values()) {
    const url = `https://evidra.local/external-score/${encodeURIComponent(observation.id)}`;
    const contentHash = createHash("sha256").update(JSON.stringify(observation)).digest("hex");
    const prior = existing.get(observation.id);
    const priorPayload = prior?.payload && typeof prior.payload === "object" ? prior.payload as Record<string, unknown> : {};
    if (!prior || priorPayload.sourceType === "external_score") {
      if (priorPayload.contentHash !== contentHash) {
        store.saveSource({
          id: observation.id,
          payload: {
            id: observation.id,
            title: `External score observation · ${observation.platform} · ${observation.id}`,
            url,
            retrievedAt: observation.observedAt,
            contentHash,
            evidenceClass: observation.externalUrl ? "official" : "discovery",
            sourceType: "external_score",
            platform: observation.platform,
            score: observation.score,
            externalId: observation.externalId ?? null,
            externalUrl: observation.externalUrl ?? null,
            bundleId: observation.bundleId ?? null,
            claims: [`${observation.platform} reported external score ${observation.score} for ${observation.externalId ?? observation.id}.`],
          },
        });
      }
      aliases.set(observation.id, observation.id);
    }
    if (observation.externalId && (observation.bundleId || !existing.has(observation.externalId))) {
      aliases.set(observation.externalId, observation.id);
    }
  }
  return aliases;
}

/** Materialize persisted workspace observations as citeable local evidence. */
function materializeResearchObservationSources(store: ResearchStore): Map<string, string> {
  const aliases = new Map<string, string>();
  const existing = new Set(store.sources().map((source) => source.id));
  for (const event of store.eventsByType("research.observation")) {
    const observation = event.payload && typeof event.payload === "object"
      ? event.payload as Record<string, unknown>
      : {};
    const id = typeof observation.sourceId === "string" ? observation.sourceId
      : typeof observation.id === "string" ? observation.id
        : undefined;
    if (!id) continue;
    aliases.set(id, id);
    if (existing.has(id)) continue;
    const serialized = JSON.stringify(observation);
    const claims = [observation.result, observation.summary]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim().slice(0, 2_000));
    store.saveSource({
      id,
      payload: {
        id,
        title: typeof observation.objective === "string"
          ? `Workspace observation · ${observation.objective.slice(0, 180)}`
          : `Workspace observation · ${id}`,
        url: `https://evidra.local/observation/${encodeURIComponent(id)}`,
        retrievedAt: event.createdAt,
        contentHash: createHash("sha256").update(serialized).digest("hex"),
        evidenceClass: "implementation",
        sourceType: "observation",
        observation,
        claims,
      },
    });
    existing.add(id);
  }
  return aliases;
}

/** Turn a validated director decision into durable graph entities. */
export function materializeResearchDecision(store: ResearchStore, value: ResearchDecision, options: { evidenceSourceId?: string; evidenceScope?: string } = {}): MaterializedDecision {
  const parsedDecision = ResearchDecisionSchema.parse(value);
  // Models sometimes refer to durable event families from their context
  // rather than the concrete source ID. Resolve only known aliases from the
  // latest persisted records; all other IDs remain strict and are rejected.
  const latestBaseline = store.eventsByType("baseline.completed").at(-1)?.payload as { runId?: unknown } | undefined;
  const latestObservationEvent = store.eventsByType("research.observation").at(-1);
  const latestObservation = latestObservationEvent?.payload && typeof latestObservationEvent.payload === "object"
    ? latestObservationEvent.payload as { sourceId?: unknown; id?: unknown }
    : undefined;
  const aliases = materializeExternalScoreSources(store);
  for (const [id, sourceId] of materializeResearchObservationSources(store)) aliases.set(id, sourceId);
  if (typeof latestBaseline?.runId === "string") aliases.set("baseline.completed", latestBaseline.runId);
  const latestObservationId = typeof latestObservation?.sourceId === "string" ? latestObservation.sourceId
    : typeof latestObservation?.id === "string" ? latestObservation.id : undefined;
  if (latestObservationId) aliases.set("research.observation", latestObservationId);
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
    const completedRun = run?.status === "completed";
    if (payload.status !== "completed" && !completedRun) continue;
    const metric = completedRun && typeof (run.payload as { metrics?: Record<string, unknown> }).metrics?.metric === "number"
      ? (run.payload as { metrics: { metric: number } }).metrics.metric
      : payload.status === "completed" && typeof payload.metric === "number" ? payload.metric : null;
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
      const primarySource = linkedSourceIds.length ? durableSources.find((source) => source.id === linkedSourceIds[0]) : undefined;
      const sourcePayload = primarySource?.payload && typeof primarySource.payload === "object" ? primarySource.payload as Record<string, unknown> : {};
      const sourceType = sourcePayload.sourceType === "external_score" ? "external_score"
        : sourcePayload.evidenceClass === "implementation" ? "run"
        : sourcePayload.evidenceClass === "official" || sourcePayload.evidenceClass === "discovery" ? "external_source"
        : linkedSourceIds.length ? "literature" : "observation";
      const confidence = sourceType === "literature" ? 0.35 : sourceType === "observation" ? 0.5 : 0.6;
      store.saveClaim({ id: claimId, payload: { id: claimId, statement, scope: options.evidenceScope ?? (linkedSourceIds.length ? "durable evidence source" : "director decision context"), confidence, sourceType, sourceId: linkedSourceIds[0] ?? `decision_${decisionId}`, status: "active" } });
      store.saveEdge({ id: `edge_${claimId}_${hypothesisId}`, fromId: claimId, toId: hypothesisId, relation: "supports", confidence, evidenceIds: [claimId] });
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
