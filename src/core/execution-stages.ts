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

export function validateExecutionContract(manifest: Pick<ExperimentManifest, "resources" | "evaluation">, cwd: string, command: string[]): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!command.length || command.some((part) => !part.trim())) reasons.push("experiment command is empty or contains a blank argument");
  if (!Number.isFinite(manifest.resources.timeoutMinutes) || manifest.resources.timeoutMinutes <= 0) reasons.push("timeout must be positive");
  if (!resolve(cwd) || !isAbsolute(resolve(cwd))) reasons.push("experiment cwd must resolve to an absolute path");
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
