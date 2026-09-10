import { existsSync, statSync } from "node:fs";
import { evaluateEvidenceGate } from "./evidence.js";
import type { ExperimentManifest, RunResult } from "./types.js";

export interface ValidationContext {
  currentCommit: string;
  datasetVersion: string;
  splitVersion: string;
  leakageAuditPassed?: boolean;
  reviewerApproved?: boolean;
}

export function auditExperiment(manifest: ExperimentManifest, run: RunResult, context: ValidationContext): { accepted: boolean; reasons: string[]; gates: Record<string, boolean> } {
  const gates = {
    validCommit: manifest.gitCommit === context.currentCommit,
    datasetMatch: manifest.datasetVersion === context.datasetVersion,
    splitMatch: manifest.splitVersion === context.splitVersion,
    outputsComplete: manifest.evaluation.requiredArtifacts.every((artifact) => {
      const path = run.artifacts[artifact];
      return typeof path === "string" && existsSync(path) && statSync(path).isFile();
    }),
    predictionsValid: run.status === "completed" && run.exitCode === 0,
    metricsRecomputed: Object.keys(run.metrics).length > 0,
    leakageAuditPassed: context.leakageAuditPassed ?? false,
    reviewerApproved: context.reviewerApproved ?? false,
  };
  const result = evaluateEvidenceGate(manifest, gates);
  return { ...result, gates };
}
