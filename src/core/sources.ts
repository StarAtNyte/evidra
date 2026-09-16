import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { inflateSync } from "node:zlib";
import { ResearchSourceSchema, type ResearchSource } from "./types.js";

export interface RetrievedSource extends ResearchSource {
  contentType: string;
  text: string;
  excerpt: string;
}

export type SourceEvidenceClass = "scholarly" | "official" | "implementation" | "discovery";

export interface SourceSearchResult {
  title: string;
  url: string;
  provider?: "openalex" | "arxiv" | "crossref" | "web";
  doi?: string;
  venue?: string;
  publicationDate?: string;
  authors: string[];
  abstract?: string;
  /** Probe(s) that returned this work during a deep search. */
  queries?: string[];
  /** Deterministic provenance class used to prioritize evidence over discovery noise. */
  evidenceClass?: SourceEvidenceClass;
  /** 0..1 ranking signal; this is a retrieval heuristic, never a truth score. */
  qualityScore?: number;
}

export type SourceSearchDepth = "shallow" | "deep";

/** Classify a URL when it enters the system without a search-provider record. */
export function sourceEvidenceClass(url: string, provider?: SourceSearchResult["provider"], doi?: string): SourceEvidenceClass {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* malformed URLs are rejected by retrieval */ }
  if (provider === "arxiv" || provider === "openalex" || provider === "crossref" || Boolean(doi) || /(^|\.)arxiv\.org$|(^|\.)doi\.org$/i.test(host)) return "scholarly";
  if (/(^|\.)github\.com$|(^|\.)gitlab\.com$/i.test(host)) return "implementation";
  if (/(^|\.)scholar\.google\.|(^|\.)researchgate\.net$/i.test(host)) return "discovery";
  if (/(^|\.)((gov|edu)|openai\.com|deepmind\.google|ai\.google|nasa\.gov|who\.int)$/i.test(host)) return "official";
  return provider === "web" ? "discovery" : "discovery";
}

/** A conservative score for routing and display; never a claim of correctness. */
export function sourceEvidenceQuality(input: Pick<SourceSearchResult, "url" | "provider" | "doi" | "abstract" | "authors" | "venue">): number {
  const evidenceClass = sourceEvidenceClass(input.url, input.provider, input.doi);
  const base = evidenceClass === "scholarly" ? 0.72 : evidenceClass === "official" ? 0.62 : evidenceClass === "implementation" ? 0.52 : 0.2;
  const metadata = (input.doi ? 0.08 : 0) + (input.abstract ? 0.06 : 0) + (input.authors.length ? 0.04 : 0) + (input.venue ? 0.03 : 0);
  return Number(Math.max(0, Math.min(1, base + metadata)).toFixed(4));
}

/**
 * Rank candidates by provenance before relevance. Search engines and indexes
 * are useful for discovery, but they must not crowd out a retrievable paper,
 * official specification, or implementation repository. The score is only a
 * routing heuristic; retrieved content and claims remain independently audited.
 */
export function rankSourceSearchResults(results: SourceSearchResult[], query?: string, limit = 20): SourceSearchResult[] {
  const queryTokens = new Set((query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
  const seen = new Set<string>();
  const scored = results.flatMap((result, index) => {
    const key = (result.doi ?? canonicalSourceUrl(result.url)).toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    const evidenceClass = sourceEvidenceClass(result.url, result.provider, result.doi);
    const base = evidenceClass === "scholarly" ? 0.72 : evidenceClass === "official" ? 0.62 : evidenceClass === "implementation" ? 0.52 : 0.2;
    const metadata = (result.doi ? 0.08 : 0) + (result.abstract ? 0.06 : 0) + (result.authors.length ? 0.04 : 0) + (result.venue ? 0.03 : 0);
    const overlap = queryTokens.size ? [...queryTokens].filter((token) => `${result.title} ${result.abstract ?? ""}`.toLowerCase().includes(token)).length / queryTokens.size : 0;
    const score = Math.max(0, Math.min(1, base + metadata + overlap * 0.07 + (result.queries?.length ?? 0) * 0.01));
    return [{ ...result, evidenceClass, qualityScore: Number(score.toFixed(4)), _rank: score, _index: index }];
  }).sort((left, right) => right._rank - left._rank || right.qualityScore - left.qualityScore || left._index - right._index);
  const selected: typeof scored = [];
  const providers = new Set<string>();
  const classes = new Set<SourceEvidenceClass>();
  const target = Math.max(1, Math.min(limit, 100));
  // Greedy diversity-aware reranking prevents a deep search from filling the
  // whole frontier with one index/provider. Small bonuses preserve relevance
  // while encouraging independent retrieval routes and evidence classes.
  while (selected.length < target && scored.length) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < scored.length; index += 1) {
      const candidate = scored[index];
      const provider = candidate.provider ?? "direct";
      const diversityBonus = (providers.has(provider) ? 0 : 0.06) + (candidate.evidenceClass && classes.has(candidate.evidenceClass) ? 0 : 0.04);
      const adjusted = candidate._rank + diversityBonus;
      if (adjusted > bestScore || (adjusted === bestScore && candidate._index < scored[bestIndex]._index)) {
        bestIndex = index;
        bestScore = adjusted;
      }
    }
    const [chosen] = scored.splice(bestIndex, 1);
    selected.push(chosen);
    providers.add(chosen.provider ?? "direct");
    if (chosen.evidenceClass) classes.add(chosen.evidenceClass);
  }
  return selected.map(({ _rank: _ignoredRank, _index: _ignoredIndex, ...result }) => result);
}

