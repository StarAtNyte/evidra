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

export interface CompetitionSourceChange {
  changed: boolean;
  /** Sentences present now but absent from the prior snapshot, in page order. */
  added: string[];
  /** Count of prior sentences no longer present. */
  removedCount: number;
}

function sourceSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 12);
}

/**
 * Compare two snapshots of a mutable competition channel. Rules, timelines and
 * leaderboards change mid-campaign (a new phase, a new quota, released data); a
 * campaign that only re-reads them as claims never notices that its objective moved.
 */
export function competitionSourceChange(priorText: string | undefined, currentText: string, maxAdded = 12): CompetitionSourceChange {
  if (priorText === undefined) return { changed: false, added: [], removedCount: 0 };
  const prior = sourceSentences(priorText);
  const current = sourceSentences(currentText);
  const priorSet = new Set(prior);
  const currentSet = new Set(current);
  const added = [...new Set(current.filter((sentence) => !priorSet.has(sentence)))];
  const removedCount = new Set(prior.filter((sentence) => !currentSet.has(sentence))).size;
  return { changed: added.length > 0 || removedCount > 0, added: added.slice(0, maxAdded), removedCount };
}

export interface CompetitionChangeEvent {
  url: string;
  channelKind: string;
  added: string[];
  removedCount: number;
  at: string;
}

/**
 * Directive for the next cycle after a competition channel changed. Leaderboards
 * change constantly, so only rule, timeline and documentation changes force a
 * re-orientation; leaderboard changes are reported as context.
 */
export function competitionChangeGuidance(changes: CompetitionChangeEvent[], maxChars = 2_400): string {
  if (!changes.length) return "";
  const structural = changes.filter((change) => change.channelKind !== "leaderboard" && change.channelKind !== "discussion");
  const lines: string[] = [];
  for (const change of changes) {
    lines.push(`- ${change.channelKind} ${change.url} changed at ${change.at} (${change.added.length} new, ${change.removedCount} removed sentences)`);
    for (const sentence of change.added.slice(0, 4)) lines.push(`    + ${sentence.slice(0, 240)}`);
  }
  const head = structural.length
    ? "COMPETITION CONTEXT CHANGED. Official rules, timeline or documentation differ from the snapshot this campaign planned against. Before spending compute, re-read the changed pages, check whether the phase, scored boards, submission limits, deadlines or allowed data changed, and re-plan the objective and evaluator if they did. Record what changed and what you decided."
    : "Competition standings or discussion changed since the last snapshot; use as context only.";
  const text = `${head}\n${lines.join("\n")}`;
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
