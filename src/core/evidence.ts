import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { EvidenceGateSchema, RunResultSchema, type EvidenceGate, type ExperimentManifest, type RunResult } from "./types.js";

export function sha256File(path: string): string {
  if (!existsSync(path)) throw new Error(`Artifact does not exist: ${path}`);
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

export function validateRunResult(value: unknown): RunResult {
  const result = RunResultSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid worker result: ${result.error.issues.map((issue) => issue.path.join(".") + " " + issue.message).join("; ")}`);
  return result.data;
}

export function evaluateEvidenceGate(manifest: ExperimentManifest, gate: EvidenceGate): { accepted: boolean; reasons: string[] } {
  const parsed = EvidenceGateSchema.parse(gate);
  const reasons: string[] = [];
  if (!parsed.validCommit) reasons.push("git commit is missing or changed");
  if (!parsed.datasetMatch) reasons.push("dataset version does not match manifest");
  if (!parsed.splitMatch) reasons.push("split version does not match manifest");
  if (!parsed.outputsComplete) reasons.push(`required artifacts incomplete: ${manifest.evaluation.requiredArtifacts.join(", ")}`);
  if (!parsed.predictionsValid) reasons.push("predictions failed schema validation");
  if (!parsed.metricsRecomputed) reasons.push("metrics were not independently recomputed");
  if (!parsed.leakageAuditPassed) reasons.push("leakage audit did not pass");
  if (!parsed.reviewerApproved) reasons.push("independent review is missing");
  if (!parsed.verifiersPassed) reasons.push("declared verifiers did not all pass with complete independent evidence");
  return { accepted: reasons.length === 0, reasons };
}