/** Build bounded, deterministic probes for deep literature search. */
export function researchSearchQueries(query: string, depth: SourceSearchDepth = "shallow"): string[] {
  const normalized = query.trim().replace(/\s+/g, " ").slice(0, 300);
  if (!normalized) return [];
  if (depth === "shallow") return [normalized];
  const terms = normalized.split(/\s+/).filter(Boolean);
  const probes = [
    normalized,
    `${terms.slice(0, 8).join(" ")} methods evaluation`,
    `${terms.slice(Math.max(0, terms.length - 8)).join(" ")} evidence replication`,
  ];
  return [...new Set(probes.map((probe) => probe.trim().slice(0, 300)).filter((probe) => probe.length >= 3))].slice(0, 3);
}

export interface RepositorySearchResult {
  name: string;
  url: string;
  description?: string;
  stars: number;
  updatedAt?: string;
  language?: string;
}

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
export const SOURCE_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_SOURCE_REFRESH_MS = 6 * 60 * 60 * 1000;

function reconstructAbstract(invertedIndex: unknown): string | undefined {
  if (!invertedIndex || typeof invertedIndex !== "object") return undefined;
  const words: Array<{ index: number; word: string }> = [];
  for (const [word, positions] of Object.entries(invertedIndex as Record<string, unknown>)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) if (typeof position === "number" && Number.isInteger(position)) words.push({ index: position, word });
  }
  if (!words.length) return undefined;
  return words.sort((left, right) => left.index - right.index).map((entry) => entry.word).join(" ").slice(0, 2_000);
}

/** Parse OpenAlex search output without coupling the research loop to the API. */
export function parseSourceSearchResults(value: unknown, limit = 8): SourceSearchResult[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { results?: unknown }).results)) return [];
  return ((value as { results: unknown[] }).results).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as { title?: unknown; doi?: unknown; publication_date?: unknown; primary_location?: { landing_page_url?: unknown; source?: { display_name?: unknown } }; authorships?: unknown; abstract_inverted_index?: unknown };
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const url = typeof item.primary_location?.landing_page_url === "string" ? item.primary_location.landing_page_url : typeof item.doi === "string" ? item.doi : "";
    if (!title || !/^https?:\/\//i.test(url)) return [];
    const authors = Array.isArray(item.authorships) ? item.authorships.flatMap((author) => {
      const name = author && typeof author === "object" && (author as { author?: { display_name?: unknown } }).author?.display_name;
      return typeof name === "string" ? [name] : [];
    }).slice(0, 8) : [];
    return [{ title, url, provider: "openalex" as const, doi: typeof item.doi === "string" ? item.doi : undefined, venue: typeof item.primary_location?.source?.display_name === "string" ? item.primary_location.source.display_name : undefined, publicationDate: typeof item.publication_date === "string" ? item.publication_date : undefined, authors, abstract: reconstructAbstract(item.abstract_inverted_index) }];
  }).slice(0, Math.max(1, Math.min(limit, 20)));
}

function xmlText(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\s+/g, " ").trim();
}

function htmlText(value: string): string {
  return value.replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&#x2f;|&#47;/gi, "/").replace(/\s+/g, " ").trim();
}

