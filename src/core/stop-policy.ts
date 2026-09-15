export interface StopRewardObservation {
  reward: number;
  durationSeconds?: number;
  valid?: boolean;
  reproducible?: boolean;
}

export interface StopPolicyInput {
  stopCondition: string;
  rewards: StopRewardObservation[];
  remainingBudgetMinutes: number;
  leakageUnresolved?: boolean;
  minimumSamples?: number;
  minimumRewardPerMinute?: number;
  failureWindow?: number;
  maximumFailures?: number;
  /** Number of high-priority hypotheses with no terminal falsification test. */
  openFalsifications?: number;
}

export interface StopPolicyResult {
  action: "continue" | "pause" | "stop";
  reason: string;
  samples: number;
  recentFailures: number;
  meanRewardPerMinute: number | null;
  enabledRules: string[];
  openFalsifications: number;
}

/**
 * Decide whether an autonomous campaign has earned a terminal state.
 *
 * This is deliberately an advisory policy unless the campaign's stop
 * condition names the relevant rule. That keeps generic campaigns exploring
 * while making convergence and failure budgets executable and reproducible.
 */
export function assessStopPolicy(input: StopPolicyInput): StopPolicyResult {
  const condition = input.stopCondition.toLowerCase();
  const minimumSamples = Math.max(2, input.minimumSamples ?? 5);
  const minimumRewardPerMinute = input.minimumRewardPerMinute ?? 0.01;
  const failureWindow = Math.max(2, input.failureWindow ?? 5);
  const maximumFailures = Math.max(2, input.maximumFailures ?? 3);
  const enabledRules = [
    /converg|plateau|no useful|expected gain|gain per gpu|sufficient evidence/.test(condition) ? "low-gain convergence" : "",
    /fail|error|blocked|unresolved/.test(condition) ? "repeated-failure pause" : "",
    /leakage|leak/.test(condition) ? "leakage review" : "",
  ].filter(Boolean);
  const recent = input.rewards.slice(-failureWindow);
  const valid = input.rewards.filter((observation) => observation.valid !== false && Number.isFinite(observation.reward));
  const rates = valid
    .map((observation) => {
      const minutes = Math.max(1 / 60, (observation.durationSeconds ?? 60) / 60);
      return observation.reward / minutes;
    })
    .filter(Number.isFinite);
  const meanRewardPerMinute = rates.length ? rates.reduce((sum, value) => sum + value, 0) / rates.length : null;
  const recentFailures = recent.filter((observation) => observation.valid === false || observation.reward < 0).length;
  const openFalsifications = Math.max(0, Math.floor(input.openFalsifications ?? 0));
  const result = (action: StopPolicyResult["action"], reason: string): StopPolicyResult => ({ action, reason, samples: valid.length, recentFailures, meanRewardPerMinute, enabledRules, openFalsifications });

  if (input.leakageUnresolved && enabledRules.includes("leakage review")) {
    return result("pause", "leakage remains unresolved; pause before spending more compute");
  }
  if (enabledRules.includes("repeated-failure pause") && recent.length >= failureWindow && recentFailures >= maximumFailures) {
    return result("pause", `${recentFailures}/${recent.length} recent attempts failed or regressed`);
  }
  if (enabledRules.includes("low-gain convergence") && valid.length >= minimumSamples && meanRewardPerMinute !== null && meanRewardPerMinute < minimumRewardPerMinute && input.remainingBudgetMinutes > 0) {
    if (openFalsifications > 0) return result("continue", `low observed gain, but ${openFalsifications} falsification test(s) remain open`);
    return result("stop", `mean observed gain is ${meanRewardPerMinute.toFixed(4)} per minute, below ${minimumRewardPerMinute.toFixed(4)}`);
  }
  return result("continue", "stop policy has not accumulated sufficient evidence");
}
