import type { CompetitionConfig } from "./types.js";
import { canonicalSourceUrl } from "./sources.js";

export type CompetitionResearchChannelKind = NonNullable<CompetitionConfig["researchChannels"]>[number]["kind"] | "general";

export interface CompetitionResearchSource {
  url: string;
  kind: CompetitionResearchChannelKind;
  refreshMinutes?: number;
}

/**
 * Mutable competition channels need a shorter default freshness window than
 * papers/repositories. A campaign rechecks these limits at each safe cycle
 * boundary so stale rules, standings, and discussion advice do not persist.
 */
export function competitionSourceRefreshMs(source: CompetitionResearchSource): number {
  if (source.refreshMinutes !== undefined) return source.refreshMinutes * 60_000;
  switch (source.kind) {
    case "leaderboard": return 15 * 60_000;
    case "discussion": return 30 * 60_000;
    case "rules": return 60 * 60_000;
    default: return 6 * 60 * 60_000;
  }
}

/** Keep external channel observations distinct from paper-derived evidence. */
export function competitionResearchClaimType(kind: CompetitionResearchChannelKind): "literature" | "external_source" {
  return kind === "general" || kind === "paper" ? "literature" : "external_source";
}

/** Combine legacy anonymous URLs with typed channels without fetching duplicates. */
export function competitionResearchSources(config: CompetitionConfig): CompetitionResearchSource[] {
  const sources: CompetitionResearchSource[] = (config.researchSources ?? []).map((url) => ({ url, kind: "general" }));
  for (const channel of config.researchChannels ?? []) sources.push(channel);
  const unique = new Map<string, CompetitionResearchSource>();
  for (const source of sources) {
    const key = canonicalSourceUrl(source.url);
    const existing = unique.get(key);
    // A typed channel is more informative than a legacy anonymous URL.
    if (!existing || existing.kind === "general") unique.set(key, source);
  }
  return [...unique.values()];
}