/** Parse DuckDuckGo-style result markup as untrusted web candidates. */
export function parseWebSearchResults(html: string, limit = 8): SourceSearchResult[] {
  const results: SourceSearchResult[] = [];
  const pattern = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    let url = htmlText(match[1]);
    try {
      const parsed = new URL(url, "https://duckduckgo.com");
      const redirected = parsed.searchParams.get("uddg");
      url = redirected ? decodeURIComponent(redirected) : parsed.href;
    } catch { continue; }
    if (!/^https?:\/\//i.test(url) || /(^|\.)duckduckgo\.com$/i.test(new URL(url).hostname)) continue;
    const title = htmlText(match[2]).slice(0, 300);
    if (!title || results.some((result) => result.url === url)) continue;
    results.push({ title, url, provider: "web", authors: [] });
    if (results.length >= Math.max(1, Math.min(limit, 20))) break;
  }
  return results;
}

/** Parse the public arXiv Atom response without adding an XML dependency. */
export function parseArxivSearchResults(xml: string, limit = 8): SourceSearchResult[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].flatMap((match) => {
    const entry = match[1];
    const title = xmlText(entry.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "");
    const rawId = xmlText(entry.match(/<id>([\s\S]*?)<\/id>/i)?.[1] ?? "");
    const arxivId = rawId.match(/arxiv\.org\/(?:abs|pdf)\/(\d+\.\d+(?:v\d+)?)/i)?.[1];
    if (!title || !arxivId) return [];
    const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)].map((author) => xmlText(author[1])).filter(Boolean).slice(0, 8);
    const doi = xmlText(entry.match(/<arxiv:doi>([\s\S]*?)<\/arxiv:doi>/i)?.[1] ?? "") || undefined;
    return [{
      title,
      url: `https://arxiv.org/abs/${arxivId}`,
      provider: "arxiv" as const,
      ...(doi ? { doi: doi.startsWith("http") ? doi : `https://doi.org/${doi}` } : {}),
      publicationDate: xmlText(entry.match(/<published>([\s\S]*?)<\/published>/i)?.[1] ?? "") || undefined,
      authors,
      abstract: xmlText(entry.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1] ?? "") || undefined,
    }];
  }).slice(0, Math.max(1, Math.min(limit, 20)));
}

/** Parse Crossref works while retaining DOI and publisher metadata as candidates. */
export function parseCrossrefSearchResults(value: unknown, limit = 8): SourceSearchResult[] {
  if (!value || typeof value !== "object") return [];
  const message = (value as { message?: unknown }).message;
  if (!message || typeof message !== "object" || !Array.isArray((message as { items?: unknown }).items)) return [];
  return ((message as { items: unknown[] }).items).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as { title?: unknown; DOI?: unknown; URL?: unknown; published?: { dateParts?: unknown }; author?: unknown; "container-title"?: unknown };
    const title = Array.isArray(item.title) && typeof item.title[0] === "string" ? item.title[0].trim() : "";
    const doi = typeof item.DOI === "string" && item.DOI.trim() ? `https://doi.org/${item.DOI.trim()}` : "";
    const url = typeof item.URL === "string" && /^https?:\/\//i.test(item.URL) ? item.URL : doi;
    if (!title || !url) return [];
    const authors = Array.isArray(item.author) ? item.author.flatMap((author) => {
      if (!author || typeof author !== "object") return [];
      const given = typeof (author as { given?: unknown }).given === "string" ? (author as { given: string }).given : "";
      const family = typeof (author as { family?: unknown }).family === "string" ? (author as { family: string }).family : "";
      const name = `${given} ${family}`.trim();
      return name ? [name] : [];
    }).slice(0, 8) : [];
    const dateParts = item.published?.dateParts;
    const publicationDate = Array.isArray(dateParts) && Array.isArray(dateParts[0]) && typeof dateParts[0][0] === "number"
      ? dateParts[0].map((part) => String(part)).join("-")
      : undefined;
    const venue = Array.isArray(item["container-title"]) && typeof item["container-title"][0] === "string" ? item["container-title"][0] : undefined;
    return [{ title, url, provider: "crossref" as const, ...(doi ? { doi } : {}), ...(venue ? { venue } : {}), ...(publicationDate ? { publicationDate } : {}), authors }];
  }).slice(0, Math.max(1, Math.min(limit, 20)));
}

