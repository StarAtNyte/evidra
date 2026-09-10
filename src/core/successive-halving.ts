export interface HalvingCandidate {
  id: string;
  costMinutes: number;
  family?: string;
}

export interface HalvingStage {
  index: number;
  fraction: number;
  candidateIds: string[];
  budgetMinutes: number;
  retainCount: number;
  rationale: string;
}

export interface SuccessiveHalvingPlan {
  stages: HalvingStage[];
  estimatedWorstCaseMinutes: number;
  feasible: boolean;
  reason: string;
}

export interface HalvingOutcome {
  id: string;
  metric?: number;
  valid: boolean;
}

/**
 * Allocate a portfolio across cheap-to-expensive evaluation stages. The
 * planner is deliberately agnostic to the domain: a stage fraction can mean
 * fewer folds, fewer examples, fewer simulation steps, or a shorter proof
 * search. The worker/evaluator owns that interpretation.
 */
export function planSuccessiveHalving(
  candidates: HalvingCandidate[],
  budgetMinutes: number,
  options: { rounds?: number; reductionFactor?: number; initialFraction?: number } = {},
): SuccessiveHalvingPlan {
  const usable = candidates.filter((candidate) => candidate.id && Number.isFinite(candidate.costMinutes) && candidate.costMinutes > 0);
  const rounds = Math.max(1, Math.min(4, Math.floor(options.rounds ?? 3)));
  const reductionFactor = Math.max(2, Math.min(4, Math.floor(options.reductionFactor ?? 2)));
  const initialFraction = Math.max(0.05, Math.min(1, options.initialFraction ?? 0.15));
  if (!usable.length) return { stages: [], estimatedWorstCaseMinutes: 0, feasible: false, reason: "no candidates have finite positive costs" };
  if (!Number.isFinite(budgetMinutes) || budgetMinutes <= 0) return { stages: [], estimatedWorstCaseMinutes: 0, feasible: false, reason: "halving budget must be positive" };

  const stages: HalvingStage[] = [];
  let active = [...usable];
  let estimatedWorstCaseMinutes = 0;
  for (let index = 0; index < rounds; index += 1) {
    const fraction = index === rounds - 1 ? 1 : Math.min(1, initialFraction * (1 / initialFraction) ** (index / Math.max(1, rounds - 1)));
    const stageBudget = active.reduce((sum, candidate) => sum + candidate.costMinutes * fraction, 0);
    const retainCount = index === rounds - 1 ? active.length : Math.max(1, Math.ceil(active.length / reductionFactor));
    stages.push({
      index,
      fraction,
      candidateIds: active.map((candidate) => candidate.id),
      budgetMinutes: stageBudget,
      retainCount,
      rationale: index === 0
        ? "screen every candidate with the cheapest valid evaluator configuration"
        : index === rounds - 1
          ? "spend full validation budget only on survivors"
          : `retain the top ${retainCount} candidate(s) after measured promotion evidence`,
    });
    estimatedWorstCaseMinutes += stageBudget;
    // Reserve the worst-case cost of the most expensive survivors. Which
    // candidates survive is unknown at planning time, so remain conservative.
    active = [...active].sort((left, right) => right.costMinutes - left.costMinutes).slice(0, retainCount);
  }
  const feasible = estimatedWorstCaseMinutes <= budgetMinutes;
  return {
    stages,
    estimatedWorstCaseMinutes,
    feasible,
    reason: feasible
      ? `planned ${stages.length} evaluation stage(s) within ${budgetMinutes.toFixed(2)} minutes`
      : `worst-case halving cost ${estimatedWorstCaseMinutes.toFixed(2)} minutes exceeds ${budgetMinutes.toFixed(2)} minutes`,
  };
}

/** Promote only valid measured outcomes; ties retain deterministic candidate order. */
export function promoteHalvingStage(
  stage: HalvingStage,
  outcomes: HalvingOutcome[],
  direction: "maximize" | "minimize",
): string[] {
  const order = new Map(stage.candidateIds.map((id, index) => [id, index]));
  return outcomes
    .filter((outcome) => stage.candidateIds.includes(outcome.id) && outcome.valid && Number.isFinite(outcome.metric))
    .sort((left, right) => {
      const difference = direction === "maximize" ? right.metric! - left.metric! : left.metric! - right.metric!;
      return difference || (order.get(left.id)! - order.get(right.id)!);
    })
    .slice(0, stage.retainCount)
    .map((outcome) => outcome.id);
}
