import type { CompetitionConfig } from "./types.js";
import { canonicalSourceUrl } from "./sources.js";

export type CompetitionResearchChannelKind = NonNullable<CompetitionConfig["researchChannels"]>[number]["kind"] | "general";

export interface CompetitionResearchSource {
  url: string;
  kind: CompetitionResearchChannelKind;
  refreshMinutes?: number;
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
