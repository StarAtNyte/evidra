/**
 * Cross-campaign lessons.
 *
 * A campaign ends with a durable record (runs, hypotheses, goal-progress assessments, failures) that
 * the next campaign on the same problem never sees: it restarts from the operator's brief and pays
 * again to learn which method families plateau, how noisy the evaluator is, and which component
 * each family moved. This module distils that record into a short, evidence-backed lessons file
 * (after the experience library in Harness^2) that project guidance loads on the next campaign. It
 * is deterministic: every statement is computed from recorded outcomes, never generated, so it
 * cannot carry a model's unsupported claims forward.
 */

export interface LessonRun {
  runId?: string;
  experimentId: string;
  status: string;
  createdAt: string;
  metrics: Record<string, number>;
  /** Recorded controller receipt, separate from accepted evaluator metrics. */
  trainingReceipt?: unknown;
}

export interface LessonExperiment {
  id: string;
  hypothesisId?: string;
  sourceReference?: string;
}

export interface LessonHypothesis {
  id: string;
  title?: string;
  formulationFamily?: string;
}

export interface CampaignLessonsInput {
  label: string;
  goal?: string;
  metric: { name: string; direction: "maximize" | "minimize" };
  /** Component metrics a full evaluation reports; runs missing any of them are screens. */
  components?: string[];
  baseline?: number;
  runs: LessonRun[];
  experiments: LessonExperiment[];
  hypotheses: LessonHypothesis[];
  /** research.goal_progress payloads, oldest first. */
  goalProgress?: Array<{ pivotRequired?: boolean; runs?: number }>;
  /** Failure messages of runs and lanes. */
  failures?: string[];
}

const MAX_LINES_PER_SECTION = 8;

