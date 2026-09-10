import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
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
  taskWorstMetric?: number;
  taskBestMetric?: number;
  /** Maximum bounded retries within the arm's total time budget. */
  retries?: number;
  metric: string;
  command: string[];
  cwd?: string;
}

export interface BenchmarkRunReport {
  schemaVersion: 1;
  startedAt: string;
  trials: HarnessTrial[];
  runs: Array<{ harness: string; command: string[]; cwd: string; result: ProcessResult; metric?: number; attempts: number }>;
}

function benchmarkCwd(root: string, requested: string | undefined, harness: string): string {
  const rootPath = realpathSync(resolve(root));
  const candidate = resolve(rootPath, requested ?? ".");
  // Resolve existing symlinks too: lexical containment alone would allow a
  // protocol to escape through a symlink inside the benchmark workspace.
  const checked = existsSync(candidate) ? realpathSync(candidate) : candidate;
  const escaped = relative(rootPath, checked);
  if (escaped.startsWith("..") || isAbsolute(escaped)) {
    throw new Error(`Benchmark arm '${harness}' cwd escapes benchmark root: ${requested ?? "."}`);
  }
  return checked;
}

/** Execute declared benchmark arms with identical metadata and bounded time. */
export async function runBenchmarkArms(arms: BenchmarkArmSpec[], root: string, onProgress?: (message: string) => void): Promise<BenchmarkRunReport> {
  if (!arms.length) throw new Error("Benchmark protocol contains no arms.");
  // Validate every arm before starting any process, so one malformed arm
  // cannot leave a partially executed benchmark protocol behind.
  const prepared = arms.map((arm) => {
    if (!arm.command.length || arm.command.some((part) => !part.trim())) throw new Error(`Benchmark arm '${arm.harness}' has an empty command.`);
    if (!Number.isFinite(arm.budgetMinutes) || arm.budgetMinutes <= 0) throw new Error(`Benchmark arm '${arm.harness}' must have a positive budget.`);
    if (arm.retries !== undefined && (!Number.isInteger(arm.retries) || arm.retries < 0 || arm.retries > 3)) throw new Error(`Benchmark arm '${arm.harness}' retries must be an integer from 0 to 3.`);
    return { arm, cwd: benchmarkCwd(root, arm.cwd, arm.harness) };
  });
  const startedAt = new Date().toISOString();
  const trials: HarnessTrial[] = [];
  const runs: BenchmarkRunReport["runs"] = [];
  for (const { arm, cwd } of prepared) {
    onProgress?.(`Benchmark · ${arm.harness} · ${arm.task} · ${arm.budgetMinutes}m`);
    const deadline = Date.now() + arm.budgetMinutes * 60_000;
    const maxAttempts = 1 + Math.min(3, Math.max(0, Math.floor(arm.retries ?? 0)));
    let result: ProcessResult | undefined;
    let metric: number | undefined;
    let validRun = false;
    let attempts = 0;
    let totalDurationMs = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs < 1_000) break;
      attempts += 1;
      result = await runProcess(arm.command, cwd, remainingMs);
      totalDurationMs += result.durationMs;
      const parsed = parseMetricOutput(result.stdout, arm.metric);
      metric = parsed.metrics[arm.metric];
      validRun = result.exitCode === 0 && Number.isFinite(metric);
      if (validRun || attempt === maxAttempts - 1) break;
      onProgress?.(`Benchmark · ${arm.harness} failed; retrying ${attempt + 1}/${maxAttempts - 1}`);
    }
    if (!result) throw new Error(`Benchmark arm '${arm.harness}' exhausted its time budget before the first attempt.`);
    runs.push({ harness: arm.harness, command: arm.command, cwd, result, metric: Number.isFinite(metric) ? metric : undefined, attempts });
    trials.push({
      harness: arm.harness,
      task: arm.task,
      arm: arm.arm,
      seed: arm.seed,
      model: arm.model,
      budgetMinutes: arm.budgetMinutes,
      direction: arm.direction,
      baselineMetric: arm.baselineMetric,
      ...(arm.taskWorstMetric !== undefined ? { taskWorstMetric: arm.taskWorstMetric } : {}),
      ...(arm.taskBestMetric !== undefined ? { taskBestMetric: arm.taskBestMetric } : {}),
      candidateMetric: Number.isFinite(metric) ? metric : undefined,
      validRun,
      durationSeconds: totalDurationMs / 1000,
      recovered: validRun && attempts > 1,
      reproducible: false,
    });
  }
  return { schemaVersion: 1, startedAt, trials, runs };
}