async function searchArxivSources(query: string, limit: number, signal?: AbortSignal): Promise<SourceSearchResult[]> {
  const endpoint = new URL("https://export.arxiv.org/api/query");
  endpoint.searchParams.set("search_query", `all:${query.trim().slice(0, 200)}`);
  endpoint.searchParams.set("start", "0");
  endpoint.searchParams.set("max_results", String(Math.max(1, Math.min(limit, 20))));
  await assertPublicUrl(endpoint);
  const timeoutSignal = AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(endpoint, { signal: requestSignal, headers: { "user-agent": "Evidra/0.1 research-workbench" } });
  if (!response.ok) throw new Error(`arXiv search failed (${response.status} ${response.statusText}).`);
  return parseArxivSearchResults(await response.text(), limit);
}

async function searchCrossrefSources(query: string, limit: number, signal?: AbortSignal): Promise<SourceSearchResult[]> {
  const endpoint = new URL("https://api.crossref.org/works");
  endpoint.searchParams.set("query", query.trim().slice(0, 200));
  endpoint.searchParams.set("rows", String(Math.max(1, Math.min(limit, 20))));
  endpoint.searchParams.set("select", "title,DOI,URL,author,published,container-title");
  await assertPublicUrl(endpoint);
  const timeoutSignal = AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(endpoint, { signal: requestSignal, headers: { "user-agent": "Evidra/0.1 research-workbench (mailto:evidra@example.invalid)" } });
  if (!response.ok) throw new Error(`Crossref search failed (${response.status} ${response.statusText}).`);
  return parseCrossrefSearchResults(await response.json(), limit);
}

/** Search public web pages for official guidance, discussions, datasets, and implementations. */
export async function searchResearchWeb(query: string, limit = 8, signal?: AbortSignal): Promise<SourceSearchResult[]> {
  if (!query.trim()) throw new Error("Web search query must not be empty.");
  const endpoint = new URL("https://html.duckduckgo.com/html/");
  endpoint.searchParams.set("q", query.trim().slice(0, 256));
  await assertPublicUrl(endpoint);
  const timeoutSignal = AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(endpoint, { signal: requestSignal, headers: { accept: "text/html", "user-agent": "Evidra/0.1 research-workbench" } });
  if (!response.ok) throw new Error(`Web search failed (${response.status} ${response.statusText}).`);
  const results = parseWebSearchResults(await response.text(), limit);
  if (!results.length) throw new Error("Web search returned no candidates.");
  return rankSourceSearchResults(results, query, limit);
}

/** Search scholarly works; retrieval and claim extraction remain a separate step. */
export async function searchResearchSources(query: string, limit = 8, signal?: AbortSignal, depth: SourceSearchDepth = "shallow"): Promise<SourceSearchResult[]> {
  if (!query.trim()) throw new Error("Source search query must not be empty.");
  const queries = researchSearchQueries(query, depth);
  const searches = queries.map(async (probe) => {
    const endpoint = new URL("https://api.openalex.org/works");
    endpoint.searchParams.set("search", probe);
    endpoint.searchParams.set("per-page", String(Math.max(1, Math.min(limit, 20))));
    await assertPublicUrl(endpoint);
    const timeoutSignal = AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const openAlex = fetch(endpoint, { signal: requestSignal, headers: { "user-agent": "Evidra/0.1 research-workbench" } }).then(async (response) => {
      if (!response.ok) throw new Error(`Source search failed (${response.status} ${response.statusText}).`);
      return parseSourceSearchResults(await response.json(), limit);
    });
    const [openAlexResult, arxivResult, crossrefResult] = await Promise.allSettled([openAlex, searchArxivSources(probe, limit, signal), searchCrossrefSources(probe, limit, signal)]);
    return [
      ...(openAlexResult.status === "fulfilled" ? openAlexResult.value : []),
      ...(arxivResult.status === "fulfilled" ? arxivResult.value : []),
      ...(crossrefResult.status === "fulfilled" ? crossrefResult.value : []),
    ].map((result) => ({ ...result, queries: [probe] }));
  });
  const results = await Promise.allSettled(searches);
  // Interleave probes so a deep search cannot be dominated by the first
  // formulation; this gives the frontier genuine breadth before truncation.
  const batches = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const combined: SourceSearchResult[] = [];
  for (let index = 0; index < Math.max(0, ...batches.map((batch) => batch.length)); index += 1) {
    for (const batch of batches) if (batch[index]) combined.push(batch[index]);
  }
  if (!combined.length) {
    const failure = results.find((result) => result.status === "rejected")?.reason;
    throw failure instanceof Error ? failure : new Error("Scholarly source search returned no candidates.");
  }
  const deduplicated: SourceSearchResult[] = [];
  const byKey = new Map<string, SourceSearchResult>();
  for (const result of combined) {
    const key = (result.doi ?? result.url).toLowerCase().replace(/[?#].*$/, "").replace(/\/$/, "");
    const prior = byKey.get(key);
    if (prior) {
      prior.queries = [...new Set([...(prior.queries ?? []), ...(result.queries ?? [])])].slice(0, 12);
      continue;
    }
    const normalized = { ...result, ...(result.queries?.length ? { queries: [...new Set(result.queries)].slice(0, 12) } : {}) };
    byKey.set(key, normalized);
    deduplicated.push(normalized);
  }
  return rankSourceSearchResults(deduplicated, query, Math.max(1, Math.min(limit, 20)));
}

/** Parse GitHub repository search output as implementation leads, not evidence. */
export function parseRepositorySearchResults(value: unknown, limit = 8): RepositorySearchResult[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { items?: unknown }).items)) return [];
  return ((value as { items: unknown[] }).items).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as { full_name?: unknown; html_url?: unknown; description?: unknown; stargazers_count?: unknown; updated_at?: unknown; language?: unknown };
    if (typeof item.full_name !== "string" || !item.full_name.trim() || typeof item.html_url !== "string" || !/^https:\/\/github\.com\//i.test(item.html_url)) return [];
    return [{
      name: item.full_name.trim(),
      url: item.html_url,
      ...(typeof item.description === "string" && item.description.trim() ? { description: item.description.trim().slice(0, 500) } : {}),
      stars: typeof item.stargazers_count === "number" && Number.isFinite(item.stargazers_count) ? Math.max(0, Math.floor(item.stargazers_count)) : 0,
      ...(typeof item.updated_at === "string" ? { updatedAt: item.updated_at } : {}),
      ...(typeof item.language === "string" && item.language ? { language: item.language } : {}),
    }];
  }).slice(0, Math.max(1, Math.min(limit, 20)));
}

