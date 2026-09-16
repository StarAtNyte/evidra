import type { CompetitionConfig } from "./types.js";

export type CompetitionResearchChannelKind = NonNullable<CompetitionConfig["researchChannels"]>[number]["kind"] | "general";

export interface CompetitionResearchSource {
  url: string;
  kind: CompetitionResearchChannelKind;
  refreshMinutes?: number;
}

/** Combine legacy anonymous URLs with typed channels without fetching duplicates. */
export function competitionResearchSources(config: CompetitionConfig): CompetitionResearchSource[] {
  const sources: CompetitionResearchSource[] = (config.researchSources ?? []).map((url) => ({ url, kind: "general" }));
  for (const channel of config.researchChannels ?? []) sources.push(channel);
  const unique = new Map<string, CompetitionResearchSource>();
  for (const source of sources) {
    const existing = unique.get(source.url);
    // A typed channel is more informative than a legacy anonymous URL.
    if (!existing || existing.kind === "general") unique.set(source.url, source);
  }
  return [...unique.values()];
}
