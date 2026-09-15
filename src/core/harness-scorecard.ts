export type ScoreDirection = "maximize" | "minimize";

export interface HarnessTrial {
  harness: string;
  /** Search-policy provenance; harness remains the comparison identity. */
  policy?: string;
  /** Optional immutable component manifest used for layered harness ablations. */
  componentIds?: string[];
  task: string;
  /** Optional task slice/family used for slice-balanced diagnostics. */
  slice?: string;
  /** Optional protocol identity fields. Older exports remain readable. */
  arm?: string;
  seed?: string | number;
  /** Agent/provider route used by the arm; absent means legacy/default route. */
  provider?: string;
  model?: string;
  /** Optional matched reasoning effort; legacy reports may omit it. */
  reasoningEffort?: string;
  budgetMinutes?: number;
  /** Optional fairness metadata; when supplied it must match across harnesses. */
  dataRevision?: string;
  runtimeFingerprint?: string;
  direction: ScoreDirection;
  baselineMetric: number;
  candidateMetric?: number;
  /** Complete evaluator-backed metric suite when the benchmark declares one. */
  candidateMetrics?: Record<string, number>;
  /** Optional task-level bounds for cross-task metric normalization. */
  taskWorstMetric?: number;
  taskBestMetric?: number;
  validRun: boolean;
  durationSeconds: number;
  /** Seconds from arm start until the first finite declared metric was observed. */
  timeToEvidenceSeconds?: number;
  recovered: boolean;
  reproducible: boolean;
  /** Whether an independent reproducibility command was actually requested. */
  reproducibilityChecked?: boolean;
  /** Optional trajectory-derived process quality in [0, 1]. */
  processQuality?: number;
  /** Whether tool feedback and the next action were aligned. */
  executionAlignment?: boolean;
  /** Structured failure emitted by the benchmark runner, when the arm failed. */
  failureClass?: string;
}

export interface BenchmarkProtocolIssue {
  key: string;
  field: "task" | "slice" | "arm" | "seed" | "provider" | "model" | "reasoningEffort" | "budgetMinutes" | "dataRevision" | "runtimeFingerprint" | "direction" | "baselineMetric" | "taskWorstMetric" | "taskBestMetric";
  values: string[];
  message: string;
}

export interface BenchmarkProtocolReport {
  valid: boolean;
  complete: boolean;
  arms: number;
  harnesses: string[];
  issues: BenchmarkProtocolIssue[];
}

/**
 * Check whether a trial file can support a fair head-to-head comparison.
 * Missing metadata is reported as incomplete rather than silently inferred;
 * scoreHarnessTrials remains backwards-compatible for historical exports.
 */
export function validateBenchmarkProtocol(trials: HarnessTrial[]): BenchmarkProtocolReport {
  const issues: BenchmarkProtocolIssue[] = [];
  const harnesses = [...new Set(trials.map((trial) => trial.harness))].sort();
  const groups = new Map<string, HarnessTrial[]>();
  for (const trial of trials) {
    if (trial.taskWorstMetric !== undefined && (!Number.isFinite(trial.taskWorstMetric) || (trial.taskBestMetric !== undefined && trial.taskWorstMetric === trial.taskBestMetric))) {
      issues.push({ key: `${trial.task}:${trial.arm ?? ""}`, field: "taskWorstMetric", values: [String(trial.taskWorstMetric)], message: "Task normalization bounds must be finite and differ." });
    }
    if (trial.taskBestMetric !== undefined && !Number.isFinite(trial.taskBestMetric)) {
      issues.push({ key: `${trial.task}:${trial.arm ?? ""}`, field: "taskBestMetric", values: [String(trial.taskBestMetric)], message: "Task normalization bounds must be finite numbers." });
    }
    const key = [trial.task, trial.arm ?? "", trial.seed ?? "", trial.provider ?? "", trial.model ?? "", trial.budgetMinutes ?? ""].join("\u001f");
    groups.set(key, [...(groups.get(key) ?? []), trial]);
  }

  const required: Array<BenchmarkProtocolIssue["field"]> = ["arm", "seed", "model", "budgetMinutes"];
  const complete = trials.length > 0 && trials.every((trial) =>
    typeof trial.harness === "string" && trial.harness.trim().length > 0 &&
    trial.arm !== undefined && trial.arm.length > 0 && !trial.arm.includes("unknown") &&
    trial.seed !== undefined && String(trial.seed).length > 0 && !String(trial.seed).includes("unknown") &&
    typeof trial.model === "string" && trial.model.length > 0 && trial.model !== "unknown-model" &&
    typeof trial.budgetMinutes === "number" && Number.isFinite(trial.budgetMinutes) && trial.budgetMinutes > 0);
  if (!complete) {
    issues.push({
      key: "metadata",
      field: "arm",
      values: [],
      message: `Every trial must declare ${required.join(", ")} before claiming a matched comparison.`,
    });
  }

  const byArm = new Map<string, HarnessTrial[]>();
  for (const trial of trials) {
    const key = [trial.task, trial.arm ?? "", trial.seed ?? ""].join("\u001f");
    byArm.set(key, [...(byArm.get(key) ?? []), trial]);
  }
  for (const [key, entries] of byArm) {
    const fields: Array<[BenchmarkProtocolIssue["field"], (trial: HarnessTrial) => string]> = [
      ["task", (trial) => trial.task],
      ["slice", (trial) => trial.slice ?? "<unscoped>"],
      ["arm", (trial) => trial.arm === undefined ? "<missing>" : String(trial.arm)],
      ["seed", (trial) => trial.seed === undefined ? "<missing>" : String(trial.seed)],
      ["provider", (trial) => trial.provider ?? "<default-provider>"],
      ["model", (trial) => trial.model ?? "<missing>"],
      ["reasoningEffort", (trial) => trial.reasoningEffort ?? "<default-medium>"],
      ["budgetMinutes", (trial) => trial.budgetMinutes === undefined ? "<missing>" : String(trial.budgetMinutes)],
      ["dataRevision", (trial) => trial.dataRevision ?? "<missing>"],
      ["runtimeFingerprint", (trial) => trial.runtimeFingerprint ?? "<missing>"],
      ["direction", (trial) => trial.direction],
      ["baselineMetric", (trial) => Number.isFinite(trial.baselineMetric) ? String(trial.baselineMetric) : "<invalid>"],
      ["taskWorstMetric", (trial) => trial.taskWorstMetric === undefined ? "<missing>" : String(trial.taskWorstMetric)],
      ["taskBestMetric", (trial) => trial.taskBestMetric === undefined ? "<missing>" : String(trial.taskBestMetric)],
    ];
    for (const [field, read] of fields) {
      const values = [...new Set(entries.map(read))];
      if (values.length > 1) issues.push({ key, field, values, message: `${field} differs within a matched task arm.` });
    }
    const observedHarnesses = new Set(entries.map((entry) => entry.harness));
    for (const harness of observedHarnesses) {
      const count = entries.filter((entry) => entry.harness === harness).length;
      if (count > 1) issues.push({ key, field: "arm", values: [harness], message: `Harness '${harness}' has duplicate trials for the same task, arm, seed, provider, model, and budget.` });
    }
    if (observedHarnesses.size !== harnesses.length) {
      issues.push({ key, field: "arm", values: [...observedHarnesses].sort(), message: "Not every harness was run on this task arm." });
    }
  }
  return { valid: complete && issues.length === 0, complete, arms: groups.size, harnesses, issues };
}

