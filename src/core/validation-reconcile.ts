import { readFileSync } from "node:fs";
import { assertValidationPolicy, lockValidationPolicy, readValidationPolicyLock, unlockValidationPolicy, type ValidationPolicyLock } from "./validation-lock.js";
import { validationPolicyContract, ValidationPolicySchema, writeValidationPolicy, type ValidationPolicy } from "./validation-policy.js";

export interface ValidationLockReconciliation {
  /**
   * - `none`: no locked policy exists, so there is nothing to reconcile.
   * - `current`: the locked policy matches the active task contract.
   * - `relocked`: the stale lock was replaced; no candidate depended on it.
   * - `operator_required`: candidates were evaluated under the stale policy.
   */
  status: "none" | "current" | "relocked" | "operator_required";
  lock?: ValidationLockLike;
  previousChecksum?: string;
  checksum?: string;
  previousVersion?: string;
  version?: string;
  changedFields: string[];
  evaluatedExperimentIds: string[];
  reason?: string;
  commands: string[];
  unlockRecord?: ValidationPolicyLock;
  lockRecord?: ValidationPolicyLock;
  policy?: ValidationPolicy;
}

type ValidationLockLike = Pick<ValidationPolicyLock, "checksum" | "locked" | "lockedAt">;

const CONTRACT_FIELDS = ["version", "datasetRevision", "primarySplit", "secondarySplits", "folds", "seeds", "metric", "secondaryMetrics", "acceptance"] as const;

/** Operator commands that replace a stale lock deliberately. */
export const STALE_VALIDATION_LOCK_COMMANDS = [
  'evidra validation unlock --reason "<why the task contract changed>"',
  "evidra validation generate",
  "evidra validation lock",
];

/**
 * Reconcile a locked validation policy with the active task contract.
 *
 * A lock protects candidates from being judged under a moved goalpost. When
 * the task manifest changed after locking and no candidate has been evaluated
 * under the old policy, there is nothing to protect: regenerate and re-lock
 * with an auditable reason. When candidates were evaluated, never change the
 * policy automatically; an operator must decide how to treat those results.
 */
export function reconcileValidationPolicyLock(
  paths: { policy: string; lock: string },
  expected: ValidationPolicy,
  evaluatedExperimentIds: (lock: ValidationLockLike) => string[],
): ValidationLockReconciliation {
  const current = readValidationPolicyLock(paths.lock);
  if (!current?.locked) return { status: "none", changedFields: [], evaluatedExperimentIds: [], commands: [] };
  // Tampering with a locked file is an integrity failure, not staleness.
  const verified = assertValidationPolicy(paths.policy, paths.lock);
  const existing = ValidationPolicySchema.parse(JSON.parse(readFileSync(paths.policy, "utf8")));
  if (validationPolicyContract(existing) === validationPolicyContract(expected)) {
    return { status: "current", lock: verified, previousChecksum: verified.checksum, checksum: verified.checksum, version: existing.version, changedFields: [], evaluatedExperimentIds: [], commands: [], policy: existing };
  }
  const changedFields = CONTRACT_FIELDS.filter((field) => JSON.stringify(existing[field]) !== JSON.stringify(expected[field]));
  const evaluated = [...new Set(evaluatedExperimentIds(verified))].sort();
  const reason = `locked validation policy ${existing.version} no longer matches the active task contract (changed: ${changedFields.join(", ")})`;
  if (evaluated.length) {
    return {
      status: "operator_required",
      lock: verified,
      previousChecksum: verified.checksum,
      previousVersion: existing.version,
      version: expected.version,
      changedFields,
      evaluatedExperimentIds: evaluated,
      reason: `${reason}; ${evaluated.length} candidate experiment(s) were evaluated under it, so it was not changed automatically`,
      commands: STALE_VALIDATION_LOCK_COMMANDS,
    };
  }
  const unlockRecord = unlockValidationPolicy(paths.policy, paths.lock, `automatic: ${reason}; no candidate was evaluated under it`);
  const checksum = writeValidationPolicy(paths.policy, expected);
  const lockRecord = lockValidationPolicy(paths.policy, paths.lock);
  return {
    status: "relocked",
    lock: lockRecord,
    previousChecksum: verified.checksum,
    checksum,
    previousVersion: existing.version,
    version: expected.version,
    changedFields,
    evaluatedExperimentIds: [],
    reason,
    commands: [],
    unlockRecord,
    lockRecord,
    policy: expected,
  };
}
