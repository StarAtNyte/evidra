export type ScoreDirection = "maximize" | "minimize";

export interface HarnessTrial {
  harness: string;
  task: string;
  /** Optional protocol identity fields. Older exports remain readable. */
  arm?: string;
  seed?: string | number;
  model?: string;
  budgetMinutes?: number;
  direction: ScoreDirection;
  baselineMetric: number;
  candidateMetric?: number;
  validRun: boolean;
  durationSeconds: number;
  recovered: boolean;
  reproducible: boolean;
}

export interface BenchmarkProtocolIssue {
  key: string;
  field: "task" | "arm" | "seed" | "model" | "budgetMinutes" | "direction";
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
    const key = [trial.task, trial.arm ?? "", trial.seed ?? "", trial.model ?? "", trial.budgetMinutes ?? ""].join("\u001f");
    groups.set(key, [...(groups.get(key) ?? []), trial]);
  }

  const required: Array<BenchmarkProtocolIssue["field"]> = ["arm", "seed", "model", "budgetMinutes"];
  const complete = trials.length > 0 && trials.every((trial) =>
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
      ["arm", (trial) => trial.arm === undefined ? "<missing>" : String(trial.arm)],
      ["seed", (trial) => trial.seed === undefined ? "<missing>" : String(trial.seed)],
      ["model", (trial) => trial.model ?? "<missing>"],
      ["budgetMinutes", (trial) => trial.budgetMinutes === undefined ? "<missing>" : String(trial.budgetMinutes)],
      ["direction", (trial) => trial.direction],
    ];
    for (const [field, read] of fields) {
      const values = [...new Set(entries.map(read))];
      if (values.length > 1) issues.push({ key, field, values, message: `${field} differs within a matched task arm.` });
    }
    const observedHarnesses = new Set(entries.map((entry) => entry.harness));
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
  competitiveScoreLower95: number;
}

function delta(trial: HarnessTrial): number | undefined {
  if (!trial.validRun || trial.candidateMetric === undefined || !Number.isFinite(trial.candidateMetric) || !Number.isFinite(trial.baselineMetric)) return undefined;
  return trial.direction === "maximize" ? trial.candidateMetric - trial.baselineMetric : trial.baselineMetric - trial.candidateMetric;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function trialQuality(trial: HarnessTrial): number {
  const measuredDelta = delta(trial);
  const improvement = measuredDelta !== undefined && measuredDelta > 0 ? 1 : 0;
  return 100 * (0.45 * improvement + 0.25 * (trial.validRun ? 1 : 0) + 0.15 * (trial.validRun && trial.reproducible ? 1 : 0) + 0.15 * (trial.recovered ? 1 : 0));
}

function taskMeans(entries: HarnessTrial[]): number[] {
  const byTask = new Map<string, HarnessTrial[]>();
  for (const entry of entries) byTask.set(entry.task, [...(byTask.get(entry.task) ?? []), entry]);
  return [...byTask.values()].map((taskEntries) => taskEntries.reduce((sum, entry) => sum + trialQuality(entry), 0) / taskEntries.length);
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
    // Evidence quality is a first-class part of competitiveness. Aggregate by
    // task first so a harness cannot win by running many trials on one easy
    // task. The lower bound is a conservative guard against lucky portfolios.
    const means = taskMeans(entries);
    const taskBalancedScore = means.length ? means.reduce((sum, value) => sum + value, 0) / means.length : 0;
    const competitiveScore = taskBalancedScore;
    return {
      harness,
      trials: entries.length,
      tasks: means.length,
      validRunRate: validRate,
      improvementRate,
      meanDelta: deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : null,
      medianTimeToEvidenceSeconds: median(entries.filter((entry) => entry.validRun && Number.isFinite(entry.durationSeconds)).map((entry) => entry.durationSeconds)),
      recoveryRate,
      reproducibilityRate,
      competitiveScore,
      taskBalancedScore,
      competitiveScoreLower95: bootstrapLower95(means, harness),
    };
  }).sort((a, b) => b.competitiveScore - a.competitiveScore);
}
