import { ResearchStore } from "./store.js";

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