/** Search public GitHub repositories with optional operator-provided auth. */
export async function searchResearchRepositories(query: string, limit = 8, signal?: AbortSignal): Promise<RepositorySearchResult[]> {
  if (!query.trim()) throw new Error("Repository search query must not be empty.");
  const endpoint = new URL("https://api.github.com/search/repositories");
  endpoint.searchParams.set("q", query.trim().slice(0, 256));
  endpoint.searchParams.set("sort", "stars");
  endpoint.searchParams.set("order", "desc");
  endpoint.searchParams.set("per_page", String(Math.max(1, Math.min(limit, 20))));
  await assertPublicUrl(endpoint);
  const timeoutSignal = AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "Evidra/0.1 research-workbench" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(endpoint, { signal: requestSignal, headers });
  if (!response.ok) throw new Error(`Repository search failed (${response.status} ${response.statusText}).`);
  return parseRepositorySearchResults(await response.json(), limit);
}

/** Dynamic sources such as discussions and leaderboards should be revisited periodically. */
export function sourceIsFresh(entry: { payload: unknown; createdAt?: string }, maxAgeMs = DEFAULT_SOURCE_REFRESH_MS, now = Date.now()): boolean {
  const payload = entry.payload as { retrievedAt?: unknown };
  const timestamp = typeof payload.retrievedAt === "string" ? payload.retrievedAt : entry.createdAt;
  const retrievedAt = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(retrievedAt) && now - retrievedAt < maxAgeMs;
}

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    return octets[0] === 10 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) || octets[0] === 0 ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
      (octets[0] === 192 && octets[1] === 0) ||
      (octets[0] === 198 && octets[1] >= 18 && octets[1] <= 19) ||
      octets[0] >= 224;
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    // WHATWG URL parsing renders IPv4-mapped IPv6 addresses in hexadecimal,
    // e.g. ::ffff:7f00:1 for 127.0.0.1. Decode that suffix before applying
    // the IPv4 private/reserved-range policy.
    if (normalized.startsWith("::ffff:")) {
      const groups = normalized.slice("::ffff:".length).split(":");
      if (groups.length === 2 && groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
        const first = Number.parseInt(groups[0], 16);
        const second = Number.parseInt(groups[1], 16);
        return privateAddress(`${first >> 8}.${first & 255}.${second >> 8}.${second & 255}`);
      }
    }
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:") ||
      normalized.startsWith("fc") || normalized.startsWith("fd");
  }
  return true;
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http and https research sources are supported.");
  if (url.username || url.password) throw new Error("Research source URLs may not contain credentials.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [hostname] : (await lookup(hostname, { all: true })).map((entry) => entry.address);
  if (!addresses.length || addresses.some(privateAddress)) throw new Error(`Refusing private or loopback research source host: ${hostname}`);
}