export interface HarnessScorecard {
  harness: string;
  trials: number;
  tasks: number;
  validRunRate: number;
  improvementRate: number;
  meanDelta: number | null;
  medianTimeToEvidenceSeconds: number | null;
  recoveryRate: number;
  reproducibilityRate: number;
  competitiveScore: number;
  taskBalancedScore: number;
  sliceBalancedScore: number;
  sliceScores: Record<string, number>;
  competitiveScoreLower95: number;
  meanProcessQuality: number | null;
  executionAlignmentRate: number | null;
  meanTimeEfficiency: number | null;
  failureProfile: Record<string, number>;
}

export interface HarnessComparison {
  challenger: string;
  incumbent: string;
  comparableArms: number;
  validPairedArms: number;
  tasks: number;
  coverage: number;
  pairedMeanDelta: number | null;
  pairedLower95: number | null;
  processComparableArms: number;
  pairedProcessQualityDelta: number | null;
  timeComparableArms: number;
  pairedTimeEfficiencyDelta: number | null;
  sliceMeanDeltas: Record<string, number>;
  sliceLower95: Record<string, number>;
  sliceRegressions: string[];
  challengerWins: boolean;
  reason: string;
}

export interface HarnessRetentionReport {
  harness: string;
  comparableArms: number;
  validPairedArms: number;
  tasks: number;
  coverage: number;
  pairedMeanDelta: number | null;
  pairedLower95: number | null;
  regressedTasks: string[];
  retained: boolean;
  reason: string;
}

export interface HarnessGeneralizationReport {
  challenger: string;
  incumbent: string;
  training: HarnessComparison;
  heldOut: HarnessComparison;
  overlappingTasks: string[];
  protocolParity: boolean;
  protocolDifferences: string[];
  generalizes: boolean;
  reason: string;
}

export interface HarnessParetoPoint {
  harness: string;
  competitiveScore: number;
  competitiveScoreLower95: number;
  medianTimeToEvidenceSeconds: number | null;
  onFrontier: boolean;
  dominatedBy: string[];
}

export interface HarnessComponentAblationReport {
  fullHarness: string;
  variant: string;
  removedComponents: string[];
  addedComponents: string[];
  comparison: HarnessComparison;
  valid: boolean;
  reason: string;
}

function policyTrials(trials: HarnessTrial[]): HarnessTrial[] {
  return trials
    .filter((trial) => typeof trial.policy === "string" && trial.policy.trim().length > 0)
    .map((trial) => ({ ...trial, harness: `policy:${trial.policy}` }));
}

/** Score explicitly labelled search policies without conflating them with harness identity. */
export function scoreSearchPolicies(trials: HarnessTrial[]): HarnessScorecard[] {
  return scoreHarnessTrials(policyTrials(trials)).map((scorecard) => ({ ...scorecard, harness: scorecard.harness.replace(/^policy:/, "") }));
}

