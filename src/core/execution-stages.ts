import { isAbsolute, relative, resolve } from "node:path";
import type { ExperimentManifest } from "./types.js";

export type ExecutionStageId = "feasibility" | "smoke" | "reduced_validation" | "full_validation" | "replication" | "submission_review";
export type ExecutionStageStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface ExecutionStage {
  id: ExecutionStageId;
  title: string;
  status: ExecutionStageStatus;
  rationale: string;
}

export function createExecutionPlan(manifest: ExperimentManifest): ExecutionStage[] {
  const stages: ExecutionStage[] = [
    { id: "feasibility", title: "Static feasibility", status: "pending", rationale: "Validate command, worktree, timeout, and artifact contract before running code." },
    { id: "smoke", title: "Smoke run", status: "pending", rationale: "Catch import, configuration, and immediate runtime failures cheaply." },
    { id: "reduced_validation", title: "Reduced validation", status: "pending", rationale: "Test a bounded fold or reduced-data configuration before full compute." },
    { id: "full_validation", title: "Full validation", status: "pending", rationale: "Run the declared evaluation folds and seeds." },
  ];
  if (manifest.acceptance.requireReplication) stages.push({ id: "replication", title: "Independent replication", status: "pending", rationale: "Require an independent seed or child manifest before promotion." });
  stages.push({ id: "submission_review", title: "Submission review", status: "pending", rationale: "Prepare evidence and human approval; never submit implicitly." });
  return stages;
}

export function trivialSuccessCommand(command: string[]): boolean {
  const executable = command[0]?.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase();
  return executable === "true" || executable === ":";
}

/** A metric evaluator itself is valid verification evidence when an unchanged
 * implementation is under test; non-metric verification still needs explicit
 * artifacts or verifier commands.
 */
export function verificationOnlyHasEvidence(
  manifest: Pick<ExperimentManifest, "evaluation"> & Partial<Pick<ExperimentManifest, "outcomeType" | "implementationMode">>,
  command: string[],
): boolean {
  if (manifest.evaluation.requiredArtifacts.length || manifest.evaluation.verificationCommand?.length || manifest.evaluation.verificationCommands?.length) return true;
  return manifest.implementationMode === "verify"
    && manifest.outcomeType === "metric"
    && manifest.evaluation.metrics.length > 0
    && command.length > 0
    && command.every((part) => part.trim().length > 0)
    && !trivialSuccessCommand(command);
}

/** File-backed verification must name the exact source digest that is copied
 * into the isolated worktree. Otherwise a "replication" can silently measure
 * whichever estimator happens to be checked out at the base commit.
 */
export function verificationSourcePinError(manifest: { implementationMode?: unknown; outcomeType?: unknown; change?: { configPatch?: unknown }; evaluation?: { metrics?: unknown[] } }): string | undefined {
  if (manifest.implementationMode !== "verify") return undefined;
  const rawPatch = manifest.change?.configPatch;
  const patch = rawPatch && typeof rawPatch === "object" && !Array.isArray(rawPatch)
    ? rawPatch as Record<string, unknown>
    : undefined;
  const estimatorPath = typeof patch?.estimatorPath === "string" ? patch.estimatorPath.trim() : "";
  const source = patch?.implementationSource;
  const sourceRecord = source && typeof source === "object" && !Array.isArray(source)
    ? source as Record<string, unknown>
    : undefined;
  const targetPath = typeof sourceRecord?.targetPath === "string" ? sourceRecord.targetPath.trim() : estimatorPath;
  const fileBackedMetric = Boolean(estimatorPath)
    && (manifest.outcomeType === "metric" || (manifest.evaluation?.metrics?.length ?? 0) > 0);
  if (!sourceRecord && !fileBackedMetric) return undefined;
  if (!estimatorPath && !targetPath) return undefined;
  if (!sourceRecord || typeof sourceRecord.path !== "string" || !sourceRecord.path.trim()) {
    return "verification-only experiments with a file-backed estimator require implementationSource.path and a SHA-256 pin";
  }
  const digest = typeof sourceRecord.sha256 === "string" ? sourceRecord.sha256.trim() : "";
  if (!/^sha256:[a-f0-9]{64}$/i.test(digest)) {
    return "verification-only implementationSource.sha256 must be a sha256:-prefixed 64-character digest";
  }
  if (estimatorPath && targetPath && estimatorPath !== targetPath) {
    return `verification-only implementation source target ${targetPath} does not match evaluator estimatorPath ${estimatorPath}`;
  }
  return undefined;
}

export function validateExecutionContract(manifest: Pick<ExperimentManifest, "resources" | "evaluation"> & Partial<Pick<ExperimentManifest, "outcomeType" | "implementationMode" | "change">>, cwd: string, command: string[]): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!command.length || command.some((part) => !part.trim())) reasons.push("experiment command is empty or contains a blank argument");
  if (trivialSuccessCommand(command)) reasons.push("experiment command is a placeholder success command and cannot provide evaluation evidence");
  if (!Number.isFinite(manifest.resources.timeoutMinutes) || manifest.resources.timeoutMinutes <= 0) reasons.push("timeout must be positive");
  if (!resolve(cwd) || !isAbsolute(resolve(cwd))) reasons.push("experiment cwd must resolve to an absolute path");
  if (manifest.outcomeType === "metric" && manifest.evaluation.metrics.length === 0) reasons.push("metric experiment must declare at least one metric");
  if (manifest.outcomeType && manifest.outcomeType !== "metric") {
    const hasEvidenceContract = manifest.evaluation.requiredArtifacts.length > 0
      || Boolean(manifest.evaluation.verificationCommand?.length)
      || Boolean(manifest.evaluation.verificationCommands?.length);
    if (!hasEvidenceContract) reasons.push(`${manifest.outcomeType} experiment must declare required artifacts or verification commands`);
  }
  if (manifest.implementationMode === "verify" && !verificationOnlyHasEvidence(manifest, command)) reasons.push("verification-only experiment must declare required artifacts, verification commands, or a valid metric evaluator");
  const sourcePinFailure = verificationSourcePinError(manifest);
  if (sourcePinFailure) reasons.push(sourcePinFailure);
  const required = new Set<string>();
  for (const artifact of manifest.evaluation.requiredArtifacts) {
    if (required.has(artifact)) reasons.push(`duplicate required artifact: ${artifact}`);
    required.add(artifact);
    const artifactRelative = relative(resolve(cwd), resolve(cwd, artifact));
    if (isAbsolute(artifactRelative) || artifactRelative.startsWith("..")) reasons.push(`required artifact escapes experiment cwd: ${artifact}`);
  }
  return { valid: reasons.length === 0, reasons };
}

export function advanceExecutionStage(plan: ExecutionStage[], id: ExecutionStageId, status: Exclude<ExecutionStageStatus, "pending" | "running">): ExecutionStage[] {
  return plan.map((stage) => stage.id === id ? { ...stage, status } : stage);
}

export function nextExecutionStage(plan: ExecutionStage[]): ExecutionStage | undefined {
  return plan.find((stage) => stage.status === "pending");
}
