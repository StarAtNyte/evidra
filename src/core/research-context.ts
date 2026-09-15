import { createHash } from "node:crypto";
import type { ResearchStore } from "./store.js";
import { transferableMethodsFromEvents, type TransferTarget, type TransferableMethod } from "./method-transfer.js";
import { ablationPlansFromEvents, type AblationPlan } from "./ablation.js";
import { verifiedPlaybooksFromEvents, type VerifiedPlaybook } from "./playbooks.js";
import { failedDirectionsFromExperiments, type FailedDirection } from "./failure-memory.js";
import { canonicalSourceUrl, type RepositorySearchResult } from "./sources.js";
import { buildFalsificationAgenda, type FalsificationAgendaItem } from "./falsification-agenda.js";

export type ResearchRepositoryLead = RepositorySearchResult;

export interface ResearchMemoryContext {
  claims: Array<{ id: string; statement: string; scope: string; confidence: number; sourceType: string; sourceId: string; status: string }>;
  /** Retained for audit and negative evidence, but never mixed into active claims. */
  quarantinedClaims: Array<{ id: string; statement: string; scope: string; confidence: number; sourceType: string; sourceId: string; status: string }>;
  hypotheses: Array<{ id: string; title: string; status: string; mechanism?: string }>;
  contradictions: Array<{ fromId: string; toId: string; confidence: number }>;
  transferableMethods: TransferableMethod[];
  verifiedPlaybooks: VerifiedPlaybook[];
  failedDirections: FailedDirection[];
  repositoryLeads: ResearchRepositoryLead[];
  ablationPlans: AblationPlan[];
  falsificationAgenda: FalsificationAgendaItem[];
  /** Reproducible record of exactly which memory was supplied to an agent. */
  retrieval: {
    query: string;
    limit: number;
    activeClaimIds: string[];
    quarantinedClaimIds: string[];
    hypothesisIds: string[];
    falsificationHypothesisIds: string[];
    fingerprint: string;
  };
}

/** Return the newest source entry for each URL while preserving source history in storage. */
export function latestSourceEntries<T extends { id: string; payload: unknown; createdAt: string }>(entries: T[], limit = 12, query?: string, store?: ResearchStore): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const entry of entries) {
    const payload = entry.payload as { url?: unknown };
    const key = typeof payload.url === "string" && payload.url ? canonicalSourceUrl(payload.url) : entry.id;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  const ordered = query?.trim()
    ? store ? rankedMemory(store, result, query, (entry) => JSON.stringify(entry.payload)) : ranked(result, query, (entry) => JSON.stringify(entry.payload))
    : result;
  return ordered.slice(0, Math.max(1, Math.min(limit, 100)));
}

/** Return the newest payload for each URL while preserving source history in storage. */
export function latestSourcePayloads(entries: Array<{ id: string; payload: unknown; createdAt: string }>, limit = 12, query?: string, store?: ResearchStore): unknown[] {
  return latestSourceEntries(entries, limit, query, store).map((entry) => entry.payload);
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

/**
 * Rank durable memory with the store's FTS index when available, while
 * retaining the deterministic lexical scorer for old stores or partial
 * queries. FTS is intentionally a boost rather than the sole ranking source:
 * a migrated database may have an incomplete index and a useful partial
 * lexical match should still remain visible to the director.
 */
function rankedMemory<T extends { id: string }>(store: ResearchStore, entries: T[], query: string | undefined, text: (entry: T) => string): T[] {
  const lexical = ranked(entries, query, text);
  if (!query?.trim()) return lexical;
  const indexed = new Set(store.searchMemory(query, Math.min(200, Math.max(20, entries.length * 4))).map((entry) => entry.id));
  const queryTokens = tokens(query);
  return lexical
    .map((entry, index) => ({ entry, index, lexical: relevance(queryTokens, text(entry)), indexed: indexed.has(entry.id) }))
    .sort((left, right) => Number(right.indexed) - Number(left.indexed) || right.lexical - left.lexical || left.index - right.index)
    .map((entry) => entry.entry);
}

/** Read and rank durable repository discoveries for later research cycles. */
export function repositoryLeadsFromEvents(events: Array<{ type: string; payload: unknown }>, query?: string, limit = 8): ResearchRepositoryLead[] {
  const seen = new Set<string>();
  const leads: ResearchRepositoryLead[] = [];
  for (const event of events) {
    if (event.type !== "research.repository.search.completed" || !event.payload || typeof event.payload !== "object") continue;
    const results = (event.payload as { results?: unknown }).results;
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      if (!result || typeof result !== "object") continue;
      const value = result as Partial<ResearchRepositoryLead>;
      if (typeof value.name !== "string" || typeof value.url !== "string" || !/^https:\/\/github\.com\//i.test(value.url) || seen.has(value.url)) continue;
      seen.add(value.url);
      leads.push({ name: value.name, url: value.url, ...(typeof value.description === "string" ? { description: value.description } : {}), stars: typeof value.stars === "number" && Number.isFinite(value.stars) ? value.stars : 0, ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}), ...(typeof value.language === "string" ? { language: value.language } : {}) });
    }
  }
  return ranked(leads, query, (lead) => JSON.stringify(lead)).slice(0, Math.max(1, Math.min(limit, 50)));
}

