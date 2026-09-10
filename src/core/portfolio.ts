export interface PortfolioCandidate {
  id: string;
  title: string;
  operator: string;
  expectedValue: number;
  costMinutes: number;
  novelty?: number;
  risk?: number;
  family?: string;
  quality?: number;
}

export interface PortfolioPlanOptions {
  maxCandidates: number;
  maxParallel: number;
  budgetMinutes: number;
  reserveMinutes?: number;
}

export interface PortfolioPlan {
  selected: PortfolioCandidate[];
  rejected: Array<{ candidate: PortfolioCandidate; reason: string }>;
  reservedMinutes: number;
  parallelism: number;
  halving: SuccessiveHalvingPlan;
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

  const ranked = [...candidates]
    .filter((candidate) => candidate.id && Number.isFinite(candidate.expectedValue) && Number.isFinite(candidate.costMinutes))
    .sort((left, right) => score(right) - score(left));
  for (const candidate of ranked) {
    if (selected.length >= maxCandidates) {
      rejected.push({ candidate, reason: "portfolio capacity reached" });
      continue;
    }
    const cost = Math.max(0.1, candidate.costMinutes);
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
  const halving = planSuccessiveHalving(selected.map((candidate) => ({ id: candidate.id, costMinutes: Math.max(0.1, candidate.costMinutes), family: candidate.family })), available);
  return { selected, rejected, reservedMinutes, parallelism, halving };
}

function score(candidate: PortfolioCandidate): number {
  const cost = Math.max(0.1, candidate.costMinutes);
  const novelty = Math.max(0, Math.min(1, candidate.novelty ?? 0));
  const risk = Math.max(0, Math.min(1, candidate.risk ?? 0));
  const quality = Math.max(0.25, Math.min(1, candidate.quality ?? 1));
  return (candidate.expectedValue * quality + novelty * 0.2 - risk * 0.1) / cost;
}
import { planSuccessiveHalving, type SuccessiveHalvingPlan } from "./successive-halving.js";
