export type SearchOperator = "greedy" | "ucb_portfolio" | "evolutionary" | "mcts" | "ablation" | "combination" | "replication" | "audit";

/** Operators exposed by the autonomous controller in stable ranking order. */
export const DEFAULT_SEARCH_OPERATORS: SearchOperator[] = ["greedy", "ucb_portfolio", "evolutionary", "mcts", "ablation", "combination", "replication", "audit"];
export const DEFAULT_SEARCH_OPERATOR_COSTS = [0.75, 1, 1.5, 2, 0.5, 0.7, 1, 0.25] as const;
export const DEFAULT_SEARCH_OPERATOR_NOVELTY = [0.55, 0.8, 0.95, 0.9, 0.6, 0.7, 0.2, 0.4] as const;

export interface SearchArm {
  id: string;
  operator: SearchOperator;
  attempts: number;
  successes: number;
  meanReward: number;
  /** Population variance of observed bounded rewards, when available. */
  rewardVariance?: number;
  cost: number;
  novelty: number;
  /** Optional context-local evidence; global history remains the prior. */
  contextAttempts?: number;
  contextMeanReward?: number;
  contextRewardVariance?: number;
}

export interface SearchPolicyInput {
  arms: SearchArm[];
  remainingBudgetMinutes: number;
  recentFailures: number;
  evidenceConflicts: number;
  exploration?: number;
  profile?: "exploration" | "evidence" | "recovery" | "budget";
}

export interface RankedSearchArm extends SearchArm {
  score: number;
  rationale: string;
}

export interface SearchPolicyEvent {
  selected?: RankedSearchArm;
  ranked?: RankedSearchArm[];
  portfolio?: RankedSearchArm[];
  remainingBudgetMinutes?: number;
  recentFailures?: number;
  evidenceConflicts?: number;
  competitionId?: string;
}

export interface SearchRewardEvent {
  operator?: string;
  reward?: number;
  durationSeconds?: number;
  valid?: boolean;
  reproducible?: boolean;
  competitionId?: string;
  executor?: string;
  provider?: string;
  model?: string;
  phase?: string;
}

export interface SearchPolicyEvidence {
  competitionId?: string;
  cycles: number;
  operators: Array<{
    operator: SearchOperator;
    selections: number;
    appearances: number;
    meanRank: number | null;
    meanScore: number | null;
    rewardSamples: number;
    meanReward: number | null;
    meanCostMinutes: number | null;
    failureRate: number | null;
    reproducibilityRate: number | null;
  }>;
}

/**
 * Turn durable policy and reward events into an auditable policy report.
 * Missing legacy metadata is accepted, but scoped events never leak between
 * unrelated competitions.
 */
