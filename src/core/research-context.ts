import { createHash } from "node:crypto";
import type { ResearchStore } from "./store.js";
import { transferableMethodsFromEvents, type TransferTarget, type TransferableMethod } from "./method-transfer.js";
import { ablationPlansFromEvents, type AblationPlan } from "./ablation.js";
import { verifiedPlaybooksFromEvents, type VerifiedPlaybook } from "./playbooks.js";
import { failedDirectionsFromExperiments, type FailedDirection } from "./failure-memory.js";
import { canonicalSourceUrl, type RepositorySearchResult } from "./sources.js";
import { buildFalsificationAgenda, type FalsificationAgendaItem } from "./falsification-agenda.js";
import { executionPlaybooksFromEvents, type ExecutionPlaybook } from "./execution-playbooks.js";

export type ResearchRepositoryLead = RepositorySearchResult;
export type MemoryRetrievalRegime = "discovery" | "execution";

export interface MemoryRetrievalRouting {
  regime: MemoryRetrievalRegime;
  rationale: string;
  quotas: Record<"claims" | "quarantinedClaims" | "hypotheses" | "contradictions" | "transferableMethods" | "verifiedPlaybooks" | "executionPlaybooks" | "failedDirections" | "repositoryLeads" | "ablationPlans" | "falsificationAgenda", number>;
}

/**
 * Route memory by the job the next turn must perform. Retrieval-heavy
 * discovery benefits from broader literature and repository coverage; an
 * execution turn must preserve actionable hypotheses, failures, controls, and
 * falsification work instead of spending its context on stale leads.
 */
export function classifyMemoryRetrievalRegime(query?: string, target: TransferTarget = {}): MemoryRetrievalRegime {
  const descriptor = `${query ?? ""} ${target.objective ?? ""} ${target.taskType ?? ""} ${target.context ?? ""}`.toLowerCase();
  return /challenge|experiment|evaluator|execute|execution|run\b|artifact|replicat|validation|benchmark|submit|deployment|implementation/.test(descriptor)
    ? "execution"
    : "discovery";
}

/** Resolve active claim IDs from both claim and linked-source lifecycle state. */
export function activeClaimIds(store: ResearchStore): Set<string> {
  const sourceStatus = new Map(store.sources().map((source) => {
    const status = source.payload && typeof source.payload === "object" ? (source.payload as { status?: unknown }).status : undefined;
    return [source.id, status === "superseded" || status === "invalidated" ? status : "active"] as const;
  }));
  return new Set(store.claims().flatMap((claim) => {
    const payload = claim.payload && typeof claim.payload === "object" ? claim.payload as { status?: unknown; sourceType?: unknown; sourceId?: unknown } : {};
    if (payload.status === "superseded" || payload.status === "invalidated") return [];
    if ((payload.sourceType === "literature" || payload.sourceType === "external_source") && typeof payload.sourceId === "string" && sourceStatus.get(payload.sourceId) !== "active") return [];
    return [claim.id];
  }));
}

/** Return only contradictions whose two claim endpoints are still active. */
export function activeContradictionEdges(store: ResearchStore): ReturnType<ResearchStore["edges"]> {
  const active = activeClaimIds(store);
  return store.edges().filter((edge) => edge.relation === "contradicts" && active.has(edge.fromId) && active.has(edge.toId));
}

/** Count duplicate findings that still involve an active claim. */
export function activeDuplicateClaimCount(store: ResearchStore): number {
  const activeClaims = activeClaimIds(store);
  return store.eventsByType("evidence.claim.duplicate_detected").filter((event) => {
    const payload = event.payload && typeof event.payload === "object" ? event.payload as { claimId?: unknown; duplicateOf?: unknown } : {};
    const claimActive = typeof payload.claimId !== "string" || activeClaims.has(payload.claimId);
    const duplicateActive = typeof payload.duplicateOf !== "string" || activeClaims.has(payload.duplicateOf);
    return claimActive && duplicateActive;
  }).length;
}