/** Compare two labelled search policies with the normal paired task-balanced gates. */
export function compareSearchPolicies(trials: HarnessTrial[], challenger: string, incumbent: string): HarnessComparison {
  const comparison = compareHarnesses(policyTrials(trials), `policy:${challenger}`, `policy:${incumbent}`);
  return { ...comparison, challenger, incumbent };
}

function delta(trial: HarnessTrial): number | undefined {
  if (!trial.validRun || trial.candidateMetric === undefined || !Number.isFinite(trial.candidateMetric) || !Number.isFinite(trial.baselineMetric)) return undefined;
  return trial.direction === "maximize" ? trial.candidateMetric - trial.baselineMetric : trial.baselineMetric - trial.candidateMetric;
}

function normalizedOutcome(trial: HarnessTrial): number {
  if (!trial.validRun || trial.candidateMetric === undefined || !Number.isFinite(trial.candidateMetric)) return 0;
  const best = trial.taskBestMetric;
  const worst = trial.taskWorstMetric;
  if (typeof best === "number" && Number.isFinite(best) && typeof worst === "number" && Number.isFinite(worst) && best !== worst) {
    const value = trial.direction === "maximize"
      ? (trial.candidateMetric - worst) / (best - worst)
      : (worst - trial.candidateMetric) / (worst - best);
    return Math.max(0, Math.min(1, value));
  }
  return delta(trial) !== undefined && (delta(trial) ?? 0) > 0 ? 1 : 0;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function trialQuality(trial: HarnessTrial): number {
  const improvement = normalizedOutcome(trial);
  const process = typeof trial.processQuality === "number" && Number.isFinite(trial.processQuality)
    ? Math.max(0, Math.min(1, trial.processQuality))
    : trial.validRun ? 1 : 0;
  const alignment = trial.executionAlignment === undefined ? (trial.validRun ? 1 : 0) : trial.executionAlignment ? 1 : 0;
  const efficiency = timeEfficiency(trial) ?? (trial.validRun ? 0.5 : 0);
  return 100 * (0.30 * improvement + 0.18 * (trial.validRun ? 1 : 0) + 0.14 * (trial.validRun && trial.reproducible ? 1 : 0) + 0.1 * (trial.recovered ? 1 : 0) + 0.1 * process + 0.1 * alignment + 0.08 * efficiency);
}

function processReliability(trial: HarnessTrial): number | undefined {
  const values: number[] = [];
  if (typeof trial.processQuality === "number" && Number.isFinite(trial.processQuality)) values.push(Math.max(0, Math.min(1, trial.processQuality)));
  if (trial.executionAlignment !== undefined) values.push(trial.executionAlignment ? 1 : 0);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

/** Fraction of the declared wall-clock budget left after valid evidence. */
function timeEfficiency(trial: HarnessTrial): number | undefined {
  if (!trial.validRun || !Number.isFinite(trial.durationSeconds) || trial.durationSeconds < 0 || !Number.isFinite(trial.budgetMinutes) || (trial.budgetMinutes ?? 0) <= 0) return undefined;
  return Math.max(0, Math.min(1, 1 - trial.durationSeconds / ((trial.budgetMinutes ?? 0) * 60)));
}

function taskMeans(entries: HarnessTrial[]): number[] {
  const byTask = new Map<string, HarnessTrial[]>();
  for (const entry of entries) byTask.set(entry.task, [...(byTask.get(entry.task) ?? []), entry]);
  return [...byTask.values()].map((taskEntries) => taskEntries.reduce((sum, entry) => sum + trialQuality(entry), 0) / taskEntries.length);
}

function sliceMeans(entries: HarnessTrial[]): Record<string, number> {
  const bySlice = new Map<string, Map<string, number[]>>();
  for (const entry of entries) {
    const slice = entry.slice?.trim() || "unscoped";
    const tasks = bySlice.get(slice) ?? new Map<string, number[]>();
    tasks.set(entry.task, [...(tasks.get(entry.task) ?? []), trialQuality(entry)]);
    bySlice.set(slice, tasks);
  }
  return Object.fromEntries([...bySlice.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([slice, tasks]) => {
    const taskValues = [...tasks.values()].map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
    return [slice, taskValues.reduce((sum, value) => sum + value, 0) / taskValues.length];
  }));
}

/** Deterministic bootstrap lower bound over task means, avoiding a lucky task. */
function bootstrapLower95(values: number[], seedText: string): number {
  if (!values.length) return 0;
  if (values.length === 1) return values[0];
  let seed = [...seedText].reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) >>> 0, 2166136261);
  const samples: number[] = [];
  for (let sample = 0; sample < 1000; sample += 1) {
    let sum = 0;
    for (let draw = 0; draw < values.length; draw += 1) {
      seed = (1664525 * seed + 1013904223) >>> 0;
      sum += values[seed % values.length];
    }
    samples.push(sum / values.length);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length * 0.025)] ?? 0;
}