/** Canonicalize equivalent HTTP source references without changing query semantics. */
export function canonicalSourceUrl(value: string): string {
  const raw = value.trim();
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) parsed.port = "";
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    return parsed.href;
  } catch {
    return raw.replace(/#.*$/, "").replace(/\/$/, "");
  }
}

function sourceId(url: string, contentHash: string): string {
  return `src_${createHash("sha256").update(`${canonicalSourceUrl(url)}\n${contentHash}`).digest("hex").slice(0, 20)}`;
}

function stripMarkup(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function decodePdfLiteral(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") { output += character; continue; }
    const escaped = value[++index] ?? "";
    const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
    if (simple[escaped] !== undefined) { output += simple[escaped]; continue; }
    if (/\d/.test(escaped)) {
      const octal = (escaped + (value[index + 1] ?? "") + (value[index + 2] ?? "")).match(/^\d{1,3}/)?.[0] ?? escaped;
      output += String.fromCharCode(parseInt(octal, 8));
      index += octal.length - 1;
    } else output += escaped;
  }
  return output;
}

/** Extract common PDF text operators without treating binary PDF bytes as prose. */
export function extractPdfText(bytes: Uint8Array): string {
  const document = Buffer.from(bytes).toString("latin1");
  const extracted: string[] = [];
  const streamPattern = /stream(?:\r\n|\n|\r)([\s\S]*?)(?:\r\n|\n|\r)endstream/g;
  for (const match of document.matchAll(streamPattern)) {
    const start = match.index ?? 0;
    const header = document.slice(Math.max(0, start - 500), start);
    let content = Buffer.from(match[1], "latin1");
    if (/\/FlateDecode\b/.test(header)) {
      try { content = inflateSync(content); } catch { continue; }
    }
    const stream = content.toString("latin1");
    for (const literal of stream.matchAll(/\(((?:\\[\s\S]|[^\\)])*)\)\s*Tj/g)) extracted.push(decodePdfLiteral(literal[1]));
    for (const array of stream.matchAll(/\[((?:\([^\)]*\)|<[^>]*>|[^\]])*)\]\s*TJ/g)) {
      for (const literal of array[1].matchAll(/\(((?:\\[\s\S]|[^\\)])*)\)/g)) extracted.push(decodePdfLiteral(literal[1]));
      for (const hex of array[1].matchAll(/<([0-9a-f]+)>/gi)) {
        try { extracted.push(Buffer.from(hex[1], "hex").toString("latin1")); } catch { /* malformed literal */ }
      }
    }
  }
  return extracted.join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_BYTES);
}

