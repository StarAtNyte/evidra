/**
 * Goal-progress assessment: is the campaign still closing the gap to its
 * objective, or has the current method family plateaued?
 *
 * Decision-level stagnation (stagnation.ts) catches a controller that repeats
 * itself. It cannot catch a controller that keeps producing new, well-reviewed
 * experiments that all land within noise of the incumbent. That loop looks
 * healthy from the inside, so the controller must measure it from outcomes.
 */

export interface ProgressRun {
  createdAt: string;
  metric: number;
}

export interface GoalProgressInput {
  direction: "maximize" | "minimize";
  baseline?: number;
  /** Desired metric value (for a competition, a score that would win or place). */
  target?: number;
  /** Completed runs of this campaign with a finite primary metric, any order. */
  runs: ProgressRun[];
  /** Number of most recent runs that must fail to move the best result. */
  windowRuns?: number;
  /** Minimum improvement of the best result over the window that counts as progress. */
  minGain?: number;
  /** Earlier consecutive cycles that already carried a pivot directive without producing a new run. */
  stalledPivotCycles?: number;
}

export interface GoalProgress {
  schemaVersion: 1;
  runs: number;
  best: number | null;
  baseline: number | null;
  target: number | null;
  /** Fraction of the baseline-to-target distance closed so far (null without a target). */
  closedFraction: number | null;
  /** Improvement of the best result produced by the latest window of runs. */
  windowGain: number | null;
  minGain: number;
  windowRuns: number;
  plateau: boolean;
  /** Plateau while far from the target: the method family itself must change. */
  pivotRequired: boolean;
  /** A pivot directive was already ignored by planning-only cycles: the next decision must run an experiment. */
  mustRun: boolean;
  directive: string | null;
}

export function assessGoalProgress(input: GoalProgressInput): GoalProgress {
  const sign = input.direction === "maximize" ? 1 : -1;
  const runs = input.runs
    .filter((run) => Number.isFinite(run.metric))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const windowRuns = Math.max(3, Math.min(input.windowRuns ?? 8, 50));
  const baseline = input.baseline !== undefined && Number.isFinite(input.baseline) ? input.baseline : null;
  const target = input.target !== undefined && Number.isFinite(input.target) ? input.target : null;
  const span = baseline !== null && target !== null ? sign * (target - baseline) : null;
  // Default progress unit: 5% of the baseline-to-target distance, else 0.5% of the baseline's magnitude.
  const minGain = input.minGain ?? (span !== null && span > 0 ? span * 0.05 : baseline !== null ? Math.max(Math.abs(baseline) * 0.005, 1e-9) : 0);
  const bestOf = (values: number[]): number | null => values.length ? values.reduce((best, value) => sign * value > sign * best ? value : best) : null;
  const metrics = runs.map((run) => run.metric);
  const best = bestOf(baseline !== null ? [baseline, ...metrics] : metrics);
  const before = bestOf(baseline !== null ? [baseline, ...metrics.slice(0, -windowRuns)] : metrics.slice(0, -windowRuns));
  const windowGain = runs.length >= windowRuns && best !== null && before !== null ? sign * (best - before) : null;
  const plateau = windowGain !== null && windowGain < minGain;
  const closedFraction = span !== null && span > 0 && best !== null && baseline !== null ? sign * (best - baseline) / span : null;
  const pivotRequired = plateau && (closedFraction === null || closedFraction < 0.75);
  // Research breadth is the point of a pivot, but a cycle that only inspects cannot move the best
  // result, so the plateau persists and the next cycle pivots again. One planning-only pivot cycle is
  // allowed; after that the controller demands an experiment.
  const mustRun = pivotRequired && (input.stalledPivotCycles ?? 0) >= 1;
  const directive = pivotRequired
    ? [
      `GOAL PROGRESS: the last ${windowRuns} completed runs moved the best result (${best}) by only ${windowGain?.toPrecision(3)}; one progress unit is ${minGain.toPrecision(3)}.`,
      target !== null ? `The target is ${target}; only ${Math.round((closedFraction ?? 0) * 100)}% of the distance from baseline ${baseline} has been closed.` : "",
      "The current method family has plateaued. Further ablations, replications, or parameter tuning of it are low value.",
      "Required this cycle: (1) broaden research: read the scorer source to find what each metric actually rewards, search the literature and the public resources the rules allow (external data, pretrained models, published methods), and work out what stronger entries must be doing differently;",
      "(2) propose and test a structurally different formulation, not a variant of the incumbent;",
      "(3) where the evaluator is noisy, screen bold changes first and spend replication only on candidates that move the metric by several progress units.",
      mustRun ? `This is pivot cycle ${(input.stalledPivotCycles ?? 0) + 1} without a new experiment: inspection-only decisions are not acceptable now. Decide \`run\` this cycle with the strongest structurally different hypothesis, scoped as a cheap exploratory screen; record open concerns as assumptions instead of auditing further.` : "",
    ].filter(Boolean).join(" ")
    : null;
  return { schemaVersion: 1, runs: runs.length, best, baseline, target, closedFraction, windowGain, minGain, windowRuns, plateau, pivotRequired, mustRun, directive };
}

/** Count the most recent consecutive pivot cycles that ended without any new run. Each
 * research.goal_progress event records how many runs the campaign had when it was assessed. */
export function stalledPivotCycles(events: Array<{ createdAt: string; payload: unknown }>, currentRuns: number): number {
  const ordered = [...events].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  let count = 0;
  for (const event of ordered) {
    const progress = (event.payload as { progress?: { pivotRequired?: unknown; runs?: unknown } } | undefined)?.progress;
    if (progress?.pivotRequired !== true || progress.runs !== currentRuns) break;
    count += 1;
  }
  return count;
}
