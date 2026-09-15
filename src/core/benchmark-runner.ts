import { existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { parseMetricOutput, prepareWorkerHome, safeWorkerEnvironment } from "./executors.js";
import { classifyProcessFailure } from "./executors.js";
import { runProcess } from "./process.js";
import type { HarnessTrial, ScoreDirection } from "./harness-scorecard.js";
import type { ProcessResult } from "./types.js";
import { redactSecrets } from "./redaction.js";

export interface BenchmarkArmSpec {
  harness: string;
  /** Explicit search policy provenance, e.g. greedy, ucb_portfolio, or mcts. */
  policy?: string;
  /** Optional checksummed harness component manifest for ablation attribution. */
  componentIds?: string[];
  task: string;
  slice?: string;
  arm: string;
  seed: string | number;
  /** Agent/provider route, e.g. codex or local; required for new cross-provider studies. */
  provider?: string;
  model: string;
  /** Fixed reasoning/thinking effort; defaults to Evidra's medium setting. */
  reasoningEffort?: string;
  budgetMinutes: number;
  dataRevision?: string;
  runtimeFingerprint?: string;
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
  /** Additional metrics that must be emitted for this arm to be valid. */
  requiredMetrics?: string[];
  command: string[];
  cwd?: string;
}

export interface BenchmarkRunReport {
  schemaVersion: 1;
  startedAt: string;
  /** Stable identity of the matched comparison contract, independent of harness commands. */
  protocolFingerprint: string;
  trials: HarnessTrial[];
  runs: Array<{ harness: string; command: string[]; cwd: string; result: ProcessResult; metric?: number; metrics?: Record<string, number>; attempts: number; attemptDetails: BenchmarkAttemptRecord[]; failureClass?: string; reproducibility?: { command: string[]; result: ProcessResult; metric?: number; metrics?: Record<string, number>; tolerance: number; matched: boolean } }>;
}

export interface BenchmarkAttemptRecord {
  attempt: number;
  exitCode: number;
  durationMs: number;
  metric?: number;
  metrics?: Record<string, number>;
  stdoutTail: string;
  stderrTail: string;
  failureClass?: string;
}

export interface BenchmarkRunOptions {
  /** Maximum number of independent task arms to execute concurrently. */
  maxParallel?: number;
}

/** Hash only fairness-critical protocol fields; harness implementations remain free to use different commands. */
export function benchmarkProtocolFingerprint(arms: BenchmarkArmSpec[]): string {
  const identity = arms.map((arm) => ({
    task: arm.task,
    slice: arm.slice ?? null,
    arm: arm.arm,
    seed: String(arm.seed),
    provider: arm.provider ?? "<default-provider>",
    model: arm.model,
    reasoningEffort: arm.reasoningEffort ?? "medium",
    budgetMinutes: arm.budgetMinutes,
    dataRevision: arm.dataRevision ?? null,
    runtimeFingerprint: arm.runtimeFingerprint ?? null,
    direction: arm.direction,
    baselineMetric: arm.baselineMetric,
    taskWorstMetric: arm.taskWorstMetric ?? null,
    taskBestMetric: arm.taskBestMetric ?? null,
    metric: arm.metric,
    requiredMetrics: [...new Set([arm.metric, ...(arm.requiredMetrics ?? [])])].sort(),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
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
export async function runBenchmarkArms(arms: BenchmarkArmSpec[], root: string, onProgress?: (message: string) => void, options: BenchmarkRunOptions = {}): Promise<BenchmarkRunReport> {
  if (!arms.length) throw new Error("Benchmark protocol contains no arms.");
  // Validate every arm before starting any process, so one malformed arm
  // cannot leave a partially executed benchmark protocol behind.
  const prepared = arms.map((arm) => {
    if (!arm.command.length || arm.command.some((part) => !part.trim())) throw new Error(`Benchmark arm '${arm.harness}' has an empty command.`);
    if (arm.provider !== undefined && (!arm.provider.trim() || arm.provider.length > 80)) throw new Error(`Benchmark arm '${arm.harness}' has an invalid provider label.`);
    if (arm.requiredMetrics !== undefined && (!Array.isArray(arm.requiredMetrics) || arm.requiredMetrics.some((name) => typeof name !== "string" || !name.trim()))) throw new Error(`Benchmark arm '${arm.harness}' has invalid required metric names.`);
    if (!Number.isFinite(arm.budgetMinutes) || arm.budgetMinutes <= 0) throw new Error(`Benchmark arm '${arm.harness}' must have a positive budget.`);
    if (arm.policy !== undefined && (!arm.policy.trim() || arm.policy.length > 80)) throw new Error(`Benchmark arm '${arm.harness}' has an invalid policy label.`);
    if (arm.retries !== undefined && (!Number.isInteger(arm.retries) || arm.retries < 0 || arm.retries > 3)) throw new Error(`Benchmark arm '${arm.harness}' retries must be an integer from 0 to 3.`);
    if (arm.reproducibilityCommand !== undefined && (!Array.isArray(arm.reproducibilityCommand) || !arm.reproducibilityCommand.length || arm.reproducibilityCommand.some((part) => typeof part !== "string" || !part.trim()))) throw new Error(`Benchmark arm '${arm.harness}' has an invalid reproducibility command.`);
    if (arm.reproducibilityTolerance !== undefined && (!Number.isFinite(arm.reproducibilityTolerance) || arm.reproducibilityTolerance < 0)) throw new Error(`Benchmark arm '${arm.harness}' reproducibility tolerance must be finite and non-negative.`);
    return { arm, cwd: benchmarkCwd(root, arm.cwd, arm.harness) };
  });
  const startedAt = new Date().toISOString();
  const workerEnvironment = safeWorkerEnvironment({ HOME: prepareWorkerHome(root) });
  const runOne = async ({ arm, cwd }: (typeof prepared)[number]): Promise<{ trial: HarnessTrial; run: BenchmarkRunReport["runs"][number] }> => {
    onProgress?.(`Benchmark · ${arm.harness} · ${arm.task} · ${arm.budgetMinutes}m`);
    const deadline = Date.now() + arm.budgetMinutes * 60_000;
    const maxAttempts = 1 + Math.min(3, Math.max(0, Math.floor(arm.retries ?? 0)));
    let result: ProcessResult | undefined;
    let metric: number | undefined;
    let metrics: Record<string, number> = {};
    let validRun = false;
    let attempts = 0;
    let totalDurationMs = 0;
    let timeToEvidenceSeconds: number | undefined;
    const attemptDetails: BenchmarkAttemptRecord[] = [];
    let reproducibility: BenchmarkRunReport["runs"][number]["reproducibility"];
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs < 1_000) break;
      attempts += 1;
      const attemptStartedAt = Date.now();
      let attemptEvidenceMs: number | undefined;
      let outputBuffer = "";
      result = await runProcess(arm.command, cwd, remainingMs, (_stream, chunk) => {
        if (attemptEvidenceMs !== undefined) return;
        outputBuffer = `${outputBuffer}${chunk}`.slice(-128_000);
        const observed = parseMetricOutput(outputBuffer, arm.metric).metrics[arm.metric];
        if (Number.isFinite(observed)) attemptEvidenceMs = Date.now() - attemptStartedAt;
      }, undefined, workerEnvironment);
      totalDurationMs += result.durationMs;
      const parsed = parseMetricOutput(result.stdout, arm.metric);
      const requiredMetrics = [...new Set([arm.metric, ...(arm.requiredMetrics ?? [])])];
      metrics = Object.fromEntries(Object.entries(parsed.metrics).filter(([name, value]) => requiredMetrics.includes(name) && Number.isFinite(value)));
      metric = parsed.metrics[arm.metric];
      validRun = result.exitCode === 0 && requiredMetrics.every((name) => Number.isFinite(metrics[name]));
      if (validRun && attemptEvidenceMs !== undefined) timeToEvidenceSeconds = (totalDurationMs - result.durationMs + attemptEvidenceMs) / 1000;
      attemptDetails.push({
        attempt: attempt + 1,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ...(Number.isFinite(metric) ? { metric } : {}),
        ...(Object.keys(metrics).length ? { metrics: { ...metrics } } : {}),
        stdoutTail: redactSecrets(result.stdout.slice(-4_000)),
        stderrTail: redactSecrets(result.stderr.slice(-4_000)),
        ...(result.exitCode !== 0 ? { failureClass: classifyProcessFailure(result) ?? "unknown" } : !validRun ? { failureClass: "invalid_metric_suite" } : {}),
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
        const checkResult = await runProcess(arm.reproducibilityCommand, cwd, remainingMs, undefined, undefined, workerEnvironment);
        totalDurationMs += checkResult.durationMs;
        const checkMetrics = parseMetricOutput(checkResult.stdout, arm.metric).metrics;
        const requiredMetrics = [...new Set([arm.metric, ...(arm.requiredMetrics ?? [])])];
        const checkMetric = checkMetrics[arm.metric];
        const tolerance = arm.reproducibilityTolerance ?? 0;
        reproducible = checkResult.exitCode === 0 && requiredMetrics.every((name) => Number.isFinite(checkMetrics[name])) && Number.isFinite(checkMetric) && Math.abs(checkMetric - metric!) <= tolerance;
        reproducibility = { command: arm.reproducibilityCommand, result: checkResult, metric: Number.isFinite(checkMetric) ? checkMetric : undefined, metrics: Object.fromEntries(Object.entries(checkMetrics).filter(([name, value]) => requiredMetrics.includes(name) && Number.isFinite(value))), tolerance, matched: reproducible };
      }
    }
    const finalFailure = attemptDetails.at(-1)?.failureClass;
    // Metric parsing above intentionally uses the in-memory process result;
    // persisted benchmark reports must not carry raw worker output.
    const reportResult = { ...result, stdout: redactSecrets(result.stdout), stderr: redactSecrets(result.stderr) };
    const reportReproducibility = reproducibility
      ? { ...reproducibility, result: { ...reproducibility.result, stdout: redactSecrets(reproducibility.result.stdout), stderr: redactSecrets(reproducibility.result.stderr) } }
      : undefined;
    const run: BenchmarkRunReport["runs"][number] = { harness: arm.harness, command: arm.command, cwd, result: reportResult, metric: Number.isFinite(metric) ? metric : undefined, ...(Object.keys(metrics).length ? { metrics: { ...metrics } } : {}), attempts, attemptDetails, ...(finalFailure ? { failureClass: finalFailure } : {}), ...(reportReproducibility ? { reproducibility: reportReproducibility } : {}) };
    const trial: HarnessTrial = {
      harness: arm.harness,
      ...(arm.policy ? { policy: arm.policy } : {}),
      ...(arm.componentIds ? { componentIds: [...new Set(arm.componentIds)].sort() } : {}),
      task: arm.task,
      ...(arm.slice ? { slice: arm.slice } : {}),
      arm: arm.arm,
      seed: arm.seed,
      model: arm.model,
      ...(arm.provider ? { provider: arm.provider } : {}),
      reasoningEffort: arm.reasoningEffort ?? "medium",
      budgetMinutes: arm.budgetMinutes,
      ...(arm.dataRevision ? { dataRevision: arm.dataRevision } : {}),
      ...(arm.runtimeFingerprint ? { runtimeFingerprint: arm.runtimeFingerprint } : {}),
      direction: arm.direction,
      baselineMetric: arm.baselineMetric,
      ...(arm.taskWorstMetric !== undefined ? { taskWorstMetric: arm.taskWorstMetric } : {}),
      ...(arm.taskBestMetric !== undefined ? { taskBestMetric: arm.taskBestMetric } : {}),
      candidateMetric: Number.isFinite(metric) ? metric : undefined,
      ...(Object.keys(metrics).length ? { candidateMetrics: { ...metrics } } : {}),
      validRun,
      durationSeconds: totalDurationMs / 1000,
      ...(timeToEvidenceSeconds !== undefined ? { timeToEvidenceSeconds } : {}),
      recovered: validRun && attempts > 1,
      reproducibilityChecked: Boolean(arm.reproducibilityCommand),
      ...(finalFailure ? { failureClass: finalFailure } : {}),
      reproducible,
    };
    return { trial, run };
  };
  const results: Array<{ trial: HarnessTrial; run: BenchmarkRunReport["runs"][number] } | undefined> = Array.from({ length: prepared.length });
  let next = 0;
  const requestedConcurrency = Math.max(1, Math.min(prepared.length, Math.floor(options.maxParallel ?? 1)));
  const sharedWorkspace = new Set(prepared.map((entry) => entry.cwd)).size < prepared.length;
  const concurrency = sharedWorkspace ? 1 : requestedConcurrency;
  if (sharedWorkspace && requestedConcurrency > 1) onProgress?.("Benchmark · shared workspace detected; serializing arms to preserve isolation");
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= prepared.length) return;
      results[index] = await runOne(prepared[index]);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { schemaVersion: 1, startedAt, protocolFingerprint: benchmarkProtocolFingerprint(arms), trials: results.map((result) => result!.trial), runs: results.map((result) => result!.run) };
}
