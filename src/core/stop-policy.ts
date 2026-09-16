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
  /** Reward at or above this value counts as a meaningful improvement. */
  meaningfulRewardThreshold?: number;
  /** Stop the posterior rule when P(success rate > 0.5) falls below this value. */
  minimumPosteriorProbability?: number;
}

export interface StopPolicyResult {
  action: "continue" | "pause" | "stop";
  reason: string;
  samples: number;
  recentFailures: number;
  meanRewardPerMinute: number | null;
  posteriorMeaningfulProbability: number | null;
  enabledRules: string[];
  openFalsifications: number;
}

/**
 * Exact Beta(1 + successes, 1 + failures) posterior tail for an integer
 * threshold. The binomial identity avoids a numerical-special-function
 * dependency while remaining stable for the bounded campaign sample sizes.
 */
export function betaPosteriorTail(successes: number, failures: number, threshold = 0.5): number {
  if (!Number.isInteger(successes) || successes < 0 || !Number.isInteger(failures) || failures < 0) throw new Error("Beta posterior counts must be non-negative integers");
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("Beta posterior threshold must be between 0 and 1");
  if (threshold <= 0) return 1;
  if (threshold >= 1) return 0;
  const alpha = successes + 1;
  const total = successes + failures + 1;
  let coefficient = 1;
  let tail = 0;
  for (let j = 0; j < alpha; j += 1) {
    tail += coefficient * (threshold ** j) * ((1 - threshold) ** (total - j));
    coefficient *= (total - j) / (j + 1);
  }
  return Math.max(0, Math.min(1, tail));
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
    /posterior|probability of|meaningful improvement/.test(condition) ? "posterior evidence" : "",
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
  const meaningfulRewardThreshold = Number.isFinite(input.meaningfulRewardThreshold) ? input.meaningfulRewardThreshold! : 0;
  const posteriorObservations = input.rewards.filter((observation) => Number.isFinite(observation.reward));
  const meaningfulSuccesses = posteriorObservations.filter((observation) => observation.valid !== false && observation.reward >= meaningfulRewardThreshold).length;
  const posteriorMeaningfulProbability = posteriorObservations.length
    ? betaPosteriorTail(meaningfulSuccesses, posteriorObservations.length - meaningfulSuccesses)
    : null;
  const recentFailures = recent.filter((observation) => observation.valid === false || observation.reward < 0).length;
  const openFalsifications = Math.max(0, Math.floor(input.openFalsifications ?? 0));
  const result = (action: StopPolicyResult["action"], reason: string): StopPolicyResult => ({ action, reason, samples: valid.length, recentFailures, meanRewardPerMinute, posteriorMeaningfulProbability, enabledRules, openFalsifications });

  if (input.leakageUnresolved && enabledRules.includes("leakage review")) {
    return result("pause", "leakage remains unresolved; pause before spending more compute");
  }
  if (enabledRules.includes("repeated-failure pause") && recent.length >= failureWindow && recentFailures >= maximumFailures) {
    return result("pause", `${recentFailures}/${recent.length} recent attempts failed or regressed`);
  }
  const minimumPosteriorProbability = Math.max(0, Math.min(1, input.minimumPosteriorProbability ?? 0.1));
  if (enabledRules.includes("posterior evidence") && posteriorMeaningfulProbability !== null && posteriorObservations.length >= minimumSamples && posteriorMeaningfulProbability < minimumPosteriorProbability) {
    if (openFalsifications > 0) return result("continue", `posterior meaningful-improvement probability ${(posteriorMeaningfulProbability * 100).toFixed(1)}% is low, but ${openFalsifications} falsification test(s) remain open`);
    return result("stop", `posterior meaningful-improvement probability ${(posteriorMeaningfulProbability * 100).toFixed(1)}% is below ${(minimumPosteriorProbability * 100).toFixed(1)}%`);
  }
  if (enabledRules.includes("low-gain convergence") && valid.length >= minimumSamples && meanRewardPerMinute !== null && meanRewardPerMinute < minimumRewardPerMinute && input.remainingBudgetMinutes > 0) {
    if (openFalsifications > 0) return result("continue", `low observed gain, but ${openFalsifications} falsification test(s) remain open`);
    return result("stop", `mean observed gain is ${meanRewardPerMinute.toFixed(4)} per minute, below ${minimumRewardPerMinute.toFixed(4)}`);
  }
  return result("continue", "stop policy has not accumulated sufficient evidence");
}
