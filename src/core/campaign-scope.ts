/** Keep operational feedback from one durable campaign from steering another. */
export function recordsForCampaign<T extends { createdAt: string }>(records: readonly T[], startedAt: string): T[] {
  const boundary = Date.parse(startedAt);
  if (!Number.isFinite(boundary)) return [];
  return records.filter((record) => {
    const createdAt = Date.parse(record.createdAt);
    return Number.isFinite(createdAt) && createdAt >= boundary;
  });
}

/** Keep recent tool failures in context even when high-volume campaign telemetry pushes them out of the ordinary event window. */
export function mergeCampaignToolFailures<T extends { type: string; payload: unknown; createdAt: string; eventHash?: string | null }>(
  recentEvents: readonly T[],
  toolFailures: readonly T[],
  startedAt: string,
  failureLimit = 8,
): T[] {
  const limit = Math.max(1, Math.min(32, Math.floor(failureLimit)));
  const failures = recordsForCampaign(toolFailures, startedAt)
    .filter((event) => event.type === "research.tool.failed")
    .slice(-limit);
  const merged = new Map<string, T>();
  for (const event of [...recentEvents, ...failures]) {
    const key = event.eventHash ?? `${event.type}:${event.createdAt}:${JSON.stringify(event.payload)}`;
    merged.set(key, event);
  }
  return [...merged.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** Prefer an explicit current goal set; fall back to unscoped legacy records only when no scoped set exists. */
export function recordsForGoalSet<T extends { id: string; payload: unknown }>(
  records: readonly T[],
  goalSetId: string | null,
  mode: "research" | "challenge",
): T[] {
  if (!goalSetId) return [...records];
  const prefix = `goal_${mode}_${goalSetId}_`;
  const scoped = records.filter((record) => {
    const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? record.payload as { goalSetId?: unknown }
      : {};
    return payload.goalSetId === goalSetId || record.id.startsWith(prefix);
  });
  return scoped.length ? scoped : records.filter((record) => {
    const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? record.payload as { goalSetId?: unknown }
      : {};
    return typeof payload.goalSetId !== "string" && !/^goal_(research|challenge)_[a-z0-9]+_/.test(record.id);
  });
}

export interface CampaignEvidenceConflictInput {
  claimIds: ReadonlySet<string>;
  contradictions: readonly { fromId: string; toId: string }[];
  duplicates: readonly { claimId?: unknown; duplicateOf?: unknown }[];
}

/** Count only conflicts that touch claims created by this campaign; project-wide memory remains reusable context, not current-task pressure. */
export function campaignEvidenceConflictCounts(input: CampaignEvidenceConflictInput): { contradictions: number; duplicates: number } {
  const contradictions = new Set<string>();
  for (const edge of input.contradictions) {
    if (!input.claimIds.has(edge.fromId) && !input.claimIds.has(edge.toId)) continue;
    contradictions.add([edge.fromId, edge.toId].sort().join("\u0000"));
  }
  const duplicates = new Set<string>();
  for (const duplicate of input.duplicates) {
    if (typeof duplicate.claimId !== "string" || typeof duplicate.duplicateOf !== "string" || !input.claimIds.has(duplicate.claimId)) continue;
    duplicates.add([duplicate.claimId, duplicate.duplicateOf].sort().join("\u0000"));
  }
  return { contradictions: contradictions.size, duplicates: duplicates.size };
}
