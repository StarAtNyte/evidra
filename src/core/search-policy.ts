export type SearchOperator = "greedy" | "ucb_portfolio" | "evolutionary" | "mcts" | "ablation" | "combination" | "replication" | "audit";

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
 * Select the next research operator with an explicit bounded search policy.
 * UCB is the default; evolutionary and MCTS-style arms expose different
 * exploration biases while retaining the same cost, evidence, and recovery
 * accounting.
 */
export function rankSearchArms(input: SearchPolicyInput): RankedSearchArm[] {
  const exploration = input.exploration ?? 1.4;
  const totalAttempts = Math.max(1, input.arms.reduce((sum, arm) => sum + arm.attempts, 0));
  return input.arms.map((arm) => {
    const conflictPressure = input.evidenceConflicts > 0 && arm.operator === "audit" ? 0.8 : 0;
    const recoveryPressure = input.recentFailures > 0 && arm.operator === "replication" ? 0.35 : 0;
    const untriedBonus = arm.attempts === 0 ? (arm.operator === "evolutionary" || arm.operator === "mcts" ? 2.4 : 2) : 0;
    const uncertainty = arm.attempts === 0 ? 1 : exploration * Math.sqrt(Math.log(totalAttempts + 1) / arm.attempts);
    const costPenalty = Math.max(0, arm.cost) * 0.05;
    const successRate = arm.attempts ? arm.successes / arm.attempts : 0;
    const strategyBonus = arm.operator === "greedy"
      ? arm.meanReward * 0.5 - uncertainty * 0.5
      : arm.operator === "evolutionary"
        ? arm.novelty * 0.9 + successRate * 0.25
        : arm.operator === "mcts"
          ? uncertainty * 1.25 + arm.novelty * 0.35
          : arm.novelty * 0.5;
    const score = arm.meanReward + strategyBonus + uncertainty + untriedBonus + conflictPressure + recoveryPressure - costPenalty;
    const rationale = arm.attempts === 0
      ? `untried ${arm.operator} policy: obtain information before over-exploiting a known direction`
      : `${arm.operator} reward ${arm.meanReward.toFixed(3)} with uncertainty ${uncertainty.toFixed(3)}`;
    return { ...arm, score, rationale };
  }).sort((left, right) => right.score - left.score);
}

/** Convert a measured metric delta into a bounded reward for future routing. */
export function searchReward(delta: number | undefined, valid: boolean, reproducible: boolean): number {
  if (!valid || delta === undefined || !Number.isFinite(delta)) return -1;
  const bounded = Math.max(-1, Math.min(1, delta));
  return bounded * (reproducible ? 1 : 0.7);
}