/** Build a bounded, structured memory snapshot for autonomous research context. */
export function researchMemoryContext(store: ResearchStore, limit = 30, query?: string, transferTarget: TransferTarget = {}): ResearchMemoryContext {
  const bounded = Math.max(1, Math.min(limit, 100));
  const claimEntries = store.claims();
  const activeClaimEntries = claimEntries.filter((entry) => {
    const status = (entry.payload as { status?: unknown }).status;
    return status !== "invalidated" && status !== "superseded";
  });
  const quarantinedClaimEntries = claimEntries.filter((entry) => {
    const status = (entry.payload as { status?: unknown }).status;
    return status === "invalidated" || status === "superseded";
  });
  const claimValue = (entry: { id: string; payload: unknown }): ResearchMemoryContext["claims"][number] | undefined => {
    const value = entry.payload as Partial<ResearchMemoryContext["claims"][number]>;
    return typeof value.statement === "string" && typeof value.scope === "string" && typeof value.confidence === "number" && typeof value.sourceType === "string" && typeof value.sourceId === "string"
      ? { id: entry.id, statement: value.statement.slice(0, 800), scope: value.scope, confidence: value.confidence, sourceType: value.sourceType, sourceId: value.sourceId, status: value.status ?? "active" }
      : undefined;
  };
  const claims = rankedMemory(store, activeClaimEntries, query, (entry) => JSON.stringify(entry.payload)).slice(0, bounded).flatMap((entry) => claimValue(entry) ?? []);
  const quarantinedClaims = rankedMemory(store, quarantinedClaimEntries, query, (entry) => JSON.stringify(entry.payload)).slice(0, bounded).flatMap((entry) => claimValue(entry) ?? []);
  const hypotheses = rankedMemory(store, store.hypotheses(), query, (entry) => JSON.stringify(entry.payload)).slice(0, bounded).flatMap((entry) => {
    const value = entry.payload as { title?: unknown; status?: unknown; mechanism?: unknown };
    return typeof value.title === "string" ? [{ id: entry.id, title: value.title, status: typeof value.status === "string" ? value.status : "proposed", ...(typeof value.mechanism === "string" ? { mechanism: value.mechanism.slice(0, 500) } : {}) }] : [];
  });
  const contradictions = store.edges().filter((edge) => edge.relation === "contradicts").slice(0, bounded).map((edge) => ({ fromId: edge.fromId, toId: edge.toId, confidence: edge.confidence }));
  // Learning memory is durable; only the final ranked context is bounded.
  // recentEvents() is a UI timeline and must not silently erase old transfer
  // methods or repository discoveries from long campaigns.
  const events = store.eventsByTypes([
    "research.method.transferable",
    "research.repository.search.completed",
    "research.ablation.plan",
  ]);
  const transferableMethods = transferableMethodsFromEvents(events, query, Math.min(8, bounded), transferTarget);
  const verifiedPlaybooks = verifiedPlaybooksFromEvents(events, query, Math.min(8, bounded));
  const failedDirections = failedDirectionsFromExperiments(store.experiments(), query, Math.min(8, bounded));
  const repositoryLeads = repositoryLeadsFromEvents(events, query, Math.min(8, bounded));
  const ablationPlans = ablationPlansFromEvents(events, Math.min(8, bounded));
  const falsificationAgenda = buildFalsificationAgenda(store.hypotheses(), store.experiments(), Math.min(8, bounded));
  const retrievalBasis = {
    query: query?.trim() ?? "",
    limit: bounded,
    activeClaimIds: claims.map((claim) => claim.id),
    quarantinedClaimIds: quarantinedClaims.map((claim) => claim.id),
    hypothesisIds: hypotheses.map((hypothesis) => hypothesis.id),
    falsificationHypothesisIds: falsificationAgenda.map((item) => item.hypothesisId),
  };
  const fingerprint = `sha256:${createHash("sha256").update(JSON.stringify(retrievalBasis)).digest("hex")}`;
  return { claims, quarantinedClaims, hypotheses, contradictions, transferableMethods, verifiedPlaybooks, failedDirections, repositoryLeads, ablationPlans, falsificationAgenda, retrieval: { ...retrievalBasis, fingerprint } };
}
