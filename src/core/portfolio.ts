export interface PortfolioCandidate {
  id: string;
  title: string;
  operator: string;
  expectedValue: number;
  costMinutes: number;
  novelty?: number;
  /** Expected information gain from resolving the candidate's uncertainty. */
  informationValue?: number;
  risk?: number;
  family?: string;
  quality?: number;
  /** Controller-derived evidence state for the hypothesis' falsification test. */
  falsificationStatus?: "untested" | "tested" | "supported" | "rejected" | "inconclusive";
  falsificationPriority?: number;
}

export interface PortfolioPlanOptions {
  maxCandidates: number;
  maxParallel: number;
  budgetMinutes: number;
  reserveMinutes?: number;
  costHistory?: CostObservation[];
  executionContext?: CostContext;
}

export interface PortfolioPlan {
  selected: PortfolioCandidate[];
  rejected: Array<{ candidate: PortfolioCandidate; reason: string }>;
  reservedMinutes: number;
  parallelism: number;
  halving: SuccessiveHalvingPlan;
  evolution: import("./evolution.js").EvolutionPlan;
  costEstimates: Record<string, CostEstimate>;
}

/**
 * Select a bounded best-of-k portfolio under a real time budget.
 *
 * The planner deliberately rewards value per minute, but keeps strategy and
 * hypothesis-family diversity so a noisy first estimate cannot monopolize a
 * campaign. It is pure: durable manifests are created by the caller.
 */
export function planPortfolio(candidates: PortfolioCandidate[], options: PortfolioPlanOptions): PortfolioPlan {
  const maxCandidates = Math.max(1, Math.floor(options.maxCandidates));
  const parallelism = Math.max(1, Math.min(Math.floor(options.maxParallel), maxCandidates));
  const available = Math.max(0, options.budgetMinutes - (options.reserveMinutes ?? 0));
  const rejected: PortfolioPlan["rejected"] = [];
  const selected: PortfolioCandidate[] = [];
  const operators = new Set<string>();
  const families = new Set<string>();
  let reservedMinutes = 0;
  const costEstimates: Record<string, CostEstimate> = {};
  const estimatedCost = (candidate: PortfolioCandidate): number => {
    const estimate = estimateCost(candidate.operator, candidate.costMinutes, options.costHistory ?? [], options.executionContext);
    costEstimates[candidate.id] = estimate;
    return Math.max(0.1, estimate.upperMinutes);
  };

  const ranked = [...candidates]
    .filter((candidate) => candidate.id && Number.isFinite(candidate.expectedValue) && Number.isFinite(candidate.costMinutes))
    .sort((left, right) => score(right, options.costHistory, options.executionContext) - score(left, options.costHistory, options.executionContext));
  for (const candidate of ranked) {
    if (selected.length >= maxCandidates) {
      rejected.push({ candidate, reason: "portfolio capacity reached" });
      continue;
    }
    const cost = estimatedCost(candidate);
    const family = candidate.family ?? candidate.title;
    const duplicateOperator = operators.has(candidate.operator);
    const duplicateFamily = families.has(family);
    const wouldExceed = reservedMinutes + cost > available;
    if (wouldExceed) {
      rejected.push({ candidate, reason: "estimated cost exceeds remaining portfolio budget" });
      continue;
    }
    if (duplicateOperator && selected.length < Math.min(2, maxCandidates)) {
      rejected.push({ candidate, reason: "duplicate search operator; preserve strategy diversity" });
      continue;
    }
    if (duplicateFamily) {
      rejected.push({ candidate, reason: "duplicate hypothesis family" });
      continue;
    }
    selected.push(candidate);
    operators.add(candidate.operator);
    families.add(family);
    reservedMinutes += cost;
  }
  // The autonomous portfolio controller currently owns two concrete worker
  // stages: reduced screen, then full validation. Deeper generic schedules
  // remain available through planSuccessiveHalving for adapters that expose
  // more intermediate worker contracts.
  const halving = planSuccessiveHalving(selected.map((candidate) => ({ id: candidate.id, costMinutes: costEstimates[candidate.id]?.upperMinutes ?? Math.max(0.1, candidate.costMinutes), family: candidate.family })), available, { rounds: 2 });
  const evolution = planEvolutionaryIslands(selected, Math.min(parallelism, 4));
  return { selected, rejected, reservedMinutes, parallelism, halving, evolution, costEstimates };
}

function score(candidate: PortfolioCandidate, history?: CostObservation[], context?: CostContext): number {
  const cost = estimateCost(candidate.operator, candidate.costMinutes, history ?? [], context).upperMinutes;
  const novelty = Math.max(0, Math.min(1, candidate.novelty ?? 0));
  const informationValue = Math.max(0, Math.min(1, candidate.informationValue ?? 0));
  const risk = Math.max(0, Math.min(1, candidate.risk ?? 0));
  const quality = Math.max(0.25, Math.min(1, candidate.quality ?? 1));
  const agendaPriority = Number.isFinite(candidate.falsificationPriority) ? Math.max(0, Math.min(100, candidate.falsificationPriority ?? 0)) / 100 : undefined;
  const statusAdjustment = candidate.falsificationStatus === "untested" ? 0.35
    : candidate.falsificationStatus === "inconclusive" ? 0.15
      : candidate.falsificationStatus === "rejected" ? -0.2
        : candidate.falsificationStatus === "tested" ? -0.08
          : 0;
  // Falsification state is a scheduling prior, not a hard gate: a strong
  // changed route can still revisit a rejected direction, while untouched
  // hypotheses receive the information-value boost they deserve.
  const falsificationBonus = statusAdjustment + (agendaPriority ?? 0) * 0.15;
  return (candidate.expectedValue * quality + novelty * 0.2 + informationValue * 0.25 - risk * 0.1 + falsificationBonus) / cost;
}
import { estimateCost, type CostContext, type CostEstimate, type CostObservation } from "./cost-model.js";
import { planSuccessiveHalving, type SuccessiveHalvingPlan } from "./successive-halving.js";
import { planEvolutionaryIslands } from "./evolution.js";
