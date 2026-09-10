import type { RunResult } from "./types.js";

export interface RecoveryPlan {
  retry: boolean;
  maxAttempts: number;
  backoffSeconds: number;
  action: string;
  route: "retry" | "reduce_resources" | "refresh_data" | "repair_code" | "change_hypothesis" | "reauthenticate";
}

export function recoveryPlan(failureClass: RunResult["failureClass"]): RecoveryPlan {
  switch (failureClass) {
    case "cuda_oom": return { retry: true, maxAttempts: 2, backoffSeconds: 2, action: "retry with the same immutable manifest; then reduce memory pressure", route: "reduce_resources" };
    case "transient_cloud": return { retry: true, maxAttempts: 3, backoffSeconds: 5, action: "retry the unchanged worker", route: "retry" };
    case "timeout": return { retry: true, maxAttempts: 2, backoffSeconds: 2, action: "retry once; then reduce runtime or split the workload", route: "reduce_resources" };
    case "disk": return { retry: true, maxAttempts: 2, backoffSeconds: 2, action: "retry after the worker releases temporary space", route: "refresh_data" };
    case "rate_limit": return { retry: true, maxAttempts: 2, backoffSeconds: 15, action: "retry after provider backoff", route: "retry" };
    case "data_missing": return { retry: false, maxAttempts: 1, backoffSeconds: 0, action: "refresh or repair the data contract before trying another experiment", route: "refresh_data" };
    case "dependency": return { retry: false, maxAttempts: 1, backoffSeconds: 0, action: "repair the dependency or execution environment before trying another experiment", route: "repair_code" };
    case "auth": return { retry: false, maxAttempts: 1, backoffSeconds: 0, action: "reauthenticate the provider before trying another experiment", route: "reauthenticate" };
    case "corrupt_artifact": return { retry: false, maxAttempts: 1, backoffSeconds: 0, action: "repair the artifact contract and rerun independently", route: "repair_code" };
    case "nan_loss":
    case "code_regression":
    case "invalid_metric": return { retry: false, maxAttempts: 1, backoffSeconds: 0, action: "reject the approach and choose a different hypothesis", route: "change_hypothesis" };
    default: return { retry: false, maxAttempts: 1, backoffSeconds: 0, action: "preserve the failed run and choose a different hypothesis or repair experiment", route: "change_hypothesis" };
  }
}

export function recoveryDelay(plan: RecoveryPlan, attempt: number): number {
  return plan.backoffSeconds * Math.max(1, 2 ** Math.max(0, attempt - 1));
}