/** Average paired diagnostics by task before averaging tasks. */
function taskBalancedMean(entries: Array<{ task: string; value: number }>): number | null {
  const byTask = new Map<string, number[]>();
  for (const entry of entries) byTask.set(entry.task, [...(byTask.get(entry.task) ?? []), entry.value]);
  const means = [...byTask.values()].map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
  return means.length ? means.reduce((sum, value) => sum + value, 0) / means.length : null;
}

function protocolKey(trial: HarnessTrial): string {
  return [trial.task, trial.arm ?? "", trial.seed ?? "", trial.provider ?? "", trial.model ?? "", trial.budgetMinutes ?? ""].join("\u001f");
}

function fairPair(left: HarnessTrial, right: HarnessTrial): boolean {
  return left.direction === right.direction &&
    left.provider === right.provider &&
    left.slice === right.slice &&
    left.baselineMetric === right.baselineMetric &&
    left.dataRevision === right.dataRevision &&
    left.runtimeFingerprint === right.runtimeFingerprint &&
    left.taskWorstMetric === right.taskWorstMetric &&
    left.taskBestMetric === right.taskBestMetric &&
    left.reproducibilityChecked === right.reproducibilityChecked;
}

function protocolValues(trials: HarnessTrial[], read: (trial: HarnessTrial) => string): string[] {
  return [...new Set(trials.map(read))].sort();
}

function compareProtocolParity(training: HarnessTrial[], heldOut: HarnessTrial[]): string[] {
  const fields: Array<[string, (trial: HarnessTrial) => string]> = [
    ["provider", (trial) => trial.provider ?? "<default-provider>"],
    ["model", (trial) => trial.model ?? "<missing>"],
    ["budgetMinutes", (trial) => String(trial.budgetMinutes ?? "<missing>")],
    ["direction", (trial) => trial.direction],
    ["dataRevision", (trial) => trial.dataRevision ?? "<missing>"],
    ["runtimeFingerprint", (trial) => trial.runtimeFingerprint ?? "<missing>"],
  ];
  return fields.flatMap(([name, read]) => {
    const left = protocolValues(training, read);
    const right = protocolValues(heldOut, read);
    return JSON.stringify(left) === JSON.stringify(right) ? [] : [`${name} differs between training (${left.join(", ")}) and held-out (${right.join(", ")})`];
  });
}

/**
 * Make a conservative head-to-head claim from the same task arms. The unit of
 * resampling is the task, not the trial, so repeated seeds on one easy task
 * cannot manufacture confidence. Missing or invalid paired runs reduce
 * coverage and prevent a win claim.
 */
