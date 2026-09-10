/**
 * Runtime policy derived from observed harness failures.
 *
 * This is intentionally deterministic and model-independent. A model may
 * propose a new research direction, but only measured trajectory evidence can
 * change how much tool budget, verification, and peer review the controller
 * allocates to the next turn.
 */

export interface AdaptiveHarnessInput {
  quality: Array<{ overall?: string; toolUse?: { verdict?: string }; evidenceConsistency?: { verdict?: string }; errorRecovery?: { verdict?: string }; termination?: { verdict?: string } }>;
  failureClasses?: string[];
  evidenceConflicts?: number;
  budgetRemainingMinutes?: number;
  benchmarkInterventions?: Array<{ kind?: string; priority?: string }>;
}

export interface AdaptiveHarnessPolicy {
  schemaVersion: 1;
  maxToolRounds: number;
  maxToolAttempts: number;
  peerReview: boolean;
  independentCritic: boolean;
  requireReplication: boolean;
  preferDiverseSearch: boolean;
  recoveryRoute: "same_manifest" | "alternate_route" | "repair_first";
  reasons: string[];
}

function countVerdict(quality: AdaptiveHarnessInput["quality"], key: "toolUse" | "evidenceConsistency" | "errorRecovery" | "termination", verdicts: string[]): number {
  return quality.filter((item) => verdicts.includes(item[key]?.verdict ?? "")).length;
}

/**
 * Derive the next controller posture from recent outcomes.
 *
 * The policy is bounded: failures can increase verification and recovery
 * effort, but cannot silently grant unlimited model calls or compute.
 */
export function deriveAdaptiveHarnessPolicy(input: AdaptiveHarnessInput): AdaptiveHarnessPolicy {
  const quality = input.quality ?? [];
  const failures = input.failureClasses ?? [];
  const conflictCount = Math.max(0, input.evidenceConflicts ?? 0);
  const reasons: string[] = [];
  const toolGaps = countVerdict(quality, "toolUse", ["FAIL", "WARN"]);
  const evidenceGaps = countVerdict(quality, "evidenceConsistency", ["FAIL", "WARN"]);
  const recoveryGaps = countVerdict(quality, "errorRecovery", ["FAIL", "WARN"]);
  const terminationGaps = countVerdict(quality, "termination", ["FAIL", "WARN"]);
  const hasTransientFailure = failures.some((failure) => ["timeout", "transient_cloud", "rate_limit", "network"].includes(failure));
  const hasContractFailure = failures.some((failure) => ["invalid_metric", "corrupt_artifact", "data_missing", "dependency", "auth"].includes(failure));
  const lowBudget = Number.isFinite(input.budgetRemainingMinutes) && (input.budgetRemainingMinutes ?? Infinity) < 5;
  const benchmarkPriority = input.benchmarkInterventions?.some((item) => item.priority === "critical" || item.priority === "high") ?? false;

  let maxToolRounds = 6;
  let maxToolAttempts = 3;
  let peerReview = false;
  let independentCritic = true;
  let requireReplication = true;
  let preferDiverseSearch = false;
  let recoveryRoute: AdaptiveHarnessPolicy["recoveryRoute"] = "same_manifest";

  if (toolGaps > 0) {
    maxToolRounds = 8;
    reasons.push("tool-use gaps: allow one additional bounded evidence round");
  }
  if (evidenceGaps > 0 || conflictCount > 0 || benchmarkPriority) {
    peerReview = true;
    independentCritic = true;
    reasons.push("evidence pressure: require peer review and independent criticism");
  }
  if (recoveryGaps > 0 || hasTransientFailure) {
    maxToolAttempts = 3;
    recoveryRoute = "alternate_route";
    reasons.push("recovery pressure: change route after a bounded retry");
  }
  if (hasContractFailure) {
    recoveryRoute = "repair_first";
    reasons.push("contract failure: repair the execution/evidence contract before retrying");
  }
  if (terminationGaps > 0) {
    requireReplication = true;
    reasons.push("termination gaps: preserve replication and explicit terminal evidence");
  }
  if (quality.length === 0 || toolGaps === 0 && evidenceGaps === 0 && recoveryGaps === 0) {
    preferDiverseSearch = true;
    reasons.push("no recurring capability failure: explore a diverse search operator");
  }
  if (lowBudget) {
    maxToolRounds = Math.min(maxToolRounds, 4);
    peerReview = conflictCount > 0 || evidenceGaps > 0;
    reasons.push("low remaining budget: cap tool deliberation and preserve evaluator time");
  }

  return {
    schemaVersion: 1,
    maxToolRounds,
    maxToolAttempts,
    peerReview,
    independentCritic,
    requireReplication,
    preferDiverseSearch,
    recoveryRoute,
    reasons,
  };
}