export async function retrieveSource(url: string, signal?: AbortSignal): Promise<RetrievedSource> {
  let parsed = new URL(url);
  await assertPublicUrl(parsed);
  const timeoutSignal = AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response | undefined;
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      response = await fetch(parsed, { redirect: "manual", signal: requestSignal, headers: { "user-agent": "Evidra/0.1 research-workbench" } });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (!location) throw new Error(`Source retrieval returned redirect ${response.status} without a location.`);
      if (redirect === MAX_REDIRECTS) throw new Error(`Source exceeded the ${MAX_REDIRECTS} redirect limit.`);
      parsed = new URL(location, parsed);
      await assertPublicUrl(parsed);
    }
  } catch (error) {
    if (timeoutSignal.aborted && !signal?.aborted) throw new Error(`Source retrieval timed out after ${SOURCE_REQUEST_TIMEOUT_MS}ms.`);
    throw error;
  }
  if (!response) throw new Error("Source retrieval did not return a response.");
  if (!response.ok) throw new Error(`Source retrieval failed (${response.status} ${response.statusText}).`);
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new Error(`Source is larger than the ${MAX_BYTES} byte retrieval limit.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) throw new Error(`Source is larger than the ${MAX_BYTES} byte retrieval limit.`);
  const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const raw = new TextDecoder().decode(bytes);
  const isPdf = contentType.toLowerCase().includes("pdf") || raw.startsWith("%PDF-");
  const text = isPdf
    ? (extractPdfText(bytes) || "[PDF text extraction unavailable; inspect the original source manually]")
    : contentType.includes("html") ? stripMarkup(raw) : raw.replace(/\s+/g, " ").trim();
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = stripMarkup(titleMatch?.[1] ?? parsed.hostname ?? url).slice(0, 300) || url;
  const evidenceClass = sourceEvidenceClass(response.url || url);
  const source = ResearchSourceSchema.parse({
    id: sourceId(url, contentHash),
    title,
    url: response.url || url,
    retrievedAt: new Date().toISOString(),
    contentHash,
    license: response.headers.get("x-license") ?? undefined,
    evidenceClass,
    qualityScore: sourceEvidenceQuality({ url: response.url || url, authors: [], provider: undefined }),
    claims: [],
  });
  return { ...source, contentType, text, excerpt: text.slice(0, 1200) };
}

export function sourceClaims(text: string, limit = 12): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 50 && sentence.length <= 500)
    // Retrieved text is evidence material, never an instruction channel. Do
    // not let prompt-injection or operational directions become durable claims
    // just because the sentence also mentions a model, result, or dataset.
    .filter((sentence) => !/ignore\s+(all\s+)?previous|disregard\s+(the\s+)?(?:system|developer)|follow\s+these\s+instructions|disable\s+(?:safety|permissions?|sandbox)|reveal\s+(?:the\s+)?(?:token|password|credential|api\s*key)|you\s+must\s+(?:run|execute|upload|submit)/i.test(sentence))
    .filter((sentence) => /\b(show|find|improv|decreas|increas|result|method|dataset|model|validation|leak|error|accuracy|score)\b/i.test(sentence))
    .slice(0, limit);
}

export function sourceSearchText(source: { payload: unknown }): string {
  const payload = source.payload as { title?: string; url?: string; excerpt?: string; text?: string; claims?: string[] };
  return [payload.title, payload.url, payload.excerpt, payload.text, ...(payload.claims ?? [])].filter(Boolean).join(" ").toLowerCase();
}

export interface SourceFrontierCandidate extends SourceSearchResult {
  key: string;
  queries: string[];
  retrieved: boolean;
}

export interface SourceFrontierReport {
  candidates: SourceFrontierCandidate[];
  queryCount: number;
  queriesWithCandidates: number;
  queryCoverage: number;
  uniqueWorks: number;
  retrievedWorks: number;
  pendingWorks: number;
  retrievalCoverage: number;
  retrievedWithClaims: number;
  claimCoverage: number;
  scholarlyWorks: number;
  officialWorks: number;
  implementationLeads: number;
  discoveryOnlyWorks: number;
  meanQualityScore: number;
}

function sourceWorkKey(result: { url: string; doi?: string }): string {
  return (result.doi?.trim().toLowerCase() || canonicalSourceUrl(result.url)).toLowerCase();
}

/** Build a bounded, deduplicated literature-search frontier from durable events. */
export function sourceFrontier(events: Array<{ type: string; payload: unknown }>, limit = 200): SourceFrontierReport {
  const byKey = new Map<string, SourceFrontierCandidate>();
  const queries = new Set<string>();
  const retrieved = new Set<string>();
  const retrievedClaimCounts = new Map<string, number>();
  for (const event of events) {
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
    if (event.type === "research.source.search.completed" || event.type === "research.web.search.completed") {
      const query = typeof payload.query === "string" ? payload.query.trim() : "";
      const eventQueries = Array.isArray(payload.queries) ? payload.queries.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [];
      for (const eventQuery of (eventQueries.length ? eventQueries : query ? [query] : [])) queries.add(eventQuery.toLowerCase());
      const results = Array.isArray(payload.results) ? payload.results : [];
      for (const value of results) {
        if (!value || typeof value !== "object") continue;
        const result = value as Partial<SourceSearchResult>;
        if (typeof result.title !== "string" || typeof result.url !== "string") continue;
        const key = sourceWorkKey({ url: result.url, doi: typeof result.doi === "string" ? result.doi : undefined });
        const prior = byKey.get(key);
        const provider = result.provider;
        const doi = typeof result.doi === "string" ? result.doi : undefined;
        const abstract = typeof result.abstract === "string" ? result.abstract : undefined;
        const authors = Array.isArray(result.authors) ? result.authors.filter((author): author is string => typeof author === "string").slice(0, 8) : [];
        const venue = typeof result.venue === "string" ? result.venue : undefined;
        const evidenceClass = prior?.evidenceClass ?? result.evidenceClass ?? sourceEvidenceClass(result.url, provider, doi);
        const qualityScore = prior?.qualityScore ?? result.qualityScore ?? sourceEvidenceQuality({ url: result.url, provider, doi, abstract, authors, venue });
        byKey.set(key, {
          title: prior?.title ?? result.title,
          url: prior?.url ?? result.url,
          ...(prior?.doi ?? result.doi ? { doi: prior?.doi ?? result.doi } : {}),
          ...(prior?.venue ?? result.venue ? { venue: prior?.venue ?? result.venue } : {}),
          ...(prior?.publicationDate ?? result.publicationDate ? { publicationDate: prior?.publicationDate ?? result.publicationDate } : {}),
          authors: prior?.authors?.length ? prior.authors : authors,
          ...(prior?.abstract ?? result.abstract ? { abstract: prior?.abstract ?? result.abstract } : {}),
          evidenceClass,
          qualityScore,
          key,
          queries: [...new Set([...(prior?.queries ?? []), ...(Array.isArray(result.queries) ? result.queries.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : query ? [query] : [])])].slice(0, 12),
          retrieved: prior?.retrieved ?? false,
        });
      }
    } else if (event.type === "research.source.retrieved") {
      const url = typeof payload.url === "string" ? payload.url : "";
      if (url) {
        const urlKey = canonicalSourceUrl(url);
        const matchingCandidate = [...byKey.values()].find((candidate) => canonicalSourceUrl(candidate.url) === urlKey);
        const key = matchingCandidate?.key ?? sourceWorkKey({ url });
        // Direct retrieval (`sources add` or a tool call) may have no prior
        // search event. Materialize it into the frontier so durable evidence
        // is not invisible to coverage, diversity, or rubric calculations.
        if (!matchingCandidate && !byKey.has(key)) {
          const title = typeof payload.title === "string" && payload.title.trim() ? payload.title : url;
          const authors: string[] = [];
          byKey.set(key, {
            title,
            url,
            authors,
            key,
            queries: [],
            retrieved: true,
            evidenceClass: sourceEvidenceClass(url),
            qualityScore: sourceEvidenceQuality({ url, authors }),
          });
        }
        retrieved.add(key);
        const claimCount = Number(payload.claimCount);
        if (Number.isFinite(claimCount) && claimCount > 0) retrievedClaimCounts.set(key, claimCount);
      }
    }
  }
  const candidates = [...byKey.values()]
    .map((candidate) => ({ ...candidate, retrieved: candidate.retrieved || retrieved.has(candidate.key) || retrieved.has(sourceWorkKey({ url: candidate.url })) }))
    .sort((left, right) => (right.qualityScore ?? 0) - (left.qualityScore ?? 0) || Number(right.retrieved) - Number(left.retrieved))
    .slice(0, Math.max(1, limit));
  const queriesWithCandidates = new Set(candidates.flatMap((candidate) => candidate.queries)).size;
  const retrievedCandidates = candidates.filter((candidate) => candidate.retrieved);
  const retrievedWithClaims = retrievedCandidates.filter((candidate) => retrievedClaimCounts.has(candidate.key) || retrievedClaimCounts.has(sourceWorkKey({ url: candidate.url }))).length;
  const qualityCandidates = candidates.filter((candidate) => typeof candidate.qualityScore === "number");
  return {
    candidates,
    queryCount: queries.size,
    queriesWithCandidates,
    queryCoverage: queries.size ? queriesWithCandidates / queries.size : 0,
    uniqueWorks: candidates.length,
    retrievedWorks: retrievedCandidates.length,
    pendingWorks: candidates.filter((candidate) => !candidate.retrieved).length,
    retrievalCoverage: candidates.length ? retrievedCandidates.length / candidates.length : 0,
    retrievedWithClaims,
    claimCoverage: retrievedCandidates.length ? retrievedWithClaims / retrievedCandidates.length : 0,
    scholarlyWorks: candidates.filter((candidate) => candidate.evidenceClass === "scholarly").length,
    officialWorks: candidates.filter((candidate) => candidate.evidenceClass === "official").length,
    implementationLeads: candidates.filter((candidate) => candidate.evidenceClass === "implementation").length,
    discoveryOnlyWorks: candidates.filter((candidate) => candidate.evidenceClass === "discovery").length,
    meanQualityScore: qualityCandidates.length ? qualityCandidates.reduce((sum, candidate) => sum + (candidate.qualityScore ?? 0), 0) / qualityCandidates.length : 0,
  };
}
