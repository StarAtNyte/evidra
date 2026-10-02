import { ExperimentManifestSchema, type CompetitionConfig, type ExperimentExecutorKind, type ExperimentManifest } from "./types.js";

export interface ManifestInput {
  id: string;
  hypothesisId: string;
  outcomeType?: "metric" | "artifact" | "proof" | "behavior" | "system" | "other";
  implementationMode?: "modify" | "verify";
  gitCommit: string;
  datasetVersion: string;
  splitVersion?: string;
  configPatch?: Record<string, unknown>;
  executor?: ExperimentExecutorKind;
  image?: string;
  gpu?: string;
  environment?: Record<string, string>;
  earlyStopping?: { enabled: boolean; metric: string; direction: "maximize" | "minimize"; warmupSteps: number; patience: number; minimumImprovement: number; reference: Array<{ step: number; metric: number }> };
  timeoutMinutes?: number;
  folds?: number[];
  seeds?: number[];
  matrixRequired?: boolean;
  requiredArtifacts?: string[];
  verificationCommand?: string[];
  verificationCommands?: string[][];
  minimumPrimaryDelta?: number;
  maximumRegressionShift?: number;
  largeGainThreshold?: number;
  requireReplication?: boolean;
  requireExternalScore?: boolean;
  parent?: string | null;
  parentHypothesisIds?: string[];
  searchOperator?: string;
}

export function createExperimentManifest(input: ManifestInput, competition: CompetitionConfig): ExperimentManifest {
  const verificationCommand = input.verificationCommand?.length
    ? input.verificationCommand
    : competition.execution?.verificationCommand?.length
      ? competition.execution.verificationCommand
      : undefined;
  const verificationCommands = input.verificationCommands?.length
    ? input.verificationCommands
    : competition.execution?.verificationCommands?.length
      ? competition.execution.verificationCommands
      : undefined;
  return ExperimentManifestSchema.parse({
    schemaVersion: 1,
    id: input.id,
    parent: input.parent ?? null,
    parentHypothesisIds: input.parentHypothesisIds ?? [],
    hypothesisId: input.hypothesisId,
    outcomeType: input.outcomeType ?? "metric",
    implementationMode: input.implementationMode ?? "modify",
    gitCommit: input.gitCommit,
    datasetVersion: input.datasetVersion || competition.datasetRevision,
    splitVersion: input.splitVersion ?? `${competition.id}:${competition.datasetRevision}:${competition.validation?.primarySplit ?? "mini"}-v1`,
    change: { configPatch: input.configPatch ?? {} },
    resources: {
      executor: input.executor ?? "local",
      ...(input.image ? { image: input.image } : {}),
      ...(input.gpu ? { gpu: input.gpu } : {}),
      timeoutMinutes: input.timeoutMinutes ?? 30,
      environment: { ...(competition.execution?.environment ?? {}), ...(input.environment ?? {}) },
      ...(input.earlyStopping ? { earlyStopping: input.earlyStopping } : {}),
    },
    evaluation: {
      folds: input.folds ?? [0],
      seeds: input.seeds ?? [0],
      matrixRequired: input.matrixRequired ?? competition.execution?.matrixRequired ?? false,
      requiredArtifacts: input.requiredArtifacts ?? competition.execution?.requiredArtifacts ?? [],
      metrics: [
        { name: competition.metric.name, direction: competition.metric.direction },
        ...(competition.secondaryMetrics ?? []),
      ],
      ...(verificationCommand ? { verificationCommand } : {}),
      ...(verificationCommands ? { verificationCommands } : {}),
    },
    acceptance: {
      minimumPrimaryDelta: input.minimumPrimaryDelta ?? 0,
      maximumRegressionShift: input.maximumRegressionShift ?? 0,
      requireReplication: input.requireReplication ?? true,
      requireExternalScore: input.requireExternalScore ?? false,
      ...(input.largeGainThreshold !== undefined ? { largeGainThreshold: input.largeGainThreshold } : {}),
    },
    searchOperator: input.searchOperator ?? "ucb_portfolio",
    createdAt: new Date().toISOString(),
  });
}

export function manifestSummary(manifest: ExperimentManifest): string {
  return [
    `${manifest.id} · hypothesis ${manifest.hypothesisId}`,
    `commit ${manifest.gitCommit} · data ${manifest.datasetVersion} · split ${manifest.splitVersion}`,
    `executor ${manifest.resources.executor}${manifest.resources.image ? ` (${manifest.resources.image})` : ""} · timeout ${manifest.resources.timeoutMinutes}m`,
    `folds [${manifest.evaluation.folds.join(", ")}] · seeds [${manifest.evaluation.seeds.join(", ")}] · matrix ${manifest.evaluation.matrixRequired ? "required" : "optional"}`,
    `metrics ${manifest.evaluation.metrics.map((metric) => `${metric.name} (${metric.direction})`).join(", ") || "not declared"}`,
    `implementation ${manifest.implementationMode === "verify" ? "verification only · source unchanged" : "change required"}`,
    `replication ${manifest.acceptance.requireReplication ? "required" : "not required"}`,
    `external score ${manifest.acceptance.requireExternalScore ? "required" : "not required"}`,
  ].join("\n");
}

/** Create an independent child manifest without mutating the parent. */
export function createReplicationManifest(parent: ExperimentManifest, competition: CompetitionConfig): ExperimentManifest {
  return createExperimentManifest({
    id: `rep_${Date.now()}_${parent.hypothesisId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 28)}`,
    parent: parent.id,
    parentHypothesisIds: parent.parentHypothesisIds,
    hypothesisId: parent.hypothesisId,
    outcomeType: parent.outcomeType,
    implementationMode: parent.implementationMode,
    gitCommit: parent.gitCommit,
    datasetVersion: parent.datasetVersion,
    splitVersion: parent.splitVersion,
    configPatch: parent.change.configPatch,
    executor: parent.resources.executor,
    image: parent.resources.image,
    gpu: parent.resources.gpu,
    environment: parent.resources.environment,
    timeoutMinutes: parent.resources.timeoutMinutes,
    folds: parent.evaluation.folds,
    seeds: [...parent.evaluation.seeds, Date.now() % 100000],
    matrixRequired: parent.evaluation.matrixRequired,
    requiredArtifacts: parent.evaluation.requiredArtifacts,
    verificationCommand: parent.evaluation.verificationCommand,
    verificationCommands: parent.evaluation.verificationCommands,
    earlyStopping: parent.resources.earlyStopping,
    minimumPrimaryDelta: parent.acceptance.minimumPrimaryDelta,
    maximumRegressionShift: parent.acceptance.maximumRegressionShift,
    requireReplication: false,
    searchOperator: parent.searchOperator,
  }, competition);
}
