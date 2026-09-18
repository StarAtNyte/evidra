import type { CompetitionResearchChannelKind } from "./competition-sources.js";

export interface LeaderboardObservation {
  rank?: number;
  participant?: string;
  score?: number;
  raw: string;
}

export interface DiscussionObservation {
  title: string;
  raw: string;
}

export interface CompetitionChannelInsights {
  kind: CompetitionResearchChannelKind;
  leaderboard: LeaderboardObservation[];
  discussions: DiscussionObservation[];
  signals: string[];
}

const NUMBER = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?";
const SIGNAL_TERMS = /\b(?:baseline|metric|score|submission|leak(?:age)?|dataset|seed|augmentation|split|replicat(?:e|ion)|error|validation|train(?:ing)?|test)\b/i;

function finiteNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseLeaderboard(lines: string[]): LeaderboardObservation[] {
  const observations: LeaderboardObservation[] = [];
  for (const original of lines) {
    const raw = original.trim().replace(/\s+/g, " ");
    if (!raw || raw.length > 500) continue;
    const rankMatch = raw.match(/^#?\s*(\d{1,6})\s*(?:[.)|,:\-]\s*|\s+)(.*)$/);
    const scoreMatch = raw.match(new RegExp(`\\b(?:score|metric|value)\\s*[:=]\\s*(${NUMBER})`, "i"));
    const trailingScore = scoreMatch ? undefined : raw.match(new RegExp(`(?:^|[|,\\t ])(${NUMBER})\\s*$`));
    const rank = rankMatch ? Number(rankMatch[1]) : undefined;
    const score = finiteNumber(scoreMatch?.[1] ?? trailingScore?.[1]);
    if (rank === undefined && score === undefined) continue;
    let participant = rankMatch?.[2]?.trim();
    if (participant) participant = participant.replace(new RegExp(`(?:score|metric|value)\\s*[:=].*$`, "i"), "").replace(/[|,:\\-]+\\s*$/, "").trim();
    if (participant) participant = participant.replace(/\s*[|,:-]+\s*$/, "").trim();
    if (!participant || participant.length > 160) participant = undefined;
    observations.push({ rank, participant, score, raw });
    if (observations.length >= 100) break;
  }
  const seen = new Set<string>();
  return observations.filter((entry) => {
    const key = `${entry.rank ?? ""}|${entry.participant ?? ""}|${entry.score ?? ""}|${entry.raw}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseDiscussions(lines: string[]): DiscussionObservation[] {
  const discussions: DiscussionObservation[] = [];
  for (const original of lines) {
    const raw = original.trim().replace(/\s+/g, " ");
    const heading = raw.match(/^#{1,6}\s+(.{3,240})$/)?.[1]
      ?? raw.match(/^(?:discussion|topic|title)\s*:\s*(.{3,240})$/i)?.[1];
    if (!heading || /^(discussion|topics?|leaderboard|navigation|home)$/i.test(heading.trim())) continue;
    discussions.push({ title: heading.trim(), raw });
    if (discussions.length >= 50) break;
  }
  const seen = new Set<string>();
  return discussions.filter((entry) => {
    const key = entry.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Extract bounded, typed observations from untrusted competition-channel text. */
export function extractCompetitionInsights(text: string, kind: CompetitionResearchChannelKind): CompetitionChannelInsights {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 10_000);
  const leaderboard = kind === "leaderboard" ? parseLeaderboard(lines) : [];
  const discussions = kind === "discussion" ? parseDiscussions(lines) : [];
  const signals = lines.filter((line) => !/^#{1,6}\s/.test(line) && SIGNAL_TERMS.test(line)).map((line) => line.replace(/\s+/g, " ").slice(0, 300)).filter((line, index, all) => all.indexOf(line) === index).slice(0, 20);
  return { kind, leaderboard, discussions, signals };
}
