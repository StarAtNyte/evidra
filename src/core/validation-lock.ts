import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface ValidationPolicyLock {
  policyPath: string;
  checksum: string;
  locked: boolean;
  lockedAt: string;
  unlockedAt?: string;
  unlockReason?: string;
}

function checksum(path: string): string {
  if (!existsSync(path)) throw new Error(`Validation policy does not exist: ${path}`);
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

export function readValidationPolicyLock(lockPath: string): ValidationPolicyLock | undefined {
  if (!existsSync(lockPath)) return undefined;
  const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as ValidationPolicyLock;
  if (typeof parsed.policyPath !== "string" || typeof parsed.checksum !== "string" || typeof parsed.locked !== "boolean") throw new Error(`Invalid validation policy lock: ${lockPath}`);
  return parsed;
}

export function lockValidationPolicy(policyPath: string, lockPath: string): ValidationPolicyLock {
  const current = readValidationPolicyLock(lockPath);
  const record: ValidationPolicyLock = current?.locked
    ? assertValidationPolicy(policyPath, lockPath)
    : { policyPath, checksum: checksum(policyPath), locked: true, lockedAt: new Date().toISOString() };
  writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function unlockValidationPolicy(policyPath: string, lockPath: string, reason: string): ValidationPolicyLock {
  if (!reason.trim()) throw new Error("Unlocking a validation policy requires a non-empty reason.");
  const current = readValidationPolicyLock(lockPath);
  if (!current) throw new Error("Validation policy is not locked.");
  assertValidationPolicy(policyPath, lockPath);
  const record: ValidationPolicyLock = { ...current, policyPath, locked: false, unlockedAt: new Date().toISOString(), unlockReason: reason.trim() };
  writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function assertValidationPolicy(policyPath: string, lockPath: string): ValidationPolicyLock {
  const lock = readValidationPolicyLock(lockPath);
  if (!lock || !lock.locked) return lock ?? { policyPath, checksum: checksum(policyPath), locked: false, lockedAt: "" };
  const actual = checksum(policyPath);
  if (lock.policyPath !== policyPath || lock.checksum !== actual) {
    throw new Error(`Locked validation policy changed: expected ${lock.checksum}, found ${actual}. Unlock with an explicit reason before changing validation.`);
  }
  return lock;
}
