import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { EvidenceGateSchema, RunResultSchema, type EvidenceGate, type ExperimentManifest, type RunResult } from "./types.js";

export function sha256File(path: string): string {
  if (!existsSync(path)) throw new Error(`Artifact does not exist: ${path}`);
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`Artifact is not a regular file: ${path}`);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
      bytesRead += count;
    }
    const after = fstatSync(descriptor);
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error(`Artifact changed while it was being checksummed: ${path}`);
    }
    return `sha256:${digest.digest("hex")}`;
  } finally {
    closeSync(descriptor);
  }
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
  if (!parsed.evaluationCoverage) reasons.push("declared fold/seed evaluation matrix is incomplete or missing the primary metric");
  return { accepted: reasons.length === 0, reasons };
}