/** Preserve explicit receipt facts without inferring efficacy from fit status. */
export function trainingReceiptFacts(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const receipt = value as Record<string, unknown>;
  const facts: string[] = [];
  if (receipt.complete === true || receipt.complete === false) facts.push(`complete=${receipt.complete}`);
  if (receipt.status === "fitted") facts.push("status=fitted");
  for (const key of ["updates", "requested_updates", "gradient_updates", "calibration_updates", "forecast_updates", "selected_forecast_step", "epochs", "joint_epochs"]) {
    const count = receipt[key];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) facts.push(`${key}=${count}`);
  }
  for (const key of ["initial_validation_loss", "selected_validation_loss"]) {
    const measurement = receipt[key];
    if (typeof measurement === "number" && Number.isFinite(measurement)) facts.push(`${key}=${measurement}`);
  }
  for (const key of ["finite_gradients", "gradients_finite", "validation_improved", "conditional_changed", "held_block_optimization", "rk4_complete", "persistent_contract", "inference_ready"]) {
    if (receipt[key] === true || receipt[key] === false) facts.push(`${key}=${receipt[key]}`);
  }
  return facts;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function distilCampaignLessons(input: CampaignLessonsInput): string {
  const sign = input.metric.direction === "maximize" ? 1 : -1;
  const better = (left: number, right: number): boolean => sign * left > sign * right;
  const signed = (value: number): string => `${value >= 0 ? "+" : ""}${fmt(value)}`;
  const hypothesisOf = new Map(input.experiments.map((experiment) => [experiment.id, experiment.hypothesisId]));
  const hypothesis = new Map(input.hypotheses.map((entry) => [entry.id, entry]));
  const describe = (experimentId: string): { key: string; title: string; family: string } => {
    const id = hypothesisOf.get(experimentId);
    const entry = id ? hypothesis.get(id) : undefined;
    return { key: id ?? experimentId, title: entry?.title ?? experimentId, family: entry?.formulationFamily ?? "unlabelled" };
  };
  const completed = input.runs.filter((run) => run.status === "completed" && Number.isFinite(run.metrics[input.metric.name]));
  const components = input.components ?? [];
  const complete = completed.filter((run) => components.every((name) => Number.isFinite(run.metrics[name])));
  const lines: string[] = [`# Lessons from campaign ${input.label}`, ""];
  lines.push("Computed from the campaign's recorded outcomes, not from agent summaries. Use them to choose what to try first; they are evidence about this evaluator, not rules.", "");
  if (input.goal) lines.push(`Goal: ${input.goal.slice(0, 300)}`, "");
  const failedRuns = input.runs.filter((run) => run.status === "failed").length;
  lines.push(`Runs: ${complete.length} full evaluations, ${completed.length - complete.length} partial screens, ${failedRuns} failed.`);
  // Preserve behavioral failures and losing variants, not only the adopted
  // output. Harness2's contrastive experience library motivates this boundary:
  // selection alone cannot identify which edit helped.
  const experiments = new Map(input.experiments.map((entry) => [entry.id, entry]));
  const recent = [...input.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (recent.length) {
    lines.push('', '## Variant evidence (observations, not attribution)',
      'Inspect these exact run/experiment records and their source snapshots before reusing a lesson. Adoption or a higher score alone does not show which edit helped. Multiple changed components without an isolated execution contrast are confounded; a failed run is not a measured scientific loss.');
    for (const run of recent.slice(0, MAX_LINES_PER_SECTION)) {
      const measured = run.status === 'completed' && Number.isFinite(run.metrics[input.metric.name]);
      const value = measured ? `; ${input.metric.name} ${fmt(run.metrics[input.metric.name])}` : '; no accepted measurement';
      const source = experiments.get(run.experimentId)?.sourceReference;
      lines.push(`- ${run.runId ?? run.experimentId}: ${run.status}${value}; experiment ${run.experimentId}; "${describe(run.experimentId).title}"${source ? `; source ${source}` : ''}`);
    }
    lines.push('');
  }
  const receiptRuns = recent.map(run => ({ run, facts: trainingReceiptFacts(run.trainingReceipt) })).filter(entry => entry.facts.length);
  if (receiptRuns.length) {
    lines.push("## Recorded training receipts",
      "These explicit controller fields explain what ran and which checks failed. A generic failed run can contain completed training rejected by validation or numerical checks. Receipt flags are observations, not independent verification, accepted evaluator metrics, or proof of efficacy; inspect the source artifact before deciding to retry.");
    for (const { run, facts } of receiptRuns.slice(0, MAX_LINES_PER_SECTION)) {
      const source = experiments.get(run.experimentId)?.sourceReference;
      lines.push(`- ${run.runId ?? run.experimentId}: ${facts.join("; ")}${source ? `; source ${source}` : ""}`);
    }
    lines.push("");
  }
  // Execution evidence is especially important when every evaluation failed.
  // Emit it before the no-score return so the next campaign can repair the
  // execution path without treating unmeasured methods as scientific losses.
  const failures = [...new Set((input.failures ?? []).map((message) => message.replace(/\s+/g, " ").trim().slice(0, 200)).filter(Boolean))];
  if (failures.length) {
    lines.push("## Recurrent failures",
      "These are execution observations. Inspect the referenced run and repair or validate the failing path before retrying; they do not establish that a scientific method is ineffective.");
    for (const message of failures.slice(0, MAX_LINES_PER_SECTION)) lines.push(`- ${message}`);
    lines.push("");
  }
  if (!complete.length) {
    lines.push("No full evaluation completed; nothing to compare.");
    return lines.join("\n") + "\n";
  }

  const metricOf = (run: LessonRun): number => run.metrics[input.metric.name];
  const best = complete.reduce((left, right) => better(metricOf(right), metricOf(left)) ? right : left);
  const bestInfo = describe(best.experimentId);
  const gain = input.baseline !== undefined ? ` (${signed(sign * (metricOf(best) - input.baseline))} over baseline ${fmt(input.baseline)})` : "";
  lines.push(`Best ${input.metric.name}: ${fmt(metricOf(best))}${gain}, from "${bestInfo.title}" [${bestInfo.family}].`, "");

  // Evaluator noise: the same hypothesis evaluated more than once (replications, seeds).
  const byHypothesis = new Map<string, number[]>();
  for (const run of complete) {
    const key = describe(run.experimentId).key;
    byHypothesis.set(key, [...(byHypothesis.get(key) ?? []), metricOf(run)]);
  }
  const spreads = [...byHypothesis.values()].filter((values) => values.length >= 2).map((values) => Math.max(...values) - Math.min(...values)).sort((a, b) => a - b);
  if (spreads.length) {
    const median = spreads[Math.floor(spreads.length / 2)];
    lines.push("## Evaluator noise", `Repeated evaluations of the same hypothesis (${spreads.length} groups) differed by a median of ${fmt(median)} and at most ${fmt(spreads.at(-1) ?? 0)} ${input.metric.name}. Treat differences below about ${fmt(median)} as noise; replicate before promoting.`, "");
  }

  // Method families: which kinds of change moved the metric.
  const families = new Map<string, { runs: number; best: number; title: string }>();
  for (const run of complete) {
    const info = describe(run.experimentId);
    const entry = families.get(info.family);
    if (!entry) families.set(info.family, { runs: 1, best: metricOf(run), title: info.title });
    else {
      entry.runs += 1;
      if (better(metricOf(run), entry.best)) { entry.best = metricOf(run); entry.title = info.title; }
    }
  }
  const familyRows = [...families.entries()].sort((left, right) => sign * (right[1].best - left[1].best));
  lines.push("## Method families (best full evaluation each)");
  for (const [family, entry] of familyRows.slice(0, MAX_LINES_PER_SECTION)) {
    const delta = input.baseline !== undefined ? `, ${signed(sign * (entry.best - input.baseline))} vs baseline` : "";
    lines.push(`- ${family}: best ${fmt(entry.best)}${delta} over ${entry.runs} run(s); strongest: "${entry.title}"`);
  }
  lines.push("");

  // Component ceilings: the best value each component reached and where, so a later campaign can
  // combine mechanisms that each won a different component.
  if (components.length) {
    lines.push("## Best value per component (combination candidates require a fresh test)");
    const flat: string[] = [];
    for (const name of components) {
      const values = complete.map((run) => run.metrics[name]);
      const range = Math.max(...values) - Math.min(...values);
      if (range < 0.5) flat.push(name);
      const top = complete.reduce((left, right) => better(right.metrics[name], left.metrics[name]) ? right : left);
      lines.push(`- ${name}: best ${fmt(top.metrics[name])} from "${describe(top.experimentId).title}"; best overall run has ${fmt(best.metrics[name])}; range across runs ${fmt(range)}`);
    }
    if (flat.length) lines.push(`No experiment moved these by even 0.5: ${flat.join(", ")}. Either the proxy cannot see changes there or every attempt missed; find out which before spending more on them.`);
    lines.push("");
  }

  const progress = input.goalProgress ?? [];
  if (progress.length) {
    const pivots = progress.filter((entry) => entry.pivotRequired === true).length;
    let idle = 0;
    for (let index = 1; index < progress.length; index += 1) if (progress[index].runs === progress[index - 1].runs) idle += 1;
    const advice = idle > progress.length / 3 ? " Too many cycles only planned: screen a concrete change every cycle." : "";
    lines.push("## Use of cycles", `${progress.length} assessed cycles; ${pivots} flagged a plateau that required a different method family; ${idle} ended without a new run.${advice}`, "");
  }

  return lines.join("\n");
}
