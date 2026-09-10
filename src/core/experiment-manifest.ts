import { ExperimentManifestSchema, type CompetitionConfig, type ExperimentManifest } from "./types.js";

export interface ManifestInput {
  id: string;
  hypothesisId: string;
  gitCommit: string;
  datasetVersion: string;
  splitVersion?: string;
  configPatch?: Record<string, unknown>;
  executor?: "local" | "modal";
  gpu?: string;
  timeoutMinutes?: number;
  folds?: number[];
  seeds?: number[];
  requiredArtifacts?: string[];
  minimumPrimaryDelta?: number;
  maximumRegressionShift?: number;
  requireReplication?: boolean;
  parent?: string | null;
}

export function createExperimentManifest(input: ManifestInput, competition: CompetitionConfig): ExperimentManifest {
  return ExperimentManifestSchema.parse({
    schemaVersion: 1,
    id: input.id,
    parent: input.parent ?? null,
    hypothesisId: input.hypothesisId,
    gitCommit: input.gitCommit,
    datasetVersion: input.datasetVersion || competition.datasetRevision,
    splitVersion: input.splitVersion ?? `${competition.id}:${competition.datasetRevision}:${competition.validation?.primarySplit ?? "mini"}-v1`,
    change: { configPatch: input.configPatch ?? {} },
    resources: {
      executor: input.executor ?? "local",
      ...(input.gpu ? { gpu: input.gpu } : {}),
      timeoutMinutes: input.timeoutMinutes ?? 30,
    },
    evaluation: {
      folds: input.folds ?? [0],
      seeds: input.seeds ?? [0],
      requiredArtifacts: input.requiredArtifacts ?? competition.execution?.requiredArtifacts ?? [],
    },
    acceptance: {
      minimumPrimaryDelta: input.minimumPrimaryDelta ?? 0,
      maximumRegressionShift: input.maximumRegressionShift ?? 0,
      requireReplication: input.requireReplication ?? true,
    },
    createdAt: new Date().toISOString(),
  });
}

export function manifestSummary(manifest: ExperimentManifest): string {
  return [
    `${manifest.id} · hypothesis ${manifest.hypothesisId}`,
    `commit ${manifest.gitCommit} · data ${manifest.datasetVersion} · split ${manifest.splitVersion}`,
    `executor ${manifest.resources.executor} · timeout ${manifest.resources.timeoutMinutes}m`,
    `folds [${manifest.evaluation.folds.join(", ")}] · seeds [${manifest.evaluation.seeds.join(", ")}]`,
    `replication ${manifest.acceptance.requireReplication ? "required" : "not required"}`,
  ].join("\n");
}

/** Create an independent child manifest without mutating the parent. */
export function createReplicationManifest(parent: ExperimentManifest, competition: CompetitionConfig): ExperimentManifest {
  return createExperimentManifest({
    id: `rep_${Date.now()}_${parent.hypothesisId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 28)}`,
    parent: parent.id,
    hypothesisId: parent.hypothesisId,
    gitCommit: parent.gitCommit,
    datasetVersion: parent.datasetVersion,
    splitVersion: parent.splitVersion,
    configPatch: parent.change.configPatch,
    executor: parent.resources.executor,
    gpu: parent.resources.gpu,
    timeoutMinutes: parent.resources.timeoutMinutes,
    folds: parent.evaluation.folds,
    seeds: [...parent.evaluation.seeds, Date.now() % 100000],
    requiredArtifacts: parent.evaluation.requiredArtifacts,
    minimumPrimaryDelta: parent.acceptance.minimumPrimaryDelta,
    maximumRegressionShift: parent.acceptance.maximumRegressionShift,
    requireReplication: false,
  }, competition);
}
