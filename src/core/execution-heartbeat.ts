import { ResearchStore } from "./store.js";
import type { RemoteExecutionEvent } from "./executors.js";

/** Allocation evidence is mandatory durability, unlike best-effort liveness. */
export function recordRemoteExecution(storePath: string, event: RemoteExecutionEvent): void {
  const store = new ResearchStore(storePath);
  try {
    if (event.executor === "modal" && event.phase === "terminal" && event.protocol === "modal-call-v1" && event.callId !== undefined && event.allocationName !== undefined && event.state !== undefined && event.exitCode !== undefined && event.completionEvidence !== undefined) {
      if (!store.recordModalTerminalEvidence({ ...event, callId: event.callId, allocationName: event.allocationName, state: event.state, exitCode: event.exitCode, completionEvidence: event.completionEvidence })) throw new Error("Modal terminal proof conflicts with recorded evidence.");
    } else if (event.executor === "container" && event.phase === "submitted" && event.runtime !== undefined && event.containerId !== undefined && event.allocationName !== undefined) {
      if (!store.recordContainerReceiptEvidence({ ...event, runtime: event.runtime, containerId: event.containerId, allocationName: event.allocationName })) throw new Error("Container receipt conflicts with recorded evidence.");
    } else if (event.executor === "container" && event.phase === "terminal" && event.runtime !== undefined && event.containerId !== undefined && event.allocationName !== undefined && event.state !== undefined && event.exitCode !== undefined) {
      if (!store.recordContainerTerminalEvidence({ ...event, runtime: event.runtime, containerId: event.containerId, allocationName: event.allocationName, state: event.state, exitCode: event.exitCode })) throw new Error("Container terminal proof conflicts with recorded evidence.");
    } else if (event.executor === "slurm" && event.phase === "terminal" && event.jobId !== undefined && event.allocationName !== undefined && event.state !== undefined && event.exitCode !== undefined) {
      if (!store.recordRemoteTerminalEvidence({ ...event, jobId: event.jobId, allocationName: event.allocationName, state: event.state, exitCode: event.exitCode })) throw new Error("Remote terminal accounting conflicts with recorded evidence.");
    } else store.appendEvent(`run.remote.${event.phase}`, event);
  }
  finally { store.close(); }
}

export interface ExecutionHeartbeatOptions {
  storePath: string;
  experimentId: string;
  attempt?: number;
  stage?: string;
  executor?: string;
  intervalMs?: number;
}

/** Keep durable run-level liveness separate from the controller lease. */
export async function withExecutionHeartbeat<T>(operation: () => Promise<T>, options: ExecutionHeartbeatOptions): Promise<T> {
  const intervalMs = Math.max(250, options.intervalMs ?? 10_000);
  const heartbeat = (): void => {
    try {
      const store = new ResearchStore(options.storePath);
      store.appendEvent("run.heartbeat", {
        experimentId: options.experimentId,
        attempt: options.attempt ?? 1,
        stage: options.stage ?? "execution",
        executor: options.executor ?? "unknown",
        heartbeatAt: new Date().toISOString(),
      });
      store.close();
    } catch {
      // Liveness telemetry must never turn a valid worker result into a failure.
    }
  };
  // Record liveness immediately; waiting for the first interval leaves a
  // restart window in which a healthy short-lived worker looks stale.
  heartbeat();
  const timer = setInterval(heartbeat, intervalMs);
  timer.unref();
  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}
