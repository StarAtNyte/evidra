import type { CompetitionConfig } from "./types.js";

export interface SubmissionPolicyInput {
  now?: Date;
  submittedAt: string[];
  informationValue?: number;
  localConfidence?: number;
  leakageFlagged?: boolean;
  isFinalEnsemble?: boolean;
}

export interface SubmissionPolicyDecision {
  allowed: boolean;
  reasons: string[];
  submittedCount: number;
  submittedToday: number;
  latestSubmittedAt?: string;
}

/** Enforce platform submission budgets before an adapter can make an external call. */
export function evaluateSubmissionPolicy(
  policy: NonNullable<CompetitionConfig["submissionPolicy"]> | undefined,
  input: SubmissionPolicyInput,
): SubmissionPolicyDecision {
  const now = input.now ?? new Date();
  const submitted = input.submittedAt
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((entry) => Number.isFinite(entry.time) && entry.time <= now.getTime())
    .sort((left, right) => right.time - left.time);
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const submittedToday = submitted.filter((entry) => entry.time >= dayStart.getTime()).length;
  const reasons: string[] = [];

  if (policy?.totalLimit !== undefined && submitted.length >= policy.totalLimit) reasons.push(`submission limit reached (${policy.totalLimit})`);
  if (policy?.dailyLimit !== undefined && submittedToday >= policy.dailyLimit) reasons.push(`daily submission limit reached (${policy.dailyLimit})`);
  const latest = submitted[0];
  if (latest && policy && policy.minimumHoursBetweenSubmissions > 0) {
    const elapsedHours = (now.getTime() - latest.time) / 3_600_000;
    if (elapsedHours < policy.minimumHoursBetweenSubmissions) reasons.push(`minimum spacing is ${policy.minimumHoursBetweenSubmissions}h (only ${elapsedHours.toFixed(2)}h elapsed)`);
  }
  if (policy && policy.reserveForFinalEnsemble > 0 && policy.totalLimit !== undefined && !input.isFinalEnsemble) {
    const remaining = policy.totalLimit - submitted.length;
    if (remaining <= policy.reserveForFinalEnsemble) reasons.push(`${policy.reserveForFinalEnsemble} submission slot(s) are reserved for the final ensemble`);
  }
  if (policy && input.informationValue === undefined && policy.minimumInformationValue > 0) reasons.push(`information value is required (minimum ${policy.minimumInformationValue})`);
  else if (policy && (input.informationValue ?? 0) < policy.minimumInformationValue) reasons.push(`information value ${input.informationValue ?? 0} is below minimum ${policy.minimumInformationValue}`);
  if (policy && input.localConfidence === undefined && policy.minimumLocalConfidence > 0) reasons.push(`local confidence is required (minimum ${policy.minimumLocalConfidence})`);
  else if (policy && (input.localConfidence ?? 0) < policy.minimumLocalConfidence) reasons.push(`local confidence ${input.localConfidence ?? 0} is below minimum ${policy.minimumLocalConfidence}`);
  if (policy?.rejectIfLeakageFlagged && input.leakageFlagged) reasons.push("leakage is flagged");

  return { allowed: reasons.length === 0, reasons, submittedCount: submitted.length, submittedToday, latestSubmittedAt: latest?.value };
}
