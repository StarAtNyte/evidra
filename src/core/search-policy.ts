export type SearchOperator = "greedy" | "ucb_portfolio" | "ablation" | "combination" | "replication" | "audit";

export interface SearchArm {
  id: string;
  operator: SearchOperator;
  attempts: number;
  successes: number;
  meanReward: number;
  cost: number;
  novelty: number;
}

export interface SearchPolicyInput {
  arms: SearchArm[];
  remainingBudgetMinutes: number;
  recentFailures: number;
  evidenceConflicts: number;
  exploration?: number;
}

export interface RankedSearchArm extends SearchArm {
  score: number;
  rationale: string;
}

/**
 * Select the next research operator with an evidence-aware UCB portfolio.
 * Untried arms are forced ahead of repeated exploitation; cost and novelty
 * prevent the controller from spending the whole campaign on one idea family.
 */
export function rankSearchArms(input: SearchPolicyInput): RankedSearchArm[] {
  const exploration = input.exploration ?? 1.4;
  const totalAttempts = Math.max(1, input.arms.reduce((sum, arm) => sum + arm.attempts, 0));
  return input.arms.map((arm) => {
    const conflictPressure = input.evidenceConflicts > 0 && arm.operator === "audit" ? 0.8 : 0;
    const recoveryPressure = input.recentFailures > 0 && arm.operator === "replication" ? 0.35 : 0;
    const untriedBonus = arm.attempts === 0 ? 2 : 0;
    const uncertainty = arm.attempts === 0 ? 1 : exploration * Math.sqrt(Math.log(totalAttempts + 1) / arm.attempts);
    const costPenalty = Math.max(0, arm.cost) * 0.05;
    const score = arm.meanReward + uncertainty + arm.novelty * 0.5 + untriedBonus + conflictPressure + recoveryPressure - costPenalty;
    const rationale = arm.attempts === 0
      ? "untried operator: obtain information before over-exploiting a known direction"
      : `UCB reward ${arm.meanReward.toFixed(3)} with uncertainty ${uncertainty.toFixed(3)}`;
    return { ...arm, score, rationale };
  }).sort((left, right) => right.score - left.score);
}

/** Convert a measured metric delta into a bounded reward for future routing. */
export function searchReward(delta: number | undefined, valid: boolean, reproducible: boolean): number {
  if (!valid || delta === undefined || !Number.isFinite(delta)) return -1;
  const bounded = Math.max(-1, Math.min(1, delta));
  return bounded * (reproducible ? 1 : 0.7);
}
