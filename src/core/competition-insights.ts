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

function cleanParticipant(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value
    .replace(/participants?#\S*/gi, "")
    .replace(/\b(?:loading\.\.\.|view|show|no change)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/^[|,:\-\s]+|[|,:\-\s]+$/g, "")
    .trim();
  return cleaned && cleaned.length <= 160 ? cleaned : undefined;
}

function parseTableLeaderboard(lines: string[]): LeaderboardObservation[] {
  const observations: LeaderboardObservation[] = [];
  for (let headerIndex = 0; headerIndex < lines.length; headerIndex += 1) {
    const header = (lines[headerIndex] ?? "").split("|").map((cell) => cell.trim().toLowerCase());
    if (header.length < 3) continue;
    const rankIndex = header.findIndex((cell) => /^(?:#|rank|place|position)$/.test(cell));
    const participantIndex = header.findIndex((cell) => /\b(?:participants?|teams?|entrants?|competitors?|users?|names?)\b/.test(cell));
    const scoreCandidates = header
      .map((cell, index) => ({ cell, index }))
      .filter(({ cell }) => /\b(?:score|metric|value)\b/i.test(cell) && !/\b(?:mse|error|loss|utili[sz]|failed|entries|count|submission|rank|time)\b/i.test(cell))
      .sort((left, right) => {
        const primary = (cell: string) => /adjusted|public|leaderboard|best/i.test(cell) ? 0 : 1;
        return primary(left.cell) - primary(right.cell);
      });
    const scoreIndex = scoreCandidates[0]?.index;
    if (participantIndex < 0 || scoreIndex === undefined) continue;

    let sawDataRow = false;
    for (let rowIndex = headerIndex + 1; rowIndex < lines.length; rowIndex += 1) {
      const original = lines[rowIndex] ?? "";
      // Real competition pages often place pagination controls, captions, or
      // accessibility text between <thead> and <tbody>. Ignore that bounded
      // separator noise; once data rows have begun, stop at the next section.
      if (!original.includes("|")) {
        if (sawDataRow) break;
        if (/^#{1,6}\s|^(?:discussion|resources|submissions)\b/i.test(original)) break;
        continue;
      }
      const cells = original.split("|").map((cell) => cell.trim());
      if (cells.length < Math.max(participantIndex, scoreIndex, rankIndex) + 1) continue;
      const scoreCell = cells[scoreIndex];
      const scoreText = scoreCell?.match(new RegExp(NUMBER))?.[0];
      const score = finiteNumber(scoreText);
      if (score === undefined) continue;
      sawDataRow = true;
      const rankText = rankIndex >= 0 ? cells[rankIndex] : undefined;
      const rankMatch = rankText?.match(/#?\s*(\d{1,6})/);
      const rank = rankMatch ? Number(rankMatch[1]) : undefined;
      const participant = cleanParticipant(cells[participantIndex]);
      observations.push({ rank, participant, score, raw: original.trim().replace(/\s+/g, " ").slice(0, 500) });
      if (observations.length >= 100) return observations;
    }
    if (observations.length) return observations;
  }
  return observations;
}

function parseLeaderboard(lines: string[]): LeaderboardObservation[] {
  const tableRows = parseTableLeaderboard(lines);
  if (tableRows.length) return tableRows;
  const observations: LeaderboardObservation[] = [];
  for (const original of lines) {
    const raw = original.trim().replace(/\s+/g, " ");
    if (!raw || raw.length > 500) continue;
    if (raw.includes("|")) {
      const cells = raw.split("|").map((cell) => cell.trim()).filter(Boolean);
      const rankCellIndex = cells.findIndex((cell) => /^#?\s*\d{1,6}$/.test(cell));
      const scoreCell = cells.find((cell) => /\b(?:score|metric|value)\s*[:=]/i.test(cell));
      const score = finiteNumber(scoreCell?.match(new RegExp(NUMBER))?.[0]);
      if (rankCellIndex >= 0 && score !== undefined) {
        const rank = Number(cells[rankCellIndex]?.replace(/^#\s*/, ""));
        const participant = cleanParticipant(cells.slice(rankCellIndex + 1).find((cell) => !/\b(?:score|metric|value)\s*[:=]/i.test(cell)));
        observations.push({ rank, participant, score, raw });
        if (observations.length >= 100) break;
        continue;
      }
    }
    const rankMatch = raw.match(/^#?\s*(\d{1,6})(?:[)|,:\-]\s*|\.\s+|\s+)(.*)$/);
    const scoreMatch = raw.match(new RegExp(`\\b(?:score|metric|value)\\s*[:=]\\s*(${NUMBER})`, "i"));
    const trailingScore = scoreMatch ? undefined : raw.match(new RegExp(`(?:^|[|,\\t ])(${NUMBER})\\s*$`));
    const rank = rankMatch ? Number(rankMatch[1]) : undefined;
    const score = finiteNumber(scoreMatch?.[1] ?? trailingScore?.[1]);
    // Bare numeric lines are almost always rank, count, time, or auxiliary
    // metrics from a flattened table—not a score. Require a participant or an
    // explicit metric label before treating an unstructured line as evidence.
    if (rank === undefined && score === undefined) continue;
    if (!scoreMatch && (!rankMatch?.[2]?.trim() || !trailingScore)) continue;
    let participant = rankMatch?.[2]?.trim();
    if (participant) participant = participant.replace(new RegExp(`(?:score|metric|value)\\s*[:=].*$`, "i"), "").replace(/[|,:\\-]+\\s*$/, "").trim();
    participant = cleanParticipant(participant);
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
