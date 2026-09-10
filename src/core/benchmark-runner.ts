import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseMetricOutput } from "./executors.js";
import { runProcess } from "./process.js";
import type { HarnessTrial, ScoreDirection } from "./harness-scorecard.js";
import type { ProcessResult } from "./types.js";
import { redactSecrets } from "./redaction.js";

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
  /** Optional independent command used to verify metric reproducibility. */
  reproducibilityCommand?: string[];
  reproducibilityTolerance?: number;
  metric: string;
  command: string[];
  cwd?: string;
}

export interface BenchmarkRunReport {
  schemaVersion: 1;
  startedAt: string;
  trials: HarnessTrial[];
  runs: Array<{ harness: string; command: string[]; cwd: string; result: ProcessResult; metric?: number; attempts: number; attemptDetails: BenchmarkAttemptRecord[]; reproducibility?: { command: string[]; result: ProcessResult; metric?: number; tolerance: number; matched: boolean } }>;
}

export interface BenchmarkAttemptRecord {
  attempt: number;
  exitCode: number;
  durationMs: number;
  metric?: number;
  stdoutTail: string;
  stderrTail: string;
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
    if (arm.reproducibilityCommand !== undefined && (!Array.isArray(arm.reproducibilityCommand) || !arm.reproducibilityCommand.length || arm.reproducibilityCommand.some((part) => typeof part !== "string" || !part.trim()))) throw new Error(`Benchmark arm '${arm.harness}' has an invalid reproducibility command.`);
    if (arm.reproducibilityTolerance !== undefined && (!Number.isFinite(arm.reproducibilityTolerance) || arm.reproducibilityTolerance < 0)) throw new Error(`Benchmark arm '${arm.harness}' reproducibility tolerance must be finite and non-negative.`);
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
    const attemptDetails: BenchmarkAttemptRecord[] = [];
    let reproducibility: BenchmarkRunReport["runs"][number]["reproducibility"];
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs < 1_000) break;
      attempts += 1;
      result = await runProcess(arm.command, cwd, remainingMs);
      totalDurationMs += result.durationMs;
      const parsed = parseMetricOutput(result.stdout, arm.metric);
      metric = parsed.metrics[arm.metric];
      validRun = result.exitCode === 0 && Number.isFinite(metric);
      attemptDetails.push({
        attempt: attempt + 1,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ...(Number.isFinite(metric) ? { metric } : {}),
        stdoutTail: redactSecrets(result.stdout.slice(-4_000)),
        stderrTail: redactSecrets(result.stderr.slice(-4_000)),
      });
      if (validRun || attempt === maxAttempts - 1) break;
      onProgress?.(`Benchmark · ${arm.harness} failed; retrying ${attempt + 1}/${maxAttempts - 1}`);
    }
    if (!result) throw new Error(`Benchmark arm '${arm.harness}' exhausted its time budget before the first attempt.`);
    let reproducible = false;
    if (validRun && arm.reproducibilityCommand) {
      const remainingMs = deadline - Date.now();
      if (remainingMs >= 1_000) {
        onProgress?.(`Benchmark · ${arm.harness} · independent reproducibility check`);
        const checkResult = await runProcess(arm.reproducibilityCommand, cwd, remainingMs);
        totalDurationMs += checkResult.durationMs;
        const checkMetric = parseMetricOutput(checkResult.stdout, arm.metric).metrics[arm.metric];
        const tolerance = arm.reproducibilityTolerance ?? 0;
        reproducible = checkResult.exitCode === 0 && Number.isFinite(checkMetric) && Math.abs(checkMetric - metric!) <= tolerance;
        reproducibility = { command: arm.reproducibilityCommand, result: checkResult, metric: Number.isFinite(checkMetric) ? checkMetric : undefined, tolerance, matched: reproducible };
      }
    }
    runs.push({ harness: arm.harness, command: arm.command, cwd, result, metric: Number.isFinite(metric) ? metric : undefined, attempts, attemptDetails, ...(reproducibility ? { reproducibility } : {}) });
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
      reproducible,
    });
  }
  return { schemaVersion: 1, startedAt, trials, runs };
}
