import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResearchStore } from "./store.js";
import type { EnvironmentSnapshot } from "./environment.js";
import { sha256File } from "./evidence.js";
import { redactSecrets, redactStructured } from "./redaction.js";
import { validateRunMetrics, type ExperimentExecutor } from "./executors.js";
import type { ExperimentManifest, RunResult } from "./types.js";
import type { ProcessControl } from "./process.js";

export type PersistedExecutionStage = "smoke" | "reduced_validation";

/** Persist the complete evidence for cheap stages, including failed results.
 * Stage gates often stop before full validation; they must not discard the
 * output that explains why a candidate failed or passed.
 */
export function persistExecutionStageResult(options: {
  store: ResearchStore;
  experimentId: string;
  stage: PersistedExecutionStage;
  result: RunResult;
  primaryMetricName: string;
  command: string[];
  cwd: string;
  executor: string;
  artifactRoot: string;
  environment: EnvironmentSnapshot;
}): RunResult {
  const { store, experimentId, stage, result, primaryMetricName, command, cwd, executor, artifactRoot, environment } = options;
  const artifactDirectory = join(artifactRoot, result.runId);
  mkdirSync(artifactDirectory, { recursive: true });
  const stdout = redactSecrets(result.stdout ?? "");
  const stderr = redactSecrets(result.stderr ?? "");
  // A process can emit a plausible aggregate even when one or more examples,
  // folds, or workers failed. Keep those reported values for diagnosis, but
  // never expose them as comparable scores unless the stage itself passed.
  const metricEligible = result.status === "completed";
  const reportedPrimaryMetric = result.metrics[primaryMetricName] ?? null;
  const outputFiles: Record<string, string> = {};
  const files: Record<string, string> = {
    "stdout.log": stdout,
    "stderr.log": stderr,
    "metrics.json": `${JSON.stringify({ stage, status: result.status, exitCode: result.exitCode, durationSeconds: result.durationSeconds, failureClass: result.failureClass ?? null, metricEligible, primaryMetricName, primaryMetric: metricEligible ? reportedPrimaryMetric : null, reportedPrimaryMetric, metrics: result.metrics, metricConflicts: result.metricConflicts ?? [] }, null, 2)}\n`,
    "environment.json": `${JSON.stringify(redactStructured(environment), null, 2)}\n`,
  };
  try {
    const parsed = JSON.parse(stdout) as unknown;
    files["evaluator-result.json"] = `${JSON.stringify(parsed, null, 2)}\n`;
  } catch { /* Non-JSON evaluators remain available in stdout.log. */ }
  for (const [name, contents] of Object.entries(files)) {
    const path = join(artifactDirectory, name);
    writeFileSync(path, contents);
    outputFiles[name] = path;
  }

  const resolvedCommand = result.command ?? command;
  const resolvedCwd = result.cwd ?? cwd;
  const recorded: RunResult = {
    runId: result.runId,
    status: result.status,
    exitCode: result.exitCode,
    durationSeconds: result.durationSeconds,
    metrics: result.metrics,
    metricsByFold: result.metricsByFold,
    ...(result.learningCurve ? { learningCurve: result.learningCurve } : {}),
    ...(result.metricConflicts ? { metricConflicts: result.metricConflicts } : {}),
    subgroupDeltas: result.subgroupDeltas,
    ...(result.matrix ? { matrix: result.matrix } : {}),
    artifacts: { ...result.artifacts, ...outputFiles },
    command: resolvedCommand,
    cwd: resolvedCwd,
    ...(result.failureClass ? { failureClass: result.failureClass } : {}),
  };
  store.saveRun({ id: result.runId, experimentId, status: result.status, payload: recorded });
  for (const [name, path] of Object.entries(outputFiles)) {
    store.saveArtifact({ id: `${result.runId}-${name}`, runId: result.runId, name, path, checksum: sha256File(path) });
  }
  store.recordRunAttempt({
    id: `${experimentId}:${stage}:${result.runId}`,
    experimentId,
    runId: result.runId,
    attempt: 1,
    stage,
    status: result.status,
    exitCode: result.exitCode,
    failureClass: result.failureClass ?? null,
    durationSeconds: result.durationSeconds,
    metric: metricEligible ? reportedPrimaryMetric : null,
    metrics: result.metrics,
    metricConflicts: result.metricConflicts,
    command: resolvedCommand,
    cwd: resolvedCwd,
    executor,
  });
  store.appendEvent("experiment.stage.result_recorded", {
    experimentId,
    runId: result.runId,
    stage,
    status: result.status,
    exitCode: result.exitCode,
    failureClass: result.failureClass ?? null,
    durationSeconds: result.durationSeconds,
    metricEligible,
    primaryMetricName,
    metric: metricEligible ? reportedPrimaryMetric : null,
    reportedMetric: reportedPrimaryMetric,
    metrics: result.metrics,
    artifacts: outputFiles,
    command: resolvedCommand,
    cwd: resolvedCwd,
  });
  return recorded;
}

/** Run an optional cheap validation command without requiring final-run artifacts. */
export function runReducedValidation(
  executor: ExperimentExecutor,
  manifest: ExperimentManifest,
  cwd: string,
  command: string[],
  metricName: string,
  onProcess?: (control: ProcessControl) => void,
): Promise<RunResult> {
  const reducedManifest: ExperimentManifest = {
    ...manifest,
    evaluation: { ...manifest.evaluation, requiredArtifacts: [] },
  };
  return executor.run(reducedManifest, cwd, command, onProcess, metricName).then((result) =>
    !manifest.outcomeType || manifest.outcomeType === "metric" ? validateRunMetrics(result, [metricName, ...(manifest.evaluation.metrics ?? []).map((objective) => objective.name)]) : result,
  );
}
