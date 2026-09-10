import { resolve } from "node:path";
import { parseMetricOutput } from "./executors.js";
import { runProcess } from "./process.js";
import type { HarnessTrial, ScoreDirection } from "./harness-scorecard.js";
import type { ProcessResult } from "./types.js";

export interface BenchmarkArmSpec {
  harness: string;
  task: string;
  arm: string;
  seed: string | number;
  model: string;
  budgetMinutes: number;
  direction: ScoreDirection;
  baselineMetric: number;
  metric: string;
  command: string[];
  cwd?: string;
}

export interface BenchmarkRunReport {
  schemaVersion: 1;
  startedAt: string;
  trials: HarnessTrial[];
  runs: Array<{ harness: string; command: string[]; cwd: string; result: ProcessResult; metric?: number }>;
}

/** Execute declared benchmark arms with identical metadata and bounded time. */
export async function runBenchmarkArms(arms: BenchmarkArmSpec[], root: string, onProgress?: (message: string) => void): Promise<BenchmarkRunReport> {
  if (!arms.length) throw new Error("Benchmark protocol contains no arms.");
  const startedAt = new Date().toISOString();
  const trials: HarnessTrial[] = [];
  const runs: BenchmarkRunReport["runs"] = [];
  for (const arm of arms) {
    if (!arm.command.length || arm.command.some((part) => !part.trim())) throw new Error(`Benchmark arm '${arm.harness}' has an empty command.`);
    if (!Number.isFinite(arm.budgetMinutes) || arm.budgetMinutes <= 0) throw new Error(`Benchmark arm '${arm.harness}' must have a positive budget.`);
    const cwd = resolve(root, arm.cwd ?? ".");
    onProgress?.(`Benchmark · ${arm.harness} · ${arm.task} · ${arm.budgetMinutes}m`);
    const result = await runProcess(arm.command, cwd, arm.budgetMinutes * 60_000);
    const parsed = parseMetricOutput(result.stdout, arm.metric);
    const metric = parsed.metrics[arm.metric];
    const validRun = result.exitCode === 0 && Number.isFinite(metric);
    runs.push({ harness: arm.harness, command: arm.command, cwd, result, metric: Number.isFinite(metric) ? metric : undefined });
    trials.push({
      harness: arm.harness,
      task: arm.task,
      arm: arm.arm,
      seed: arm.seed,
      model: arm.model,
      budgetMinutes: arm.budgetMinutes,
      direction: arm.direction,
      baselineMetric: arm.baselineMetric,
      candidateMetric: Number.isFinite(metric) ? metric : undefined,
      validRun,
      durationSeconds: result.durationMs / 1000,
      recovered: false,
      reproducible: false,
    });
  }
  return { schemaVersion: 1, startedAt, trials, runs };
}