export interface ResearchMemoryContext {
  claims: Array<{ id: string; statement: string; scope: string; confidence: number; sourceType: string; sourceId: string; status: string }>;
  /** Retained for audit and negative evidence, but never mixed into active claims. */
  quarantinedClaims: Array<{ id: string; statement: string; scope: string; confidence: number; sourceType: string; sourceId: string; status: string }>;
  hypotheses: Array<{ id: string; title: string; status: string; mechanism?: string }>;
  contradictions: Array<{ fromId: string; toId: string; confidence: number }>;
  transferableMethods: TransferableMethod[];
  verifiedPlaybooks: VerifiedPlaybook[];
  executionPlaybooks: ExecutionPlaybook[];
  failedDirections: FailedDirection[];
  repositoryLeads: ResearchRepositoryLead[];
  ablationPlans: AblationPlan[];
  falsificationAgenda: FalsificationAgendaItem[];
  /** Reproducible record of exactly which memory was supplied to an agent. */
  retrieval: {
    query: string;
    limit: number;
    routing: MemoryRetrievalRouting;
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
  const currentEntries = entries.filter((entry) => {
    const status = entry.payload && typeof entry.payload === "object" ? (entry.payload as { status?: unknown }).status : undefined;
    return status !== "superseded" && status !== "invalidated";
  });
  for (const entry of currentEntries) {
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
export function researchMemoryContext(store: ResearchStore, limit = 30, query?: string, transferTarget: TransferTarget = {}, options: { regime?: MemoryRetrievalRegime } = {}): ResearchMemoryContext {
  const bounded = Math.max(1, Math.min(limit, 100));
  const regime = options.regime ?? classifyMemoryRetrievalRegime(query, transferTarget);
  const quota = (fraction: number): number => Math.max(1, Math.min(bounded, Math.ceil(bounded * fraction)));
  const routing: MemoryRetrievalRouting = regime === "execution"
    ? {
      regime,
      rationale: "execution-critical retrieval preserves current tests, controls, failures, and falsification work before broad discovery leads",
      quotas: { claims: bounded, quarantinedClaims: quota(0.25), hypotheses: bounded, contradictions: bounded, transferableMethods: quota(0.6), verifiedPlaybooks: quota(0.6), executionPlaybooks: bounded, failedDirections: quota(0.8), repositoryLeads: quota(0.35), ablationPlans: bounded, falsificationAgenda: bounded },
    }
    : {
      regime,
      rationale: "discovery retrieval broadens primary claims, transferable methods, repositories, and alternative leads before execution",
      quotas: { claims: bounded, quarantinedClaims: quota(0.5), hypotheses: quota(0.75), contradictions: bounded, transferableMethods: bounded, verifiedPlaybooks: bounded, executionPlaybooks: quota(0.5), failedDirections: quota(0.5), repositoryLeads: quota(0.8), ablationPlans: quota(0.6), falsificationAgenda: bounded },
    };
  const claimEntries = store.claims();
  const activeIds = activeClaimIds(store);
  const activeClaimEntries = claimEntries.filter((entry) => activeIds.has(entry.id));
  const quarantinedClaimEntries = claimEntries.filter((entry) => !activeIds.has(entry.id));
  const claimValue = (entry: { id: string; payload: unknown }): ResearchMemoryContext["claims"][number] | undefined => {
    const value = entry.payload as Partial<ResearchMemoryContext["claims"][number]>;
    return typeof value.statement === "string" && typeof value.scope === "string" && typeof value.confidence === "number" && typeof value.sourceType === "string" && typeof value.sourceId === "string"
      ? { id: entry.id, statement: value.statement.slice(0, 800), scope: value.scope, confidence: value.confidence, sourceType: value.sourceType, sourceId: value.sourceId, status: value.status ?? "active" }
      : undefined;
  };
  const claims = rankedMemory(store, activeClaimEntries, query, (entry) => JSON.stringify(entry.payload)).slice(0, bounded).flatMap((entry) => claimValue(entry) ?? []);
  const quarantinedClaims = rankedMemory(store, quarantinedClaimEntries, query, (entry) => JSON.stringify(entry.payload)).slice(0, routing.quotas.quarantinedClaims).flatMap((entry) => claimValue(entry) ?? []);
  const hypotheses = rankedMemory(store, store.hypotheses(), query, (entry) => JSON.stringify(entry.payload)).slice(0, routing.quotas.hypotheses).flatMap((entry) => {
    const value = entry.payload as { title?: unknown; status?: unknown; mechanism?: unknown };
    return typeof value.title === "string" ? [{ id: entry.id, title: value.title, status: typeof value.status === "string" ? value.status : "proposed", ...(typeof value.mechanism === "string" ? { mechanism: value.mechanism.slice(0, 500) } : {}) }] : [];
  });
  const contradictions = activeContradictionEdges(store).slice(0, bounded).map((edge) => ({ fromId: edge.fromId, toId: edge.toId, confidence: edge.confidence }));
  // Learning memory is durable; only the final ranked context is bounded.
  // recentEvents() is a UI timeline and must not silently erase old transfer
  // methods or repository discoveries from long campaigns.
  const events = store.eventsByTypes([
    "research.method.transferable",
    "research.execution.playbook",
    "research.repository.search.completed",
    "research.ablation.plan",
  ]);
  const transferableMethods = transferableMethodsFromEvents(events, query, Math.min(8, routing.quotas.transferableMethods), transferTarget);
  const verifiedPlaybooks = verifiedPlaybooksFromEvents(events, query, Math.min(8, routing.quotas.verifiedPlaybooks));
  const executionPlaybooks = executionPlaybooksFromEvents(events, query, Math.min(8, routing.quotas.executionPlaybooks));
  const failedDirections = failedDirectionsFromExperiments(store.experiments(), query, Math.min(8, routing.quotas.failedDirections));
  const repositoryLeads = repositoryLeadsFromEvents(events, query, Math.min(8, routing.quotas.repositoryLeads));
  const ablationPlans = ablationPlansFromEvents(events, Math.min(8, routing.quotas.ablationPlans));
  const falsificationAgenda = buildFalsificationAgenda(store.hypotheses(), store.experiments(), Math.min(8, routing.quotas.falsificationAgenda));
  const retrievalBasis = {
    query: query?.trim() ?? "",
    limit: bounded,
    routing,
    activeClaimIds: claims.map((claim) => claim.id),
    quarantinedClaimIds: quarantinedClaims.map((claim) => claim.id),
    hypothesisIds: hypotheses.map((hypothesis) => hypothesis.id),
    executionPlaybookIds: executionPlaybooks.map((playbook) => playbook.id),
    falsificationHypothesisIds: falsificationAgenda.map((item) => item.hypothesisId),
  };
  const fingerprint = `sha256:${createHash("sha256").update(JSON.stringify(retrievalBasis)).digest("hex")}`;
  // Keep the actionable agenda near the front of the packet. Context packing
  // is key-order aware, so this prevents historical prose from crowding out
  // the next falsifiable test when a prompt is tightly bounded.
  return { claims, quarantinedClaims, hypotheses, falsificationAgenda, contradictions, transferableMethods, verifiedPlaybooks, executionPlaybooks, failedDirections, repositoryLeads, ablationPlans, retrieval: { ...retrievalBasis, fingerprint } };
}
