export interface MlflowRunExport {
  runId: string;
  experimentId: string;
  status: "FINISHED" | "FAILED" | "KILLED";
  startTimeMs: number;
  endTimeMs: number;
  params: Record<string, string>;
  metrics: Record<string, number>;
  tags: Record<string, string>;
  artifacts: Array<{ name: string; path: string; checksum: string }>;
}

type RunRecord = { id: string; experimentId: string; status: string; payload: unknown; createdAt?: string; updatedAt?: string };
type ExperimentRecord = { id: string; payload: unknown };
type ArtifactRecord = { runId: string; name: string; path: string; checksum: string };

function finiteMetrics(payload: Record<string, unknown>): Record<string, number> {
  const metrics = payload.metrics;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return {};
  return Object.fromEntries(Object.entries(metrics as Record<string, unknown>).filter(([, value]) => typeof value === "number" && Number.isFinite(value)) as Array<[string, number]>);
}

function scalarParams(payload: Record<string, unknown>, experiment: Record<string, unknown>): Record<string, string> {
  const resources = experiment.resources && typeof experiment.resources === "object" ? experiment.resources as Record<string, unknown> : {};
  const fields: Record<string, unknown> = {
    datasetVersion: experiment.datasetVersion,
    splitVersion: experiment.splitVersion,
    hypothesisId: experiment.hypothesisId,
    executor: resources.executor,
    model: payload.model,
    seed: payload.seed,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value)).map(([key, value]) => [key, String(value)]));
}

function timestamp(value: string | undefined, fallback: number): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Convert Evidra’s durable run ledger into a secret-free MLflow-shaped export. */
export function buildMlflowRunExports(runs: RunRecord[], experiments: ExperimentRecord[], artifacts: ArtifactRecord[], projectName = "evidra"): MlflowRunExport[] {
  const now = Date.now();
  const experimentById = new Map(experiments.map((experiment) => [experiment.id, experiment]));
  return runs.map((run) => {
    const payload = run.payload && typeof run.payload === "object" && !Array.isArray(run.payload) ? run.payload as Record<string, unknown> : {};
    const rawExperiment = experimentById.get(run.experimentId)?.payload;
    const experiment = rawExperiment && typeof rawExperiment === "object" && !Array.isArray(rawExperiment) ? rawExperiment as Record<string, unknown> : {};
    const endTimeMs = timestamp(run.updatedAt, now);
    const durationMs = typeof payload.durationSeconds === "number" && Number.isFinite(payload.durationSeconds) ? Math.max(0, payload.durationSeconds * 1_000) : 0;
    const startTimeMs = Math.min(endTimeMs, timestamp(run.createdAt, endTimeMs - durationMs));
    const status = run.status === "completed" ? "FINISHED" : run.status === "cancelled" || run.status === "orphaned" ? "KILLED" : "FAILED";
    const failureClass = typeof payload.failureClass === "string" ? payload.failureClass : undefined;
    return {
      runId: run.id,
      experimentId: run.experimentId,
      status,
      startTimeMs,
      endTimeMs,
      params: scalarParams(payload, experiment),
      metrics: finiteMetrics(payload),
      tags: { "evidra.project": projectName, "evidra.run_status": run.status, ...(failureClass ? { "evidra.failure_class": failureClass } : {}) },
      artifacts: artifacts.filter((artifact) => artifact.runId === run.id).map(({ name, path, checksum }) => ({ name, path, checksum })),
    } satisfies MlflowRunExport;
  });
}
