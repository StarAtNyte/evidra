export type QueueFailureClass = "timeout" | "auth" | "dependency" | "sandbox" | "data" | "resource" | "transient" | "unknown";
export type QueueRecoveryRoute = "retry" | "reauthenticate" | "repair" | "alternate_executor" | "refresh_data" | "reduce_resources" | "change_route";

export interface QueueRecoveryAction {
  failureClass: QueueFailureClass;
  route: QueueRecoveryRoute;
  action: string;
  mustChangeRoute: boolean;
}

/** Classify exhausted queue failures into a route-changing next action. */
export function queueRecoveryAction(error: unknown): QueueRecoveryAction {
  const text = String(error instanceof Error ? error.message : error).toLowerCase();
  if (/auth|unauthor|not logged|credential|token|permission denied/.test(text)) return { failureClass: "auth", route: "reauthenticate", action: "repair authentication or select an authenticated provider", mustChangeRoute: true };
  if (/sandbox|bwrap|namespace|operation not permitted/.test(text)) return { failureClass: "sandbox", route: "alternate_executor", action: "repair the sandbox or select a verified alternate executor", mustChangeRoute: true };
  if (/dependency|module not found|no such file|executable not found|command not found/.test(text)) return { failureClass: "dependency", route: "repair", action: "repair the dependency or execution environment before retrying", mustChangeRoute: true };
  if (/data|dataset|file missing|not found|artifact/.test(text)) return { failureClass: "data", route: "refresh_data", action: "audit and refresh the data or artifact contract", mustChangeRoute: true };
  if (/oom|out of memory|memory|disk|resource|capacity/.test(text)) return { failureClass: "resource", route: "reduce_resources", action: "reduce resource pressure or split the workload", mustChangeRoute: true };
  if (/timeout|timed out|deadline/.test(text)) return { failureClass: "timeout", route: "reduce_resources", action: "reduce runtime or split the workload before retrying", mustChangeRoute: true };
  if (/network|connection|temporar|503|502|504|rate limit|overloaded/.test(text)) return { failureClass: "transient", route: "retry", action: "retry after backoff, then change route if the failure persists", mustChangeRoute: false };
  return { failureClass: "unknown", route: "change_route", action: "inspect the failure and choose a materially different route", mustChangeRoute: true };
}
