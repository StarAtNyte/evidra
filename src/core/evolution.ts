import type { PortfolioCandidate } from "./portfolio.js";

export interface EvolutionIsland {
  id: string;
  family: string;
  seedCandidateId: string;
  candidateIds: string[];
  strategy: "independent_seed";
  migrateTo?: string;
}

export interface EvolutionCrossoverProposal {
  id: string;
  parentCandidateIds: [string, string];
  targetIslandId: string;
  rationale: "operator_diversity" | "family_diversity";
  requiresMatchedEvaluation: true;
  executable: false;
}

export interface EvolutionPlan {
  enabled: boolean;
  maxIslands: number;
  islands: EvolutionIsland[];
  crossoverProposals: EvolutionCrossoverProposal[];
  policy: "bounded_islands_v1";
}

/** Propose bounded evolutionary work without inventing patches or running trials. */
export function planEvolutionaryIslands(candidates: PortfolioCandidate[], maxIslands: number): EvolutionPlan {
  const limit = Math.max(0, Math.floor(maxIslands));
  const eligible = candidates.filter((candidate) => candidate.id && ["evolutionary", "combination", "mcts"].includes(candidate.operator)).slice(0, limit);
  const islands = eligible.map((candidate, index): EvolutionIsland => ({
    id: `island_${index + 1}_${stableToken(candidate.id)}`,
    family: candidate.family ?? candidate.title,
    seedCandidateId: candidate.id,
    candidateIds: [candidate.id],
    strategy: "independent_seed",
    migrateTo: eligible.length > 1 ? `island_${(index + 1) % eligible.length + 1}_${stableToken(eligible[(index + 1) % eligible.length].id)}` : undefined,
  }));
  const crossoverProposals: EvolutionCrossoverProposal[] = [];
  for (let index = 1; index < eligible.length; index += 1) {
    const left = eligible[index - 1];
    const right = eligible[index];
    crossoverProposals.push({ id: `cross_${stableToken(left.id)}_${stableToken(right.id)}`, parentCandidateIds: [left.id, right.id], targetIslandId: islands[index].id, rationale: left.operator === right.operator ? "family_diversity" : "operator_diversity", requiresMatchedEvaluation: true, executable: false });
  }
  return { enabled: islands.length > 0, maxIslands: limit, islands, crossoverProposals, policy: "bounded_islands_v1" };
}

function stableToken(value: string): string {
  let hash = 2166136261;
  for (const character of value) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
}
