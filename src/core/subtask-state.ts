/**
 * Provider-neutral contract for one unit of autonomous work.
 *
 * Executors may propose evidence, but only a verifier or auditor can satisfy
 * an acceptance criterion. This keeps long-running research from advancing on
 * an eloquent but unverified model response.
 */

export type SubtaskStatus = "pending" | "running" | "blocked" | "completed" | "failed";
export type SubtaskEvidenceSource = "verifier" | "auditor" | "executor";

export interface SubtaskAcceptanceCriterion {
  id: string;
  description: string;
  required?: boolean;
  verifier?: string;
  /** Relative importance for reporting multi-criterion research outcomes. */
  weight?: number;
}

export interface SubtaskContract {
  id: string;
  objective: string;
  acceptanceCriteria: SubtaskAcceptanceCriterion[];
  dependencies?: string[];
  scope?: string;
  createdAt?: string;
}

export interface SubtaskObservation {
  criterionId: string;
  satisfied: boolean;
  source: SubtaskEvidenceSource;
  evidenceIds?: string[];
  detail?: string;
}

export interface AuditedCriterion extends SubtaskAcceptanceCriterion {
  satisfied: boolean;
  evidenceIds: string[];
  source?: Exclude<SubtaskEvidenceSource, "executor">;
  detail?: string;
}

export interface SubtaskAudit {
  subtaskId: string;
  status: Extract<SubtaskStatus, "completed" | "blocked">;
  complete: boolean;
  criteria: AuditedCriterion[];
  unmetRequired: string[];
  /** Weighted completion is diagnostic; required criteria still gate completion. */
  weightedScore: number;
  totalWeight: number;
  ignoredObservations: string[];
  auditedAt: string;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function validateSubtaskContract(contract: SubtaskContract): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!normalize(contract.id)) reasons.push("subtask id is empty");
  if (!normalize(contract.objective)) reasons.push("subtask objective is empty");
  if (!contract.acceptanceCriteria.length) reasons.push("at least one acceptance criterion is required");
  const ids = new Set<string>();
  for (const criterion of contract.acceptanceCriteria) {
    const id = normalize(criterion.id);
    if (!id) reasons.push("acceptance criterion id is empty");
    else if (ids.has(id)) reasons.push(`duplicate acceptance criterion: ${id}`);
    ids.add(id);
    if (!normalize(criterion.description)) reasons.push(`acceptance criterion description is empty: ${id || "unknown"}`);
    if (criterion.weight !== undefined && (!Number.isFinite(criterion.weight) || criterion.weight <= 0)) reasons.push(`acceptance criterion weight must be positive: ${id || "unknown"}`);
  }
  for (const dependency of contract.dependencies ?? []) if (!normalize(dependency)) reasons.push("dependency id is empty");
  return { valid: reasons.length === 0, reasons };
}

/** Fail fast at the boundary where an agent-generated contract enters state. */
export function assertSubtaskContract(contract: SubtaskContract): SubtaskContract {
  const result = validateSubtaskContract(contract);
  if (!result.valid) throw new Error(`Invalid subtask contract: ${result.reasons.join("; ")}`);
  return {
    ...contract,
    id: normalize(contract.id),
    objective: normalize(contract.objective),
    acceptanceCriteria: contract.acceptanceCriteria.map((criterion) => ({
      ...criterion,
      id: normalize(criterion.id),
      description: normalize(criterion.description),
      required: criterion.required !== false,
      weight: criterion.weight === undefined ? 1 : criterion.weight,
    })),
    dependencies: contract.dependencies?.map(normalize),
  };
}

/**
 * Audit a subtask from structured observations. Executor-only observations are
 * deliberately ignored: an executor can report what it attempted, not prove
 * that the acceptance condition holds.
 */
export function auditSubtask(contractInput: SubtaskContract, observations: SubtaskObservation[], auditedAt = new Date().toISOString()): SubtaskAudit {
  const contract = assertSubtaskContract(contractInput);
  const byCriterion = new Map<string, SubtaskObservation>();
  const ignoredObservations: string[] = [];
  for (const observation of observations) {
    if (!contract.acceptanceCriteria.some((criterion) => criterion.id === observation.criterionId)) {
      ignoredObservations.push(observation.criterionId);
      continue;
    }
    if (observation.source === "executor") {
      ignoredObservations.push(observation.criterionId);
      continue;
    }
    // The latest verifier result is authoritative: a later failure revokes an
    // earlier pass, while a later successful recheck can repair a failure.
    byCriterion.set(observation.criterionId, observation);
  }
  const criteria = contract.acceptanceCriteria.map((criterion) => {
    const observation = byCriterion.get(criterion.id);
    return {
      ...criterion,
      satisfied: observation?.satisfied === true,
      evidenceIds: observation?.evidenceIds ?? [],
      source: observation && observation.source !== "executor" ? observation.source : undefined,
      detail: observation?.detail,
    };
  });
  const unmetRequired = criteria.filter((criterion) => criterion.required !== false && !criterion.satisfied).map((criterion) => criterion.id);
  const totalWeight = criteria.reduce((sum, criterion) => sum + (criterion.weight ?? 1), 0);
  const weightedScore = totalWeight > 0 ? criteria.reduce((sum, criterion) => sum + (criterion.satisfied ? (criterion.weight ?? 1) : 0), 0) / totalWeight : 0;
  return {
    subtaskId: contract.id,
    status: unmetRequired.length === 0 ? "completed" : "blocked",
    complete: unmetRequired.length === 0,
    criteria,
    unmetRequired,
    weightedScore,
    totalWeight,
    ignoredObservations,
    auditedAt,
  };
}

export function subtaskStateFromAudit(audit: SubtaskAudit): { status: SubtaskStatus; unmetRequired: string[] } {
  return { status: audit.complete ? "completed" : "blocked", unmetRequired: audit.unmetRequired };
}
