import type { HarnessComparison, HarnessScorecard, HarnessTrial } from "./harness-scorecard.js";

export type HarnessInterventionKind = "reliability" | "recovery" | "alignment" | "efficiency" | "search" | "coverage";

export interface HarnessIntervention {
  id: string;
  kind: HarnessInterventionKind;
  priority: "critical" | "high" | "normal";
  target: string;
  observedGap: string;
  prediction: string;
  action: string;
  acceptance: string;
}

export interface HarnessRetestContract {
  preserve: string[];
  requiredTasks: number;
  minimumCoverage: number;
  independentRepetitions: number;
  noMetricOrBudgetChanges: boolean;
}

export interface HarnessAdaptationPlan {
  schemaVersion: 1;
  challenger: string;
  incumbents: string[];
  claimStatus: "win_proven" | "not_proven" | "no_incumbent";
  interventions: HarnessIntervention[];
  retest: HarnessRetestContract;
}

function priority(kind: HarnessInterventionKind): HarnessIntervention["priority"] {
  return kind === "reliability" || kind === "coverage" ? "critical" : kind === "recovery" || kind === "alignment" ? "high" : "normal";
}

/** Convert matched benchmark outcomes into a deterministic, falsifiable retest agenda. */
export function planHarnessAdaptation(
  trials: HarnessTrial[],
  scorecards: HarnessScorecard[],
  comparisons: HarnessComparison[],
  challenger: string,
): HarnessAdaptationPlan {
  const challengerScore = scorecards.find((scorecard) => scorecard.harness === challenger);
  const incumbents = [...new Set(comparisons.map((comparison) => comparison.incumbent))].sort();
  const interventions: HarnessIntervention[] = [];
  const add = (kind: HarnessInterventionKind, target: string, observedGap: string, prediction: string, action: string, acceptance: string): void => {
    const id = `harness:${kind}:${target.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    if (interventions.some((intervention) => intervention.id === id)) return;
    interventions.push({ id, kind, priority: priority(kind), target, observedGap, prediction, action, acceptance });
  };

  if (!comparisons.length) {
    add("coverage", "matched incumbent coverage", "No incumbent comparison is available.", "A matched multi-task protocol will reveal a measurable strength or failure mode.", "Run at least two matched tasks with the same model, seeds, budgets, evaluator, and incumbent arms.", "Every declared harness has valid paired evidence on at least two tasks.");
  }
  for (const comparison of comparisons) {
    if (comparison.challengerWins) continue;
    if (comparison.coverage < 0.8 || comparison.validPairedArms < comparison.comparableArms) {
      add("reliability", `${comparison.incumbent} paired validity`, `${(comparison.coverage * 100).toFixed(0)}% valid paired coverage against ${comparison.incumbent}.`, "Reducing invalid or missing runs will raise the conservative lower bound without changing the task metric.", "Instrument the failing route, classify the terminal failure, and add a bounded alternate route before retesting.", "At least 80% valid paired coverage with no silently dropped arms.");
    }
    const sliceRegressions = comparison.sliceRegressions ?? [];
    const sliceLower95 = comparison.sliceLower95 ?? {};
    if (sliceRegressions.length) {
      for (const slice of sliceRegressions.slice(0, 4)) {
        const lower = sliceLower95[slice];
        add(
          "coverage",
          `${comparison.incumbent} slice ${slice}`,
          `Slice '${slice}' has a paired lower 95% bound of ${lower?.toFixed(6) ?? "unknown"}.`,
          "A slice-targeted route will remove the minority-domain regression without changing the locked metric, budget, or protocol.",
          `Inspect the failing '${slice}' task family, add one bounded route or verifier targeted to that slice, and retest all slices under the same protocol.`,
          `The '${slice}' slice lower 95% bound is non-negative and no previously passing slice regresses.`,
        );
      }
    }
    if (comparison.pairedProcessQualityDelta !== null && comparison.pairedProcessQualityDelta < -0.1) {
      add("alignment", `${comparison.incumbent} execution alignment`, `Process-quality delta ${comparison.pairedProcessQualityDelta.toFixed(3)} is below the non-regression gate.`, "Explicit tool-result closure and evidence checks will reduce process regressions.", "Add an independent critic/verifier gate at the failing boundary and retest the same protocol.", "Paired process-quality delta is at least -0.1.");
    }
    if (comparison.pairedTimeEfficiencyDelta !== null && comparison.pairedTimeEfficiencyDelta < -0.25) {
      add("efficiency", `${comparison.incumbent} time efficiency`, `Time-efficiency delta ${comparison.pairedTimeEfficiencyDelta.toFixed(3)} is below the non-regression gate.`, "Cost-aware scheduling and early stopping will preserve more budget for valid evidence.", "Profile time to first valid evidence, then change only scheduling, screening, or recovery policy—not the benchmark budget.", "Paired time-efficiency delta is at least -0.25.");
    }
    if (comparison.pairedLower95 === null || comparison.pairedLower95 <= 0) {
      add("search", `${comparison.incumbent} task performance`, comparison.pairedLower95 === null ? "No valid paired metric evidence exists." : `Paired lower 95% bound ${comparison.pairedLower95.toFixed(6)} is not positive.`, "A more diverse, evidence-gated search portfolio will improve the task-balanced lower bound.", "Run a new formulation family or ablation selected by information gain; preserve the failed direction as a negative result.", "The same locked protocol produces a positive paired lower 95% bound.");
    }
  }
  if ((challengerScore?.failureProfile && Object.keys(challengerScore.failureProfile).length) || trials.some((trial) => trial.harness === challenger && trial.recovered)) {
    const failures = Object.entries(challengerScore?.failureProfile ?? {}).map(([name, count]) => `${name}=${count}`).join(", ") || "recovered failures observed";
    add("recovery", "failure-aware routing", `Challenger failure/recovery profile: ${failures}.`, "Failure-specific alternate routes will convert more budget into valid reproducible evidence.", "Use the failure class to select a different resource, provider, data, or hypothesis route; never replay an exhausted manifest unchanged.", "The next retest records the route change and improves valid-run or recovery evidence.");
  }
  if (!interventions.length && comparisons.length) {
    add("search", "next frontier", "No failing gate was isolated despite an incomplete competitive claim.", "A controlled formulation change can expose whether the current plateau is search-limited.", "Select the highest-information untried formulation family and run an independent replication.", "A new task-balanced result is recorded without changing the evaluation contract.");
  }
  interventions.sort((left, right) => ({ critical: 0, high: 1, normal: 2 }[left.priority] - { critical: 0, high: 1, normal: 2 }[right.priority] || left.id.localeCompare(right.id)));
  const claimStatus = comparisons.length === 0 ? "no_incumbent" : comparisons.every((comparison) => comparison.challengerWins) ? "win_proven" : "not_proven";
  return {
    schemaVersion: 1,
    challenger,
    incumbents,
    claimStatus,
    interventions,
    retest: {
      preserve: ["task identities", "arm identities", "model", "seeds", "metric direction", "per-arm wall-clock budget", "evaluator and validator"],
      requiredTasks: 2,
      minimumCoverage: 0.8,
      independentRepetitions: 2,
      noMetricOrBudgetChanges: true,
    },
  };
}