export function compareHarnesses(trials: HarnessTrial[], challenger: string, incumbent: string): HarnessComparison {
  if (challenger === incumbent) throw new Error("Challenger and incumbent must be different harnesses.");
  const identities = new Set<string>();
  for (const trial of trials) {
    const identity = `${trial.harness}\u001f${protocolKey(trial)}`;
    if (identities.has(identity)) throw new Error(`Duplicate benchmark trial identity for harness '${trial.harness}' and arm '${protocolKey(trial)}'.`);
    identities.add(identity);
  }
  const challengerArms = new Map(trials.filter((trial) => trial.harness === challenger).map((trial) => [protocolKey(trial), trial]));
  const incumbentArms = new Map(trials.filter((trial) => trial.harness === incumbent).map((trial) => [protocolKey(trial), trial]));
  const allKeys = [...new Set([...challengerArms.keys(), ...incumbentArms.keys()])];
  const keys = [...challengerArms.keys()].filter((key) => incumbentArms.has(key));
  const paired = keys.flatMap((key) => {
    const left = challengerArms.get(key)!;
    const right = incumbentArms.get(key)!;
    if (!left.validRun || !right.validRun || !Number.isFinite(left.candidateMetric) || !Number.isFinite(right.candidateMetric)) return [];
    if (!fairPair(left, right)) return [];
    if ((left.reproducibilityChecked === true && !left.reproducible) || (right.reproducibilityChecked === true && !right.reproducible)) return [];
    const direction = left.direction;
    const delta = direction === "maximize" ? left.candidateMetric! - right.candidateMetric! : right.candidateMetric! - left.candidateMetric!;
    const leftProcess = processReliability(left);
    const rightProcess = processReliability(right);
    const leftTime = timeEfficiency(left);
    const rightTime = timeEfficiency(right);
    return [{ task: left.task, slice: left.slice, delta, processDelta: leftProcess !== undefined && rightProcess !== undefined ? leftProcess - rightProcess : undefined, timeDelta: leftTime !== undefined && rightTime !== undefined ? leftTime - rightTime : undefined }];
  });
  const byTask = new Map<string, number[]>();
  for (const entry of paired) byTask.set(entry.task, [...(byTask.get(entry.task) ?? []), entry.delta]);
  const taskDeltas = [...byTask.values()].map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
  const pairedMeanDelta = taskDeltas.length ? taskDeltas.reduce((sum, value) => sum + value, 0) / taskDeltas.length : null;
  const pairedLower95 = taskDeltas.length ? bootstrapLower95(taskDeltas, `${challenger}::${incumbent}`) : null;
  const processDeltas = paired.flatMap((entry) => entry.processDelta === undefined ? [] : [{ task: entry.task, value: entry.processDelta }]);
  const pairedProcessQualityDelta = taskBalancedMean(processDeltas);
  const processComparableArms = processDeltas.length;
  const timeDeltas = paired.flatMap((entry) => entry.timeDelta === undefined ? [] : [{ task: entry.task, value: entry.timeDelta }]);
  const pairedTimeEfficiencyDelta = taskBalancedMean(timeDeltas);
  const timeComparableArms = timeDeltas.length;
  const bySliceTask = new Map<string, Map<string, number[]>>();
  for (const entry of paired) {
    const slice = entry.slice ?? "unscoped";
    const tasks = bySliceTask.get(slice) ?? new Map<string, number[]>();
    tasks.set(entry.task, [...(tasks.get(entry.task) ?? []), entry.delta]);
    bySliceTask.set(slice, tasks);
  }
  const sliceMeanDeltas: Record<string, number> = {};
  const sliceLower95: Record<string, number> = {};
  for (const [slice, tasks] of [...bySliceTask.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const taskValues = [...tasks.values()].map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
    sliceMeanDeltas[slice] = taskValues.reduce((sum, value) => sum + value, 0) / taskValues.length;
    sliceLower95[slice] = bootstrapLower95(taskValues, `${challenger}::${incumbent}::slice::${slice}`);
  }
  const sliceRegressions = Object.entries(sliceLower95).filter(([, lower]) => lower < 0).map(([slice]) => slice);
  // Include unmatched declared arms in the denominator. Otherwise a harness
  // could appear fully paired by comparing only the intersection and hiding
  // missing task/seed/model/budget arms.
  const coverage = allKeys.length ? paired.length / allKeys.length : 0;
  const minimumTasks = 2;
  const processGate = pairedProcessQualityDelta === null || pairedProcessQualityDelta >= -0.1;
  // Allow a meaningful metric improvement to cost some time, but reject a
  // purported win that consumes substantially more of the same declared
  // budget on average. Missing budgets remain explicitly incomparable.
  const timeGate = pairedTimeEfficiencyDelta === null || pairedTimeEfficiencyDelta >= -0.25;
  const sliceGate = sliceRegressions.length === 0;
  const challengerWins = pairedLower95 !== null && pairedLower95 > 0 && coverage >= 0.8 && taskDeltas.length >= minimumTasks && processGate && timeGate && sliceGate;
  const reason = challengerWins
    ? `paired lower 95% bound ${pairedLower95.toFixed(6)} is positive across ${taskDeltas.length} tasks with ${(coverage * 100).toFixed(0)}% valid paired coverage`
    : !processGate
      ? `paired process-quality delta ${pairedProcessQualityDelta?.toFixed(3)} is below the -0.1 non-regression threshold`
      : !timeGate
        ? `paired time-efficiency delta ${pairedTimeEfficiencyDelta?.toFixed(3)} is below the -0.25 non-regression threshold`
        : !sliceGate
          ? `slice regressions block the claim: ${sliceRegressions.join(", ")}`
      : pairedLower95 === null
      ? "no valid paired evaluator outcomes are available"
      : taskDeltas.length < minimumTasks
        ? `need at least ${minimumTasks} tasks for a task-balanced win claim`
        : coverage < 0.8
          ? `valid paired coverage ${(coverage * 100).toFixed(0)}% is below the 80% claim threshold`
          : `paired lower 95% bound ${pairedLower95.toFixed(6)} is not positive`;
  return {
    challenger,
    incumbent,
    comparableArms: allKeys.length,
    validPairedArms: paired.length,
    tasks: taskDeltas.length,
    coverage,
    pairedMeanDelta,
    pairedLower95,
    processComparableArms,
    pairedProcessQualityDelta,
    timeComparableArms,
    pairedTimeEfficiencyDelta,
    sliceMeanDeltas,
    sliceLower95,
    sliceRegressions,
    challengerWins,
    reason,
  };
}

/**
 * Compare provider routes intentionally, rather than treating provider as an
 * invisible harness configuration. The normal protocol validator rejects
 * mixed providers on one matched arm; this explicit diagnostic removes that
 * route label only after the caller has named both providers.
 */
export function compareProviderRoutes(trials: HarnessTrial[], challengerProvider: string, incumbentProvider: string): HarnessComparison {
  if (!challengerProvider.trim() || !incumbentProvider.trim()) throw new Error("Provider route names must be non-empty.");
  if (challengerProvider === incumbentProvider) throw new Error("Challenger and incumbent providers must be different.");
  const routed = trials
    .filter((trial) => trial.provider === challengerProvider || trial.provider === incumbentProvider)
    .map((trial) => ({ ...trial, harness: trial.provider!, provider: undefined }));
  return compareHarnesses(routed, challengerProvider, incumbentProvider);
}

export interface ProviderGeneralizationReport {
  challengerProvider: string;
  incumbentProvider: string;
  training: HarnessComparison;
  heldOut: HarnessComparison;
  overlappingTasks: string[];
  protocolParity: boolean;
  protocolDifferences: string[];
  generalizes: boolean;
  reason: string;
}

/** Require an intentional provider-route advantage to transfer to unseen tasks. */
export function evaluateProviderGeneralization(
  training: HarnessTrial[],
  heldOut: HarnessTrial[],
  challengerProvider: string,
  incumbentProvider: string,
): ProviderGeneralizationReport {
  const normalize = (trials: HarnessTrial[]): HarnessTrial[] => trials
    .filter((trial) => trial.provider === challengerProvider || trial.provider === incumbentProvider)
    .map((trial) => ({ ...trial, harness: trial.provider!, provider: undefined }));
  const trainingNormalized = normalize(training);
  const heldOutNormalized = normalize(heldOut);
  const trainingProtocol = validateBenchmarkProtocol(trainingNormalized);
  const heldOutProtocol = validateBenchmarkProtocol(heldOutNormalized);
  if (!trainingProtocol.valid) throw new Error(`Training provider protocol is invalid: ${trainingProtocol.issues.map((issue) => issue.message).join("; ")}`);
  if (!heldOutProtocol.valid) throw new Error(`Held-out provider protocol is invalid: ${heldOutProtocol.issues.map((issue) => issue.message).join("; ")}`);
  const trainingTasks = new Set(trainingNormalized.map((trial) => trial.task));
  const heldOutTasks = new Set(heldOutNormalized.map((trial) => trial.task));
  const overlappingTasks = [...trainingTasks].filter((task) => heldOutTasks.has(task)).sort();
  const protocolDifferences = compareProtocolParity(trainingNormalized, heldOutNormalized);
  const protocolParity = protocolDifferences.length === 0;
  const trainingComparison = compareProviderRoutes(training, challengerProvider, incumbentProvider);
  const heldOutComparison = compareProviderRoutes(heldOut, challengerProvider, incumbentProvider);
  const generalizes = overlappingTasks.length === 0 && protocolParity && trainingComparison.challengerWins && heldOutComparison.challengerWins;
  const reason = overlappingTasks.length
    ? `train and held-out task sets overlap: ${overlappingTasks.join(", ")}`
    : !protocolParity
      ? `train and held-out protocols differ: ${protocolDifferences.join("; ")}`
      : !trainingComparison.challengerWins
        ? `challenger provider has no proven training win: ${trainingComparison.reason}`
        : !heldOutComparison.challengerWins
          ? `training provider win does not transfer to held-out tasks: ${heldOutComparison.reason}`
          : `challenger provider wins both task-disjoint training and held-out comparisons`;
  return { challengerProvider, incumbentProvider, training: trainingComparison, heldOut: heldOutComparison, overlappingTasks, protocolParity, protocolDifferences, generalizes, reason };
}

/**
 * Attribute a harness change to one removed component at a time. This is a
 * diagnostic, not a loophole around the normal paired comparison: every
 * variant still needs the same task/seed/model/budget protocol and its own
 * conservative win gate.
 */
export function evaluateHarnessComponentAblations(trials: HarnessTrial[], fullHarness: string): HarnessComponentAblationReport[] {
  const fullTrials = trials.filter((trial) => trial.harness === fullHarness);
  const fullSets = [...new Set(fullTrials.map((trial) => JSON.stringify([...(trial.componentIds ?? [])].sort())))];
  if (fullSets.length !== 1 || !fullSets[0]) throw new Error(`Full harness '${fullHarness}' must declare one consistent component manifest.`);
  const fullComponents = JSON.parse(fullSets[0]) as string[];
  const variants = [...new Set(trials.map((trial) => trial.harness).filter((harness) => harness !== fullHarness))].sort();
  return variants.map((variant) => {
    const variantTrials = trials.filter((trial) => trial.harness === variant);
    const sets = [...new Set(variantTrials.map((trial) => JSON.stringify([...(trial.componentIds ?? [])].sort())))];
    const variantComponents = sets.length === 1 && sets[0] ? JSON.parse(sets[0]) as string[] : [];
    const removedComponents = fullComponents.filter((component) => !variantComponents.includes(component));
    const addedComponents = variantComponents.filter((component) => !fullComponents.includes(component));
    const valid = sets.length === 1 && removedComponents.length === 1 && addedComponents.length === 0;
    const comparison = compareHarnesses(trials, fullHarness, variant);
    return {
      fullHarness,
      variant,
      removedComponents,
      addedComponents,
      comparison,
      valid,
      reason: !valid
        ? "variant must declare exactly the full harness component set minus one component"
        : comparison.challengerWins
          ? `full harness retains a proven win after removing '${removedComponents[0]}'`
          : `removing '${removedComponents[0]}' is not proven harmless: ${comparison.reason}`,
    };
  });
}

/** Detect harness-induced forgetting against a previous matched benchmark. */
export function evaluateHarnessRetention(before: HarnessTrial[], after: HarnessTrial[], harness: string, maximumRegression = 0): HarnessRetentionReport {
  if (!Number.isFinite(maximumRegression) || maximumRegression < 0) throw new Error("Maximum harness regression must be finite and non-negative.");
  const beforeArms = new Map(before.filter((trial) => trial.harness === harness).map((trial) => [protocolKey(trial), trial]));
  const afterArms = new Map(after.filter((trial) => trial.harness === harness).map((trial) => [protocolKey(trial), trial]));
  const allKeys = [...new Set([...beforeArms.keys(), ...afterArms.keys()])];
  const paired = allKeys.flatMap((key) => {
    const left = beforeArms.get(key);
    const right = afterArms.get(key);
    if (!left || !right || !left.validRun || !right.validRun || !Number.isFinite(left.candidateMetric) || !Number.isFinite(right.candidateMetric) || !fairPair(left, right)) return [];
    if ((left.reproducibilityChecked === true && !left.reproducible) || (right.reproducibilityChecked === true && !right.reproducible)) return [];
    const delta = left.direction === "maximize" ? right.candidateMetric! - left.candidateMetric! : left.candidateMetric! - right.candidateMetric!;
    return [{ task: left.task, delta }];
  });
  const byTask = new Map<string, number[]>();
  for (const entry of paired) byTask.set(entry.task, [...(byTask.get(entry.task) ?? []), entry.delta]);
  const taskMeansByName = [...byTask.entries()].map(([task, values]) => ({ task, delta: values.reduce((sum, value) => sum + value, 0) / values.length }));
  const taskDeltas = taskMeansByName.map((entry) => entry.delta);
  const pairedMeanDelta = taskDeltas.length ? taskDeltas.reduce((sum, value) => sum + value, 0) / taskDeltas.length : null;
  const pairedLower95 = taskDeltas.length ? bootstrapLower95(taskDeltas, `${harness}:retention`) : null;
  const regressedTasks = taskMeansByName.filter((entry) => entry.delta < -maximumRegression).map((entry) => entry.task).sort();
  const coverage = allKeys.length ? paired.length / allKeys.length : 0;
  // Retention is stricter than a competitive comparison: every previously
  // evaluated arm must remain measurable after a harness change.
  const retained = pairedLower95 !== null && pairedLower95 >= -maximumRegression && coverage === 1 && taskDeltas.length >= 2;
  const reason = retained
    ? `retained prior performance across ${taskDeltas.length} tasks with ${(coverage * 100).toFixed(0)}% valid paired coverage`
    : pairedLower95 === null
      ? "no valid paired retention evidence is available"
      : taskDeltas.length < 2
        ? "need at least 2 tasks for a retention claim"
        : coverage < 1
          ? `retention coverage ${(coverage * 100).toFixed(0)}% is below the required 100% prior-arm coverage`
          : `lower 95% retention bound ${pairedLower95.toFixed(6)} is below the allowed regression`;
  return { harness, comparableArms: allKeys.length, validPairedArms: paired.length, tasks: taskDeltas.length, coverage, pairedMeanDelta, pairedLower95, regressedTasks, retained, reason };
}

/**
 * Require an apparent harness improvement to survive a task-disjoint holdout.
 * Harness evolution is a search procedure, so a training-set win alone is not
 * evidence of a transferable improvement. The two comparisons still use the
 * normal matched-protocol and task-balanced gates.
 */
export function evaluateHarnessGeneralization(
  training: HarnessTrial[],
  heldOut: HarnessTrial[],
  challenger: string,
  incumbent: string,
): HarnessGeneralizationReport {
  const trainingProtocol = validateBenchmarkProtocol(training);
  const heldOutProtocol = validateBenchmarkProtocol(heldOut);
  if (!trainingProtocol.valid) throw new Error(`Training benchmark protocol is invalid: ${trainingProtocol.issues.map((issue) => issue.message).join("; ")}`);
  if (!heldOutProtocol.valid) throw new Error(`Held-out benchmark protocol is invalid: ${heldOutProtocol.issues.map((issue) => issue.message).join("; ")}`);
  const trainingTasks = new Set(training.filter((trial) => trial.harness === challenger || trial.harness === incumbent).map((trial) => trial.task));
  const heldOutTasks = new Set(heldOut.filter((trial) => trial.harness === challenger || trial.harness === incumbent).map((trial) => trial.task));
  const overlappingTasks = [...trainingTasks].filter((task) => heldOutTasks.has(task)).sort();
  const protocolDifferences = compareProtocolParity(training, heldOut);
  const protocolParity = protocolDifferences.length === 0;
  const trainingComparison = compareHarnesses(training, challenger, incumbent);
  const heldOutComparison = compareHarnesses(heldOut, challenger, incumbent);
  const generalizes = overlappingTasks.length === 0 && protocolParity && trainingComparison.challengerWins && heldOutComparison.challengerWins;
  const reason = overlappingTasks.length
    ? `train and held-out task sets overlap: ${overlappingTasks.join(", ")}`
    : !protocolParity
      ? `train and held-out protocols differ: ${protocolDifferences.join("; ")}`
    : !trainingComparison.challengerWins
      ? `challenger has no proven training win: ${trainingComparison.reason}`
      : !heldOutComparison.challengerWins
        ? `training win does not transfer to held-out tasks: ${heldOutComparison.reason}`
        : `challenger wins both task-disjoint training and held-out comparisons`;
  return { challenger, incumbent, training: trainingComparison, heldOut: heldOutComparison, overlappingTasks, protocolParity, protocolDifferences, generalizes, reason };
}

/**
 * Compare research harnesses under identical task/budget arms. Invalid or
 * unmeasured runs never count as improvements, preventing optimistic scores
 * from agents that produce impressive narratives without durable evidence.
 */
export function scoreHarnessTrials(trials: HarnessTrial[]): HarnessScorecard[] {
  const grouped = new Map<string, HarnessTrial[]>();
  for (const trial of trials) grouped.set(trial.harness, [...(grouped.get(trial.harness) ?? []), trial]);
  return [...grouped.entries()].map(([harness, entries]) => {
    const deltas = entries.map(delta).filter((value): value is number => value !== undefined);
    const improvements = deltas.filter((value) => value > 0).length;
    const reproducible = entries.filter((entry) => entry.validRun && entry.reproducible).length;
    const recovery = entries.filter((entry) => entry.recovered).length;
    const valid = entries.filter((entry) => entry.validRun).length;
    const validRate = valid / entries.length;
    const improvementRate = improvements / entries.length;
    const recoveryRate = recovery / entries.length;
    const reproducibilityRate = reproducible / entries.length;
    const processValues = entries.map((entry) => entry.processQuality).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const alignmentValues = entries.filter((entry) => entry.executionAlignment !== undefined).map((entry) => entry.executionAlignment ? 1 : 0);
    const efficiencyValues = entries.map(timeEfficiency).filter((value): value is number => value !== undefined);
    const failureProfile: Record<string, number> = {};
    for (const entry of entries) {
      if (entry.validRun) continue;
      const failure = entry.failureClass ?? "unknown";
      failureProfile[failure] = (failureProfile[failure] ?? 0) + 1;
    }
    // Evidence quality is a first-class part of competitiveness. Aggregate by
    // task first so a harness cannot win by running many trials on one easy
    // task. The lower bound is a conservative guard against lucky portfolios.
    const means = taskMeans(entries);
    const taskBalancedScore = means.length ? means.reduce((sum, value) => sum + value, 0) / means.length : 0;
    const sliceScores = sliceMeans(entries);
    const sliceValues = Object.values(sliceScores);
    const sliceBalancedScore = sliceValues.length ? sliceValues.reduce((sum, value) => sum + value, 0) / sliceValues.length : 0;
    const competitiveScore = taskBalancedScore;
    return {
      harness,
      trials: entries.length,
      tasks: means.length,
      validRunRate: validRate,
      improvementRate,
      meanDelta: deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : null,
      medianTimeToEvidenceSeconds: median(entries.filter((entry) => entry.validRun && Number.isFinite(entry.timeToEvidenceSeconds ?? entry.durationSeconds)).map((entry) => entry.timeToEvidenceSeconds ?? entry.durationSeconds)),
      recoveryRate,
      reproducibilityRate,
      competitiveScore,
      taskBalancedScore,
      sliceBalancedScore,
      sliceScores,
      competitiveScoreLower95: bootstrapLower95(means, harness),
      meanProcessQuality: processValues.length ? processValues.reduce((sum, value) => sum + Math.max(0, Math.min(1, value)), 0) / processValues.length : null,
      executionAlignmentRate: alignmentValues.length ? alignmentValues.reduce<number>((sum, value) => sum + value, 0) / alignmentValues.length : null,
      meanTimeEfficiency: efficiencyValues.length ? efficiencyValues.reduce((sum, value) => sum + value, 0) / efficiencyValues.length : null,
      failureProfile,
    };
  }).sort((a, b) => b.competitiveScore - a.competitiveScore);
}

/**
 * Return the non-dominated harnesses instead of collapsing quality and cost
 * into one arbitrary scalar. Higher score/lower bound is better; lower median
 * time is better. Missing timing is conservatively treated as infinitely slow.
 */
export function harnessParetoFrontier(scorecards: HarnessScorecard[]): HarnessParetoPoint[] {
  const points = scorecards.map((scorecard) => ({
    harness: scorecard.harness,
    competitiveScore: scorecard.competitiveScore,
    competitiveScoreLower95: scorecard.competitiveScoreLower95,
    medianTimeToEvidenceSeconds: scorecard.medianTimeToEvidenceSeconds,
    onFrontier: true,
    dominatedBy: [] as string[],
  }));
  for (const point of points) {
    for (const other of points) {
      if (other.harness === point.harness) continue;
      const pointTime = point.medianTimeToEvidenceSeconds ?? Infinity;
      const otherTime = other.medianTimeToEvidenceSeconds ?? Infinity;
      const noWorse = other.competitiveScore >= point.competitiveScore &&
        other.competitiveScoreLower95 >= point.competitiveScoreLower95 &&
        otherTime <= pointTime;
      const strictlyBetter = other.competitiveScore > point.competitiveScore ||
        other.competitiveScoreLower95 > point.competitiveScoreLower95 ||
        otherTime < pointTime;
      if (noWorse && strictlyBetter) {
        point.onFrontier = false;
        point.dominatedBy.push(other.harness);
      }
    }
    point.dominatedBy.sort();
  }
  return points.sort((left, right) => Number(right.onFrontier) - Number(left.onFrontier) || right.competitiveScoreLower95 - left.competitiveScoreLower95 || left.harness.localeCompare(right.harness));
}
