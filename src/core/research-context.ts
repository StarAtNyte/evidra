import type { ResearchStore } from "./store.js";
import { transferableMethodsFromEvents, type TransferableMethod } from "./method-transfer.js";
import { ablationPlansFromEvents, type AblationPlan } from "./ablation.js";

export interface ResearchMemoryContext {
  claims: Array<{ id: string; statement: string; scope: string; confidence: number; sourceType: string; sourceId: string; status: string }>;
  hypotheses: Array<{ id: string; title: string; status: string; mechanism?: string }>;
  contradictions: Array<{ fromId: string; toId: string; confidence: number }>;
  transferableMethods: TransferableMethod[];
  ablationPlans: AblationPlan[];
}

/** Return the newest source entry for each URL while preserving source history in storage. */
export function latestSourceEntries<T extends { id: string; payload: unknown; createdAt: string }>(entries: T[], limit = 12, query?: string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const entry of entries) {
    const payload = entry.payload as { url?: unknown };
    const key = typeof payload.url === "string" && payload.url ? payload.url : entry.id;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  const ordered = query?.trim()
    ? ranked(result, query, (entry) => JSON.stringify(entry.payload))
    : result;
  return ordered.slice(0, Math.max(1, Math.min(limit, 100)));
}

/** Return the newest payload for each URL while preserving source history in storage. */
export function latestSourcePayloads(entries: Array<{ id: string; payload: unknown; createdAt: string }>, limit = 12, query?: string): unknown[] {
  return latestSourceEntries(entries, limit, query).map((entry) => entry.payload);
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
}

function relevance(query: Set<string>, text: string): number {
  if (!query.size) return 0;
  const value = tokens(text);
  let overlap = 0;
  for (const token of query) if (value.has(token)) overlap += 1;
  return overlap / query.size;
}

function ranked<T>(entries: T[], query: string | undefined, text: (entry: T) => string): T[] {
  const queryTokens = tokens(query ?? "");
  if (!queryTokens.size) return entries;
  return entries
    .map((entry, index) => ({ entry, index, score: relevance(queryTokens, text(entry)) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.entry);
}

/** Build a bounded, structured memory snapshot for autonomous research context. */
export function researchMemoryContext(store: ResearchStore, limit = 30, query?: string): ResearchMemoryContext {
  const bounded = Math.max(1, Math.min(limit, 100));
  const claims = ranked(store.claims(), query, (entry) => JSON.stringify(entry.payload)).slice(0, bounded).flatMap((entry) => {
    const value = entry.payload as Partial<ResearchMemoryContext["claims"][number]>;
    return typeof value.statement === "string" && typeof value.scope === "string" && typeof value.confidence === "number" && typeof value.sourceType === "string" && typeof value.sourceId === "string"
      ? [{ id: entry.id, statement: value.statement.slice(0, 800), scope: value.scope, confidence: value.confidence, sourceType: value.sourceType, sourceId: value.sourceId, status: value.status ?? "active" }]
      : [];
  });
  const hypotheses = ranked(store.hypotheses(), query, (entry) => JSON.stringify(entry.payload)).slice(0, bounded).flatMap((entry) => {
    const value = entry.payload as { title?: unknown; status?: unknown; mechanism?: unknown };
    return typeof value.title === "string" ? [{ id: entry.id, title: value.title, status: typeof value.status === "string" ? value.status : "proposed", ...(typeof value.mechanism === "string" ? { mechanism: value.mechanism.slice(0, 500) } : {}) }] : [];
  });
  const contradictions = store.edges().filter((edge) => edge.relation === "contradicts").slice(0, bounded).map((edge) => ({ fromId: edge.fromId, toId: edge.toId, confidence: edge.confidence }));
  const transferableMethods = transferableMethodsFromEvents(store.recentEvents(5_000), query, Math.min(8, bounded));
  const ablationPlans = ablationPlansFromEvents(store.recentEvents(5_000), Math.min(8, bounded));
  return { claims, hypotheses, contradictions, transferableMethods, ablationPlans };
}
