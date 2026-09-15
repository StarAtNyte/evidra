import { existsSync, statSync } from "node:fs";
import { evaluateEvidenceGate, sha256File } from "./evidence.js";
import type { ExperimentManifest, RunResult } from "./types.js";

export interface ValidationContext {
  currentCommit: string;
  datasetVersion: string;
  splitVersion: string;
  /** The competition's declared primary metric; required for metric outcomes. */
  metricName?: string;
  leakageAuditPassed?: boolean;
  reviewerApproved?: boolean;
  artifactChecksums?: Record<string, string>;
}

export function validateEvaluationMatrix(manifest: Pick<ExperimentManifest, "evaluation">, run: Pick<RunResult, "matrix">, metricName: string): { valid: boolean; expected: number; observed: number; missing: string[]; invalidMetric: string[] } {
  if (!manifest.evaluation.matrixRequired) return { valid: true, expected: 0, observed: run.matrix?.length ?? 0, missing: [], invalidMetric: [] };
  const cells = run.matrix ?? [];
  const observed = new Set(cells.map((cell) => `${cell.fold}:${cell.seed}`));
  const expectedCells = manifest.evaluation.folds.flatMap((fold) => manifest.evaluation.seeds.map((seed) => `${fold}:${seed}`));
  const missing = expectedCells.filter((key) => !observed.has(key));
  const objectiveNames = [...new Set([metricName, ...(manifest.evaluation.metrics ?? []).map((objective) => objective.name)].filter(Boolean))];
  const invalidMetric = cells.flatMap((cell) => objectiveNames
    .filter((name) => typeof cell.metrics[name] !== "number" || !Number.isFinite(cell.metrics[name]))
    .map((name) => `${cell.fold}:${cell.seed}:${name}`));
  return { valid: missing.length === 0 && invalidMetric.length === 0 && cells.length === observed.size && observed.size === expectedCells.length, expected: expectedCells.length, observed: observed.size, missing, invalidMetric };
}

export function auditExperiment(manifest: ExperimentManifest, run: RunResult, context: ValidationContext): { accepted: boolean; reasons: string[]; gates: Record<string, boolean> } {
  const declaredVerifiers = (manifest.evaluation.verificationCommand ? 1 : 0) + (manifest.evaluation.verificationCommands?.length ?? 0);
  const verification = run.verification;
  const verifiersPassed = declaredVerifiers === 0
    ? true
    : verification?.declared === declaredVerifiers
      && verification.executed === declaredVerifiers
      && verification.passed === declaredVerifiers
      && verification.failed === 0
      && (declaredVerifiers < 2 || verification.independent === true);
  const matrix = validateEvaluationMatrix(manifest, run, context.metricName ?? "");
  const declaredMetricNames = [...new Set([context.metricName, ...(manifest.evaluation.metrics ?? []).map((objective) => objective.name)].filter((name): name is string => Boolean(name)))];
  const metricsRecomputed = manifest.outcomeType !== "metric" && manifest.outcomeType !== undefined
    ? run.status === "completed"
    : declaredMetricNames.length
      ? declaredMetricNames.every((name) => typeof run.metrics[name] === "number" && Number.isFinite(run.metrics[name]))
      : Object.keys(run.metrics).length > 0;
  const gates = {
    validCommit: manifest.gitCommit === context.currentCommit,
    datasetMatch: manifest.datasetVersion === context.datasetVersion,
    splitMatch: manifest.splitVersion === context.splitVersion,
    outputsComplete: manifest.evaluation.requiredArtifacts.every((artifact) => {
      const path = run.artifacts[artifact];
      if (typeof path !== "string" || !existsSync(path) || !statSync(path).isFile()) return false;
      const expectedChecksum = context.artifactChecksums?.[artifact];
      return !expectedChecksum || sha256File(path) === expectedChecksum;
    }),
    predictionsValid: run.status === "completed" && run.exitCode === 0,
    metricsRecomputed,
    leakageAuditPassed: context.leakageAuditPassed ?? false,
    reviewerApproved: context.reviewerApproved ?? false,
    verifiersPassed,
    evaluationCoverage: matrix.valid,
  };
  const result = evaluateEvidenceGate(manifest, gates);
  return { ...result, gates };
}
