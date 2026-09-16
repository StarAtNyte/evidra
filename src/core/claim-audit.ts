export type ClaimAuditStatus = "verified" | "provisional" | "literature_only" | "unsupported" | "conflicted";

export interface ClaimAuditEntry {
  id: string;
  statement: string;
  status: ClaimAuditStatus;
  confidence: number;
  sourceType: string;
  sourceId: string;
  reasons: string[];
}

export interface ClaimAuditReport {
  total: number;
  verified: number;
  provisional: number;
  literatureOnly: number;
  unsupported: number;
  conflicted: number;
  publishable: boolean;
  entries: ClaimAuditEntry[];
}

export interface ClaimAuditInput {
  claims: Array<{ id: string; payload: unknown }>;
  /** IDs of durable objects that can substantiate a claim's sourceId. */
  knownEvidenceIds: Set<string>;
  /** Controller-derived source IDs whose durable object is literature, regardless of model labels. */
  literatureEvidenceIds?: Set<string>;
  /** Claim IDs participating in contradiction edges. */
  conflictedClaimIds?: Set<string>;
}

/** Evidence IDs embedded in durable claim payloads, such as lane observations. */
export function selfDescribingClaimEvidenceIds(claims: Array<{ payload: unknown }>): Set<string> {
  const ids = new Set<string>();
  for (const claim of claims) {
    const payload = claim.payload && typeof claim.payload === "object" ? claim.payload as { sourceId?: unknown; observation?: unknown; findings?: unknown; evidence?: unknown } : {};
    const sourceId = typeof payload.sourceId === "string" ? payload.sourceId : "";
    const durableObservation = Boolean(payload.observation && typeof payload.observation === "object");
    const durableLaneReport = Array.isArray(payload.findings) && Array.isArray(payload.evidence);
    if (sourceId && (durableObservation || durableLaneReport)) ids.add(sourceId);
  }
  return ids;
}

/**
 * Audit claims without asking a model to decide whether its own prose is true.
 * Literature is useful for hypothesis generation but never counts as measured
 * workspace evidence; contradictions always override a positive status.
 */
export function auditClaims(input: ClaimAuditInput): ClaimAuditReport {
  const entries = input.claims.map(({ id, payload }): ClaimAuditEntry => {
    const value = payload && typeof payload === "object" ? payload as { statement?: unknown; confidence?: unknown; sourceType?: unknown; sourceId?: unknown } : {};
    const statement = typeof value.statement === "string" ? value.statement : "";
    const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence) ? Math.max(0, Math.min(1, value.confidence)) : 0;
    const sourceType = typeof value.sourceType === "string" ? value.sourceType : "unknown";
    const sourceId = typeof value.sourceId === "string" ? value.sourceId : "";
    const reasons: string[] = [];
    let status: ClaimAuditStatus;
    if (!statement || !sourceId || !input.knownEvidenceIds.has(sourceId)) {
      status = "unsupported";
      reasons.push(!statement ? "claim has no statement" : !sourceId ? "claim has no provenance source" : `provenance source '${sourceId}' is not durable`);
    } else if (sourceType === "literature" || sourceType === "external_source" || input.literatureEvidenceIds?.has(sourceId)) {
      status = "literature_only";
      reasons.push(sourceType === "external_source"
        ? "external discussion, leaderboard, or platform content is discovery evidence and does not verify a workspace result"
        : input.literatureEvidenceIds?.has(sourceId) && sourceType !== "literature"
        ? "claim provenance resolves to a literature source; model labels cannot promote it to workspace evidence"
        : "literature can motivate a hypothesis but does not verify a workspace result");
    } else if (sourceType === "external_score" || (confidence >= 0.8 && ["observation", "run", "experiment", "review"].includes(sourceType))) {
      status = "verified";
      reasons.push(sourceType === "external_score" ? "external score is durably recorded" : "durable workspace evidence meets the confidence threshold");
    } else {
      status = "provisional";
      reasons.push("durable provenance exists, but independent verification or confidence is insufficient");
    }
    if (input.conflictedClaimIds?.has(id)) {
      status = "conflicted";
      reasons.push("claim participates in a contradiction edge requiring review");
    }
    return { id, statement, status, confidence, sourceType, sourceId, reasons };
  });
  const count = (status: ClaimAuditStatus): number => entries.filter((entry) => entry.status === status).length;
  const verified = count("verified");
  const conflicted = count("conflicted");
  return {
    total: entries.length,
    verified,
    provisional: count("provisional"),
    literatureOnly: count("literature_only"),
    unsupported: count("unsupported"),
    conflicted,
    publishable: entries.length > 0 && verified === entries.length && conflicted === 0,
    entries,
  };
}
