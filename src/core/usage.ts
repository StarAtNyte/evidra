export interface UsageRun {
  status: string;
  experimentId: string;
  payload: unknown;
}

export interface UsageExperiment {
  id: string;
  payload: unknown;
}

export interface UsageSummary {
  runs: number;
  completedRuns: number;
  failedRuns: number;
  wallMinutes: number;
  gpuWallHours: number;
  byExecutor: Record<string, { runs: number; wallMinutes: number; gpuWallHours: number }>;
}

/** Aggregate durable run provenance without pretending wall time equals billed cost. */
export function summarizeUsage(runs: UsageRun[], experiments: UsageExperiment[]): UsageSummary {
  const byId = new Map(experiments.map((experiment) => [experiment.id, experiment]));
  const summary: UsageSummary = { runs: 0, completedRuns: 0, failedRuns: 0, wallMinutes: 0, gpuWallHours: 0, byExecutor: {} };
  for (const run of runs) {
    const payload = run.payload as { durationSeconds?: unknown };
    const seconds = typeof payload.durationSeconds === "number" && Number.isFinite(payload.durationSeconds) && payload.durationSeconds >= 0 ? payload.durationSeconds : 0;
    const minutes = seconds / 60;
    const experimentPayload = byId.get(run.experimentId)?.payload as { resources?: { executor?: unknown; gpu?: unknown } } | undefined;
    const executor = typeof experimentPayload?.resources?.executor === "string" ? experimentPayload.resources.executor : "unknown";
    const gpu = Boolean(experimentPayload?.resources?.gpu);
    const gpuHours = gpu ? seconds / 3_600 : 0;
    summary.runs += 1;
    if (run.status === "completed") summary.completedRuns += 1;
    if (run.status === "failed") summary.failedRuns += 1;
    summary.wallMinutes += minutes;
    summary.gpuWallHours += gpuHours;
    const bucket = summary.byExecutor[executor] ?? { runs: 0, wallMinutes: 0, gpuWallHours: 0 };
    bucket.runs += 1;
    bucket.wallMinutes += minutes;
    bucket.gpuWallHours += gpuHours;
    summary.byExecutor[executor] = bucket;
  }
  return summary;
}
