import type { RunResult } from "./types.js";

export interface RecoveryPlan {
  retry: boolean;
  maxAttempts: number;
  backoffSeconds: number;
  action: string;
  route: "retry" | "reduce_resources" | "refresh_data" | "repair_code" | "change_hypothesis" | "reauthenticate";
}

export interface RecoveryRouteDirective {
  routeKey: string;
  route: RecoveryPlan["route"];
  failureClass: RunResult["failureClass"] | "unknown";
  instruction: string;
  sameManifestRetryExhausted: boolean;
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

/**
 * Convert a terminal executor failure into durable guidance for the next
 * autonomous cycle. Retries are intentionally separate from this directive:
 * once the bounded retry budget is exhausted, the controller must change the
 * route rather than invoke the same immutable manifest again.
 */
export function recoveryRouteDirective(failureClass: RunResult["failureClass"]): RecoveryRouteDirective {
  const normalized = failureClass ?? "unknown";
  const plan = recoveryPlan(failureClass);
  const instruction = plan.route === "reduce_resources"
    ? "Create a lower-resource or split-workload experiment; do not rerun the same resource manifest."
    : plan.route === "refresh_data"
      ? "Audit and repair the data contract, then validate the refreshed inputs before allocating compute."
      : plan.route === "repair_code"
        ? "Create a repair experiment that isolates the dependency or artifact contract before testing the hypothesis again."
        : plan.route === "reauthenticate"
          ? "Repair provider authentication or select an authenticated alternate provider before resuming execution."
          : plan.route === "change_hypothesis"
            ? "Select a materially different hypothesis or formulation and record why the failed route is rejected."
            : "Use a distinct execution route or provider configuration; do not replay the failed route unchanged.";
  return {
    routeKey: `${normalized}:${plan.route}`,
    route: plan.route,
    failureClass: normalized,
    instruction,
    sameManifestRetryExhausted: true,
  };
}
