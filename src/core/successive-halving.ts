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
  /** Normalized higher-is-better objective value for non-metric evaluators. */
  objectiveValue?: number;
  /** Legacy alias for metric-based competitions. */
  metric?: number;
  /** Optional normalized higher-is-better objective vector for multi-objective promotion. */
  objectiveValues?: Record<string, number>;
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
  objectiveNames: string[] = [],
): string[] {
  const order = new Map(stage.candidateIds.map((id, index) => [id, index]));
  const valueOf = (outcome: HalvingOutcome): number | undefined => outcome.objectiveValue ?? outcome.metric;
  const eligible = outcomes.filter((outcome) => stage.candidateIds.includes(outcome.id) && outcome.valid);
  if (!objectiveNames.length) {
    return eligible
      .filter((outcome) => Number.isFinite(valueOf(outcome)))
      .sort((left, right) => {
        const leftValue = valueOf(left)!;
        const rightValue = valueOf(right)!;
        const difference = direction === "maximize" ? rightValue - leftValue : leftValue - rightValue;
        return difference || (order.get(left.id)! - order.get(right.id)!);
      })
      .slice(0, stage.retainCount)
      .map((outcome) => outcome.id);
  }

  // Objective vectors are supplied in a common higher-is-better scale by the
  // evaluator. Rank Pareto fronts first; a vector sum only breaks ties within
  // a front and does not turn differently scaled objectives into a fake score.
  const vectors = eligible.filter((outcome) => objectiveNames.every((name) => Number.isFinite(outcome.objectiveValues?.[name])));
  const dominates = (left: HalvingOutcome, right: HalvingOutcome): boolean => {
    const leftValues = objectiveNames.map((name) => left.objectiveValues![name]);
    const rightValues = objectiveNames.map((name) => right.objectiveValues![name]);
    return leftValues.every((value, index) => value >= rightValues[index]) && leftValues.some((value, index) => value > rightValues[index]);
  };
  const front = new Map<string, number>();
  for (const candidate of vectors) {
    let rank = 0;
    for (const other of vectors) if (other.id !== candidate.id && dominates(other, candidate)) rank += 1;
    front.set(candidate.id, rank);
  }
  return vectors
    .sort((left, right) => {
      const rankDifference = front.get(left.id)! - front.get(right.id)!;
      if (rankDifference) return rankDifference;
      const leftSum = objectiveNames.reduce((sum, name) => sum + left.objectiveValues![name], 0);
      const rightSum = objectiveNames.reduce((sum, name) => sum + right.objectiveValues![name], 0);
      return rightSum - leftSum || (order.get(left.id)! - order.get(right.id)!);
    })
    .slice(0, stage.retainCount)
    .map((outcome) => outcome.id);
}
