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

function logGamma(value: number): number {
  // Lanczos approximation; only positive integer arguments are used here.
  const coefficients = [0.9999999999998099, 676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  const shifted = value - 1;
  let sum = coefficients[0];
  for (let index = 1; index < coefficients.length; index += 1) sum += coefficients[index] / (shifted + index);
  const t = shifted + coefficients.length - 1.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

function logAdd(left: number, right: number): number {
  if (!Number.isFinite(left)) return right;
  if (!Number.isFinite(right)) return left;
  const larger = Math.max(left, right);
  return larger + Math.log(Math.exp(left - larger) + Math.exp(right - larger));
}

/**
 * Exact Beta(1 + successes, 1 + failures) posterior tail for an integer
 * threshold. The binomial identity is evaluated in log-space so long-lived
 * campaigns cannot overflow on large combinatorial coefficients.
 */
export function betaPosteriorTail(successes: number, failures: number, threshold = 0.5): number {
  if (!Number.isInteger(successes) || successes < 0 || !Number.isInteger(failures) || failures < 0) throw new Error("Beta posterior counts must be non-negative integers");
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("Beta posterior threshold must be between 0 and 1");
  if (threshold <= 0) return 1;
  if (threshold >= 1) return 0;
  const alpha = successes + 1;
  const beta = failures + 1;
  const total = successes + failures + 1;
  let logTail = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < alpha; j += 1) {
    const logTerm = logGamma(total + 1) - logGamma(j + 1) - logGamma(total - j + 1)
      + j * Math.log(threshold) + (total - j) * Math.log(1 - threshold);
    logTail = logAdd(logTail, logTerm);
  }
  return Math.max(0, Math.min(1, Math.exp(logTail)));
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
