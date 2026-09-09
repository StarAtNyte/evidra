import type { RunResult } from "./types.js";

export interface RecoveryPlan {
  retry: boolean;
  maxAttempts: number;
  backoffSeconds: number;
  action: string;
}

export function recoveryPlan(failureClass: RunResult["failureClass"]): RecoveryPlan {
  switch (failureClass) {
    case "cuda_oom": return { retry: true, maxAttempts: 2, backoffSeconds: 2, action: "retry with the same immutable manifest; a future repair experiment may reduce memory" };
    case "transient_cloud": return { retry: true, maxAttempts: 3, backoffSeconds: 5, action: "retry the unchanged worker" };
    case "timeout": return { retry: true, maxAttempts: 2, backoffSeconds: 2, action: "retry once before diagnosing the timeout" };
    case "disk": return { retry: true, maxAttempts: 2, backoffSeconds: 2, action: "retry after the worker releases temporary space" };
    case "rate_limit": return { retry: true, maxAttempts: 2, backoffSeconds: 15, action: "retry after provider backoff" };
    default: return { retry: false, maxAttempts: 1, backoffSeconds: 0, action: "preserve the failed run and create a child repair experiment" };
  }
}

export function recoveryDelay(plan: RecoveryPlan, attempt: number): number {
  return plan.backoffSeconds * Math.max(1, 2 ** Math.max(0, attempt - 1));
}
