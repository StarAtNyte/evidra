/**
 * Runtime policy derived from observed harness failures.
 *
 * This is intentionally deterministic and model-independent. A model may
 * propose a new research direction, but only measured trajectory evidence can
 * change how much tool budget, verification, and peer review the controller
 * allocates to the next turn.
 */

export interface AdaptiveHarnessInput {
  /** Operator-selected autonomy controls the initial deliberation ceiling. */
  autonomy?: "safe" | "fast" | "yolo";
  phase?: string;
  quality: Array<{ overall?: string; toolUse?: { verdict?: string }; evidenceConsistency?: { verdict?: string }; errorRecovery?: { verdict?: string }; termination?: { verdict?: string } }>;
  failureClasses?: string[];
  evidenceConflicts?: number;
  budgetRemainingMinutes?: number;
  benchmarkInterventions?: Array<{ kind?: string; priority?: string }>;
  /** The latest matched harness comparison found Evidra behind an incumbent. */
  benchmarkRegression?: boolean;
  /** Recent route quality fell across adjacent windows and needs re-verification. */
  environmentDrift?: boolean;
  /** The controller repeated the same active decision and must widen search. */
  searchStagnation?: boolean;
}

export type AdaptiveHarnessProfile = "exploration" | "evidence" | "recovery" | "budget";

export interface AdaptiveHarnessPolicy {
  schemaVersion: 1;
  maxToolRounds: number;
  maxToolAttempts: number;
  peerReview: boolean;
  independentCritic: boolean;
  requireReplication: boolean;
  preferDiverseSearch: boolean;
  recoveryRoute: "same_manifest" | "alternate_route" | "repair_first";
  profile: AdaptiveHarnessProfile;
  reasons: string[];
}

export interface CollaborationOutcome {
  useful: boolean;
  criticVerdict?: "proceed" | "revise" | "reject";
  evidenceAnchors?: number;
}

export interface CollaborationUtility {
  samples: number;
  usefulSamples: number;
  usefulRate: number | null;
  recommendTeam: boolean;
  rationale: string;
}

/**
 * Treat peer review as an empirical resource allocation decision. With fewer
 * than three observations we keep the team path available; after that, a
 * repeated sequence of reviews that adds no actionable disagreement should
 * not consume the campaign's model and wall-time budget forever.
 */
export function collaborationUtility(outcomes: CollaborationOutcome[], hardEvidencePressure = false): CollaborationUtility {
  const valid = outcomes.filter((outcome) => typeof outcome.useful === "boolean").slice(-24);
  const usefulSamples = valid.filter((outcome) => outcome.useful).length;
  if (hardEvidencePressure) return {
    samples: valid.length,
    usefulSamples,
    usefulRate: valid.length ? usefulSamples / valid.length : null,
    recommendTeam: true,
    rationale: "hard evidence pressure requires independent review",
  };
  if (valid.length < 3) return {
    samples: valid.length,
    usefulSamples,
    usefulRate: valid.length ? usefulSamples / valid.length : null,
    recommendTeam: true,
    rationale: "insufficient collaboration history; retain the bounded team path",
  };
  const usefulRate = usefulSamples / valid.length;
  const recommendTeam = usefulRate >= 0.34;
  return {
    samples: valid.length,
    usefulSamples,
    usefulRate,
    recommendTeam,
    rationale: recommendTeam ? "peer review produced actionable value in " + usefulSamples + "/" + valid.length + " recent cycle(s)" : "peer review produced no actionable value in " + (valid.length - usefulSamples) + "/" + valid.length + " recent cycle(s); preserve solo reasoning until evidence pressure returns",
  };
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
  const hasVerificationFailure = failures.some((failure) => ["verification", "verifier_failure"].includes(failure));
  const lowBudget = Number.isFinite(input.budgetRemainingMinutes) && (input.budgetRemainingMinutes ?? Infinity) < 5;
  const benchmarkPriority = input.benchmarkInterventions?.some((item) => item.priority === "critical" || item.priority === "high") ?? false;
  const benchmarkRegression = input.benchmarkRegression === true;

  let maxToolRounds = input.autonomy === "yolo" ? 12 : input.autonomy === "fast" ? 9 : 6;
  let maxToolAttempts = 3;
  let peerReview = false;
  let independentCritic = true;
  let requireReplication = true;
  let preferDiverseSearch = false;
  let recoveryRoute: AdaptiveHarnessPolicy["recoveryRoute"] = "same_manifest";
  let profile: AdaptiveHarnessProfile = "exploration";

  if (["data_audit", "validation", "evaluation", "replication", "promotion"].includes(input.phase ?? "")) {
    profile = "evidence";
    peerReview = true;
    requireReplication = true;
    reasons.push(`phase ${input.phase} selects evidence-preserving harness policy`);
  }

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
    profile = "recovery";
    reasons.push("recovery pressure: change route after a bounded retry");
  }
  if (hasContractFailure) {
    recoveryRoute = "repair_first";
    profile = "recovery";
    reasons.push("contract failure: repair the execution/evidence contract before retrying");
  }
  if (hasVerificationFailure) {
    recoveryRoute = "repair_first";
    profile = "evidence";
    peerReview = true;
    independentCritic = true;
    requireReplication = true;
    maxToolRounds = Math.max(maxToolRounds, 8);
    reasons.push("verification failure: repair incomplete or failed verifiers before exploring a new hypothesis");
  }
  if (benchmarkRegression) {
    profile = "evidence";
    peerReview = true;
    independentCritic = true;
    requireReplication = true;
    preferDiverseSearch = false;
    recoveryRoute = recoveryRoute === "repair_first" ? recoveryRoute : "alternate_route";
    maxToolRounds = Math.max(maxToolRounds, 8);
    maxToolAttempts = Math.max(maxToolAttempts, 3);
    reasons.push("benchmark regression: lock targeted repair, alternate-route retest, and replication before exploration");
  }
  if (input.searchStagnation) {
    // A repeated decision is not evidence that the objective is exhausted. It
    // is evidence that the current search topology is not producing a new
    // decision. Give the controller one explicit diversification cycle before
    // allowing the outer stagnation guard to pause the campaign.
    profile = "exploration";
    preferDiverseSearch = true;
    recoveryRoute = "alternate_route";
    maxToolRounds = Math.max(maxToolRounds, 8);
    maxToolAttempts = Math.max(maxToolAttempts, 3);
    reasons.push("search stagnation: widen formulation families and use an alternate route before pausing");
  }
  if (input.environmentDrift) {
    profile = "recovery";
    peerReview = true;
    independentCritic = true;
    requireReplication = true;
    recoveryRoute = "alternate_route";
    maxToolRounds = Math.max(maxToolRounds, 7);
    reasons.push("environment drift: re-verify the route and use an alternate provider/model path before trusting prior results");
  }
  if (terminationGaps > 0) {
    requireReplication = true;
    reasons.push("termination gaps: preserve replication and explicit terminal evidence");
  }
  if (profile !== "evidence" && (quality.length === 0 || toolGaps === 0 && evidenceGaps === 0 && recoveryGaps === 0)) {
    preferDiverseSearch = true;
    reasons.push("no recurring capability failure: explore a diverse search operator");
  }
  if (lowBudget) {
    profile = "budget";
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
    profile,
    reasons,
  };
}