export function summarizeSearchPolicyEvidence(
  events: Array<{ type: string; payload: unknown }>,
  competitionId?: string,
): SearchPolicyEvidence {
  const sameCompetition = (payload: unknown): boolean => {
    const value = payload && typeof payload === "object" ? payload as { competitionId?: unknown } : {};
    return value.competitionId === undefined || value.competitionId === competitionId;
  };
  const policies = events
    .filter((event) => event.type === "research.search_policy.selected" && sameCompetition(event.payload))
    .map((event) => event.payload as SearchPolicyEvent)
    .filter((event) => Array.isArray(event.ranked) || event.selected?.operator);
  const rewards = events
    .filter((event) => event.type === "research.search.reward" && sameCompetition(event.payload))
    .map((event) => event.payload as SearchRewardEvent);
  const operators = DEFAULT_SEARCH_OPERATORS.map((operator) => {
    const ranks: number[] = [];
    const scores: number[] = [];
    let selections = 0;
    for (const policy of policies) {
      const ranked = Array.isArray(policy.ranked) ? policy.ranked : policy.selected ? [policy.selected] : [];
      const index = ranked.findIndex((arm) => arm.operator === operator);
      if (index >= 0) {
        ranks.push(index + 1);
        const score = Number(ranked[index]?.score);
        if (Number.isFinite(score)) scores.push(score);
      }
      if (policy.selected?.operator === operator) selections += 1;
    }
    const operatorRewards = rewards.filter((reward) => reward.operator === operator && Number.isFinite(Number(reward.reward)));
    const values = operatorRewards.map((reward) => Number(reward.reward));
    const durations = operatorRewards.map((reward) => Number(reward.durationSeconds) / 60).filter((value) => Number.isFinite(value) && value > 0);
    const successful = operatorRewards.filter((reward) => reward.valid === true).length;
    const reproducible = operatorRewards.filter((reward) => reward.reproducible !== undefined);
    return {
      operator,
      selections,
      appearances: ranks.length,
      meanRank: ranks.length ? ranks.reduce((sum, value) => sum + value, 0) / ranks.length : null,
      meanScore: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null,
      rewardSamples: values.length,
      meanReward: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      meanCostMinutes: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
      failureRate: operatorRewards.length ? 1 - successful / operatorRewards.length : null,
      reproducibilityRate: reproducible.length ? reproducible.filter((reward) => reward.reproducible === true).length / reproducible.length : null,
    };
  });
  return { competitionId, cycles: policies.length, operators };
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
    const cost = Math.max(0.1, arm.cost);
    const contextAttempts = Math.max(0, arm.contextAttempts ?? 0);
    const hasContextEvidence = contextAttempts >= 2 && Number.isFinite(arm.contextMeanReward);
    // Contextual evidence is a shrinkage estimate, not a replacement for the
    // global prior. This prevents two lucky runs on one executor/model from
    // dominating a new context while still allowing transfer when it repeats.
    const contextWeight = hasContextEvidence ? contextAttempts / (contextAttempts + 3) : 0;
    const estimatedReward = hasContextEvidence
      ? (arm.contextMeanReward! * contextWeight) + (arm.meanReward * (1 - contextWeight))
      : arm.meanReward;
    const conflictPressure = input.evidenceConflicts > 0 && arm.operator === "audit" ? 0.8 : 0;
    const recoveryPressure = input.recentFailures > 0 && arm.operator === "replication" ? 0.35 : 0;
    const profileBonus = input.profile === "evidence"
      ? arm.operator === "audit" || arm.operator === "replication" ? 0.9 : arm.operator === "mcts" || arm.operator === "evolutionary" ? -0.25 : 0
      : input.profile === "recovery"
        ? arm.operator === "replication" || arm.operator === "audit" ? 0.65 : 0
        : input.profile === "exploration"
          ? arm.novelty * 0.25
          : input.profile === "budget"
            ? -Math.min(1, cost * 0.1)
            : 0;
    const untriedBonus = arm.attempts === 0
      ? arm.operator === "mcts" ? 3.4 : arm.operator === "evolutionary" ? 2.4 : 2
      : 0;
    // Empirical-Bernstein uncertainty uses observed variance when available;
    // this allocates trials to arms that are both promising and informative,
    // instead of treating every noisy arm as equally uncertain.
    const logTerm = Math.log(totalAttempts + 2);
    const variance = Math.max(0, hasContextEvidence ? (arm.contextRewardVariance ?? arm.rewardVariance ?? 0.25) : (arm.rewardVariance ?? 0.25));
    const uncertainty = arm.attempts === 0
      ? 1
      // Rewards are bounded to [-1, 1]; cap the confidence bonus so a tiny
      // sample cannot dominate an explicitly untried search strategy.
      : Math.min(2, exploration * (Math.sqrt((2 * variance * logTerm) / arm.attempts) + (3 * logTerm) / arm.attempts));
    const costPenalty = cost > Math.max(0.1, input.remainingBudgetMinutes) ? 100 : cost * 0.05;
    const successRate = arm.attempts ? arm.successes / arm.attempts : 0;
    const strategyBonus = arm.operator === "greedy"
      ? estimatedReward * 0.5 - uncertainty * 0.5
      : arm.operator === "evolutionary"
        ? arm.novelty * 0.9 + successRate * 0.25
        : arm.operator === "mcts"
          ? uncertainty * 1.25 + arm.novelty * 0.35
          : arm.novelty * 0.5;
    const score = estimatedReward + strategyBonus + uncertainty + untriedBonus + conflictPressure + recoveryPressure + profileBonus - costPenalty;
    const rationale = arm.attempts === 0
      ? `untried ${arm.operator} policy: obtain information before over-exploiting a known direction`
      : `${arm.operator} reward ${estimatedReward.toFixed(3)}${hasContextEvidence ? ` (context-shrunk from ${arm.meanReward.toFixed(3)} using ${contextAttempts} local samples)` : ""} with uncertainty ${uncertainty.toFixed(3)}${profileBonus ? ` and ${input.profile} profile adjustment ${profileBonus.toFixed(3)}` : ""}`;
    return { ...arm, score, rationale };
  }).sort((left, right) => right.score - left.score);
}

/** Convert a measured metric delta into a bounded reward for future routing. */
export function searchReward(delta: number | undefined, valid: boolean, reproducible: boolean): number {
  if (!valid || delta === undefined || !Number.isFinite(delta)) return -1;
  const bounded = Math.max(-1, Math.min(1, delta));
  return bounded * (reproducible ? 1 : 0.7);
}
