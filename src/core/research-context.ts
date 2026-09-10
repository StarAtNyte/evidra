import type { ResearchStore } from "./store.js";

export interface ResearchMemoryContext {
  claims: Array<{ id: string; statement: string; scope: string; confidence: number; sourceType: string; sourceId: string; status: string }>;
  hypotheses: Array<{ id: string; title: string; status: string; mechanism?: string }>;
  contradictions: Array<{ fromId: string; toId: string; confidence: number }>;
}

/** Return the newest source entry for each URL while preserving source history in storage. */
export function latestSourceEntries<T extends { id: string; payload: unknown; createdAt: string }>(entries: T[], limit = 12): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const entry of entries) {
    const payload = entry.payload as { url?: unknown };
    const key = typeof payload.url === "string" && payload.url ? payload.url : entry.id;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
    if (result.length >= Math.max(1, Math.min(limit, 100))) break;
  }
  return result;
}

/** Return the newest payload for each URL while preserving source history in storage. */
export function latestSourcePayloads(entries: Array<{ id: string; payload: unknown; createdAt: string }>, limit = 12): unknown[] {
  return latestSourceEntries(entries, limit).map((entry) => entry.payload);
}

/** Build a bounded, structured memory snapshot for autonomous research context. */
export function researchMemoryContext(store: ResearchStore, limit = 30): ResearchMemoryContext {
  const bounded = Math.max(1, Math.min(limit, 100));
  const claims = store.claims().slice(0, bounded).flatMap((entry) => {
    const value = entry.payload as Partial<ResearchMemoryContext["claims"][number]>;
    return typeof value.statement === "string" && typeof value.scope === "string" && typeof value.confidence === "number" && typeof value.sourceType === "string" && typeof value.sourceId === "string"
      ? [{ id: entry.id, statement: value.statement.slice(0, 800), scope: value.scope, confidence: value.confidence, sourceType: value.sourceType, sourceId: value.sourceId, status: value.status ?? "active" }]
      : [];
  });
  const hypotheses = store.hypotheses().slice(0, bounded).flatMap((entry) => {
    const value = entry.payload as { title?: unknown; status?: unknown; mechanism?: unknown };
    return typeof value.title === "string" ? [{ id: entry.id, title: value.title, status: typeof value.status === "string" ? value.status : "proposed", ...(typeof value.mechanism === "string" ? { mechanism: value.mechanism.slice(0, 500) } : {}) }] : [];
  });
  const contradictions = store.edges().filter((edge) => edge.relation === "contradicts").slice(0, bounded).map((edge) => ({ fromId: edge.fromId, toId: edge.toId, confidence: edge.confidence }));
  return { claims, hypotheses, contradictions };
}
