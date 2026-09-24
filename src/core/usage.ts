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

export interface AgentUsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningOutputTokens: number;
}

export interface AgentUsageBucket extends AgentUsageSummary {
  role: string;
  provider: string;
  model: string;
}

function usageNumber(payload: Record<string, unknown>, key: string): number {
  return typeof payload[key] === "number" && Number.isFinite(payload[key]) && (payload[key] as number) >= 0 ? payload[key] as number : 0;
}

/** Keep provider/model/role attribution instead of collapsing all agent cost into one total. */
export function summarizeAgentUsageBy(events: Array<{ payload: unknown }>): AgentUsageBucket[] {
  const buckets = new Map<string, AgentUsageBucket>();
  for (const event of events) {
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
    const role = typeof payload.role === "string" && payload.role.trim() ? payload.role.trim() : "unknown";
    const provider = typeof payload.provider === "string" && payload.provider.trim() ? payload.provider.trim() : "unknown";
    const model = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : "unknown";
    const key = `${role}\u0000${provider}\u0000${model}`;
    const bucket = buckets.get(key) ?? { role, provider, model, calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 };
    bucket.calls += 1;
    bucket.inputTokens += usageNumber(payload, "inputTokens");
    bucket.outputTokens += usageNumber(payload, "outputTokens");
    bucket.cachedInputTokens += usageNumber(payload, "cachedInputTokens");
    bucket.cacheWriteInputTokens += usageNumber(payload, "cacheWriteInputTokens");
    bucket.reasoningOutputTokens += usageNumber(payload, "reasoningOutputTokens");
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((left, right) => (right.inputTokens + right.outputTokens) - (left.inputTokens + left.outputTokens) || left.role.localeCompare(right.role));
}

/** Aggregate provider usage events consistently across CLI, TUI, and reports. */
export function summarizeAgentUsage(events: Array<{ payload: unknown }>): AgentUsageSummary {
  return summarizeAgentUsageBy(events).reduce<AgentUsageSummary>((total, bucket) => ({
    calls: total.calls + bucket.calls,
    inputTokens: total.inputTokens + bucket.inputTokens,
    outputTokens: total.outputTokens + bucket.outputTokens,
    cachedInputTokens: total.cachedInputTokens + bucket.cachedInputTokens,
    cacheWriteInputTokens: total.cacheWriteInputTokens + bucket.cacheWriteInputTokens,
    reasoningOutputTokens: total.reasoningOutputTokens + bucket.reasoningOutputTokens,
  }), { calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 });
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
