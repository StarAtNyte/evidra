import { existsSync, statSync } from "node:fs";
import { evaluateEvidenceGate, sha256File } from "./evidence.js";
import type { ExperimentManifest, RunResult } from "./types.js";
import { auditSubtask, type SubtaskAudit, type SubtaskContract } from "./subtask-state.js";

export interface ValidationContext {
  currentCommit: string;
  datasetVersion: string;
  splitVersion: string;
  /** The competition's declared primary metric; required for metric outcomes. */
  metricName?: string;
  leakageAuditPassed?: boolean;
  reviewerApproved?: boolean;
  /** Required only when the experiment contract requests an external score. */
  externalScoreRequired?: boolean;
  externalScoreObserved?: boolean;
  /** Whether an independently executed child experiment has completed. */
  independentReplicationObserved?: boolean;
  artifactChecksums?: Record<string, string>;
}

export interface ExperimentAudit {
  accepted: boolean;
  reasons: string[];
  gates: Record<string, boolean>;
  missingMetrics: string[];
  evidenceContract: "metric_suite" | "artifact_or_verifier" | "missing";
}

export function experimentAuditContract(manifest: Pick<ExperimentManifest, "id" | "hypothesisId">, gateNames: string[]): SubtaskContract {
  return {
    id: `experiment_audit:${manifest.id}`,
    objective: `Verify experiment ${manifest.id} for hypothesis ${manifest.hypothesisId}.`,
    scope: "experiment",
    acceptanceCriteria: gateNames.map((name) => ({ id: `gate:${name}`, description: `experiment gate '${name}' passes`, required: true })),
  };
}

/** Convert the complete experiment verifier result into the shared audit form. */
export function auditExperimentSubtask(manifest: ExperimentManifest, audit: ExperimentAudit, evidenceIds: string[] = []): SubtaskAudit {
  const gateNames = Object.keys(audit.gates);
  const contract = experimentAuditContract(manifest, gateNames);
  return auditSubtask(contract, gateNames.map((name) => ({
    criterionId: `gate:${name}`,
    satisfied: audit.gates[name] === true,
    source: "verifier" as const,
    evidenceIds: audit.gates[name] === true ? evidenceIds : [],
    detail: audit.gates[name] === true ? "experiment verifier passed" : audit.reasons.find((reason) => reason.toLowerCase().includes(name.toLowerCase())) ?? "experiment verifier gate failed",
  })));
}

export function refreshExperimentAudit(manifest: ExperimentManifest, run: RunResult, context: ValidationContext, evidenceIds: string[] = []): { audit: ExperimentAudit; subtaskAudit: SubtaskAudit } {
  const audit = auditExperiment(manifest, run, context);
  return { audit, subtaskAudit: auditExperimentSubtask(manifest, audit, evidenceIds) };
}

/** Find a completed child run without trusting a model-reported replication flag. */
export function independentReplicationObserved(
  experimentId: string,
  experiments: Array<{ id: string; payload: unknown }>,
  runs: Array<{ id?: string; experimentId: string; status: string }>,
): boolean {
  return experiments.some((entry) => {
    const payload = entry.payload as { parent?: unknown; replicationOf?: unknown; runId?: unknown };
    if (payload.parent !== experimentId && payload.replicationOf !== experimentId) return false;
    return runs.some((run) => run.experimentId === entry.id
      && run.status === "completed"
      && (typeof payload.runId !== "string" || run.id === payload.runId));
  });
}

/** Read external-score evidence from durable submission records, never from model prose. */
export function externalScoreObservedForExperiment(
  experimentId: string,
  submissions: Array<{ experimentId: string; status: string; payload: unknown }>,
  runId?: string,
): boolean {
  return submissions.some((entry) => {
    if (entry.experimentId !== experimentId || (entry.status !== "scored" && entry.status !== "submitted")) return false;
    const payload = entry.payload as { publicScore?: unknown; scoreObservation?: unknown; runId?: unknown };
    if (runId !== undefined && payload.runId !== runId) return false;
    return (typeof payload.publicScore === "number" && Number.isFinite(payload.publicScore))
      || (payload.scoreObservation !== undefined && payload.scoreObservation !== null);
  });
}

/** Apply a newly recorded external score to an existing audit without trusting
 * the score as proof of any other experiment criterion. */
export function refreshAuditWithExternalScore(audit: SubtaskAudit, evidenceId: string, detail = "durable external evaluator score observed"): SubtaskAudit {
  const criteria = audit.criteria.map((criterion) => criterion.id === "gate:externalScoreObserved"
    ? { ...criterion, satisfied: true, evidenceIds: [...new Set([...criterion.evidenceIds, evidenceId])], source: "auditor" as const, detail }
    : criterion);
  const unmetRequired = criteria.filter((criterion) => criterion.required !== false && !criterion.satisfied).map((criterion) => criterion.id);
  return { ...audit, status: unmetRequired.length === 0 ? "completed" : "blocked", complete: unmetRequired.length === 0, criteria, unmetRequired, auditedAt: new Date().toISOString() };
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

export function auditExperiment(manifest: ExperimentManifest, run: RunResult, context: ValidationContext): ExperimentAudit {
  const declaredVerifiers = (manifest.evaluation.verificationCommand ? 1 : 0) + (manifest.evaluation.verificationCommands?.length ?? 0);
  const verification = run.verification;
  const nonMetric = manifest.outcomeType !== "metric" && manifest.outcomeType !== undefined;
  const nonMetricEvidenceDeclared = manifest.evaluation.requiredArtifacts.length > 0 || declaredVerifiers > 0;
  const verifiersPassed = declaredVerifiers === 0
    ? true
    : verification?.declared === declaredVerifiers
      && verification.executed === declaredVerifiers
      && verification.passed === declaredVerifiers
      && verification.failed === 0
      && (declaredVerifiers < 2 || verification.independent === true);
  const matrix = validateEvaluationMatrix(manifest, run, context.metricName ?? "");
  const declaredMetricNames = [...new Set([context.metricName, ...(manifest.evaluation.metrics ?? []).map((objective) => objective.name)].filter((name): name is string => Boolean(name)))];
  const missingMetrics = nonMetric ? [] : declaredMetricNames.filter((name) => typeof run.metrics[name] !== "number" || !Number.isFinite(run.metrics[name]));
  const metricsRecomputed = nonMetric
    ? run.status === "completed" && nonMetricEvidenceDeclared
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
    replicationObserved: !manifest.acceptance.requireReplication || context.independentReplicationObserved === true,
    ...((context.externalScoreRequired === true || manifest.acceptance.requireExternalScore) ? { externalScoreObserved: context.externalScoreObserved === true } : {}),
  };
  const result = evaluateEvidenceGate(manifest, gates);
  const reasons = [...result.reasons];
  if (missingMetrics.length) reasons.push(`missing finite declared metric${missingMetrics.length === 1 ? "" : "s"}: ${missingMetrics.join(", ")}`);
  if (nonMetric && !nonMetricEvidenceDeclared) reasons.push("non-metric outcome must declare at least one required artifact or verifier");
  return { accepted: reasons.length === 0, reasons, gates, missingMetrics, evidenceContract: nonMetric ? nonMetricEvidenceDeclared ? "artifact_or_verifier" : "missing" : "metric_suite" };
}
