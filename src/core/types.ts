import { z } from "zod";

export const CompetitionConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  taskType: z.string(),
  datasetRevision: z.string(),
  metric: z.object({
    name: z.string(),
    direction: z.enum(["minimize", "maximize"]),
  }),
  /** Optional non-primary objectives; promotion can require they do not regress. */
  secondaryMetrics: z.array(z.object({
    name: z.string().min(1),
    direction: z.enum(["minimize", "maximize"]),
    minimumDelta: z.number().nonnegative().default(0),
    maximumRegression: z.number().nonnegative().default(0),
  })).default([]),
  evaluator: z.object({
    command: z.array(z.string()),
    estimatorPath: z.string(),
  }),
  workspacePath: z.string().optional(),
  baselineCommand: z.array(z.string()).optional(),
  experimentCommand: z.array(z.string()).optional(),
  researchSources: z.array(z.string().url()).default([]),
  evaluatorTimeoutMinutes: z.number().positive().default(60),
  submission: z.object({
    platform: z.enum(["manual", "kaggle", "command", "http"]).default("manual"),
    source: z.enum(["prediction", "workspace"]).default("prediction"),
    competition: z.string().optional(),
    predictionFile: z.string().optional(),
    workingDirectory: z.string().optional(),
    submitCommand: z.array(z.string()).optional(),
    scoreCommand: z.array(z.string()).optional(),
    submitUrl: z.string().url().optional(),
    scoreUrl: z.string().url().optional(),
    /** Name of an environment variable holding the bearer token; never store the token itself. */
    authEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    fileField: z.string().min(1).max(80).default("file").optional(),
  }).optional(),
  submissionPolicy: z.object({
    requireHumanApproval: z.boolean().default(true),
    minimumInformationValue: z.number().nonnegative().default(0),
    minimumLocalConfidence: z.number().min(0).max(1).default(0),
    rejectIfLeakageFlagged: z.boolean().default(true),
    reserveForFinalEnsemble: z.number().int().nonnegative().default(0),
    minimumHoursBetweenSubmissions: z.number().nonnegative().default(0),
    totalLimit: z.number().int().positive().optional(),
    dailyLimit: z.number().int().positive().optional(),
  }).optional(),
  execution: z.object({
    matrixRequired: z.boolean().default(false),
    smokeCommand: z.array(z.string()).min(1).optional(),
    reducedValidationCommand: z.array(z.string()).min(1).optional(),
    reducedPromotion: z.object({
      enabled: z.boolean().default(false),
      minimumDelta: z.number().default(0),
      tolerance: z.number().nonnegative().default(0),
    }).optional(),
    verificationCommand: z.array(z.string()).min(1).optional(),
    verificationCommands: z.array(z.array(z.string()).min(1)).min(1).optional(),
    requiredArtifacts: z.array(z.string()).default([]),
  }).optional(),
  validation: z.object({
    primarySplit: z.string().min(1).default("mini"),
    folds: z.array(z.number().int().nonnegative()).min(1).default([0]),
    seeds: z.array(z.number().int()).min(1).default([0, 1, 2]),
    secondarySplits: z.array(z.string().min(1)).default([]),
  }).optional(),
}).superRefine((config, context) => {
  const names = new Set([config.metric.name]);
  for (const [index, objective] of config.secondaryMetrics.entries()) {
    if (names.has(objective.name)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["secondaryMetrics", index, "name"], message: "metric objective names must be unique and cannot duplicate the primary metric" });
    names.add(objective.name);
  }
});

export type CompetitionConfig = z.infer<typeof CompetitionConfigSchema>;

export const HypothesisSchema = z.object({
  id: z.string(),
  title: z.string(),
  mechanism: z.string(),
  falsificationTest: z.string(),
  expectedDelta: z.number(),
  status: z.enum(["proposed", "testing", "supported", "rejected", "inconclusive"]),
});

export type Hypothesis = z.infer<typeof HypothesisSchema>;

export const ResearchHypothesisSchema = z.object({
  title: z.string().min(1),
  formulationFamily: z.string().min(1).max(80).default("unspecified"),
  outcomeType: z.enum(["metric", "artifact", "proof", "behavior", "system", "other"]).default("metric"),
  expectedOutcome: z.string().min(1).optional(),
  mechanism: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  /** Durable source IDs supporting the literature-derived evidence above. */
  evidenceSourceIds: z.array(z.string().min(1)).max(8).default([]),
  /** Exact durable hypothesis IDs used as parents for an evolutionary offspring. */
  parentHypothesisIds: z.array(z.string().min(1)).max(2).default([]),
  /** Context required when a hypothesis adapts a literature-derived method. */
  sourceAdaptation: z.object({
    sourceTitle: z.string().min(1).max(300),
    section: z.string().min(1).max(300).optional(),
    repository: z.string().url().optional(),
    originalSetting: z.string().min(1).max(1_000),
    competitionDifference: z.string().min(1).max(1_000),
    expectedFailureModes: z.array(z.string().min(1).max(300)).min(1).max(8),
  }).optional(),
  proposedChange: z.string().min(1),
  falsificationTest: z.string().min(1),
  expectedMetricDelta: z.object({ low: z.number(), median: z.number(), high: z.number() }).default({ low: 0, median: 0, high: 0 }).superRefine((forecast, context) => {
    if (forecast.low > forecast.median) context.addIssue({ code: z.ZodIssueCode.custom, path: ["low"], message: "must be less than or equal to median" });
    if (forecast.median > forecast.high) context.addIssue({ code: z.ZodIssueCode.custom, path: ["high"], message: "must be greater than or equal to median" });
  }),
  computeCostGpuHours: z.number().nonnegative().default(0),
  implementationRisk: z.enum(["low", "medium", "high"]).default("medium"),
  leakageRisk: z.enum(["low", "medium", "high"]).default("low"),
  dependencies: z.array(z.string()).default([]),
  ablationFactors: z.array(z.object({
    id: z.string().min(1).max(80),
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,80}$/),
    label: z.string().min(1).max(160),
    disabledValue: z.unknown(),
  })).max(8).default([]),
}).superRefine((hypothesis, context) => {
  if (hypothesis.sourceAdaptation && hypothesis.evidenceSourceIds.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceSourceIds"],
      message: "sourceAdaptation requires at least one durable evidenceSourceId",
    });
  }
});

export const ResearchDecisionSchema = z.object({
  phase: z.enum(["orientation", "baseline", "data_audit", "validation", "hypothesis", "implementation", "evaluation", "replication", "promotion"]).default("hypothesis"),
  goalStatus: z.enum(["active", "blocked", "met"]).default("active"),
  decision: z.enum(["inspect", "propose", "run", "replicate", "stop"]),
  bottleneck: z.string().min(1),
  rationale: z.string().min(1),
  hypotheses: z.array(ResearchHypothesisSchema).max(5),
  searchOperator: z.enum(["greedy", "ucb_portfolio", "evolutionary", "mcts", "ablation", "combination", "replication", "audit"]).default("ucb_portfolio"),
  selectedHypothesis: z.string().nullable(),
  nextAction: z.string().min(1),
  toolCalls: z.array(z.object({
    name: z.string().min(1),
    arguments: z.record(z.unknown()).default({}),
  })).max(8).default([]),
});

export type ResearchDecision = z.infer<typeof ResearchDecisionSchema>;

export const ResearchPhaseSchema = z.enum(["orientation", "baseline", "data_audit", "validation", "hypothesis", "implementation", "evaluation", "replication", "promotion"]);
export type ResearchPhase = z.infer<typeof ResearchPhaseSchema>;

export const PhaseGoalSchema = z.object({
  id: z.string().min(1),
  phase: ResearchPhaseSchema,
  title: z.string().min(1),
  objective: z.string().min(1),
  completionCriteria: z.array(z.string().min(1)).min(1),
  status: z.enum(["pending", "active", "blocked", "met"]).default("pending"),
  evidenceIds: z.array(z.string()).default([]),
  attempts: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PhaseGoal = z.infer<typeof PhaseGoalSchema>;

export const ResearchEdgeSchema = z.object({
  id: z.string().min(1),
  fromId: z.string().min(1),
  toId: z.string().min(1),
  relation: z.enum(["supports", "contradicts", "depends_on", "replicates", "supersedes", "derived_from", "invalidated_by", "diverse_from"]),
  confidence: z.number().min(0).max(1).default(0.5),
  evidenceIds: z.array(z.string()).default([]),
});

export type ResearchEdge = z.infer<typeof ResearchEdgeSchema>;

export const EvidenceClaimSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  scope: z.string().min(1),
  confidence: z.number().min(0).max(1),
  sourceType: z.enum(["observation", "run", "review", "literature", "external_score"]),
  sourceId: z.string().min(1),
  status: z.enum(["active", "superseded", "invalidated"]).default("active"),
});

export type EvidenceClaim = z.infer<typeof EvidenceClaimSchema>;

export const ResearchSourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url(),
  retrievedAt: z.string().datetime(),
  contentHash: z.string().min(1),
  license: z.string().optional(),
  evidenceClass: z.enum(["scholarly", "official", "implementation", "discovery"]).optional(),
  qualityScore: z.number().min(0).max(1).optional(),
  claims: z.array(z.string()).default([]),
});

export type ResearchSource = z.infer<typeof ResearchSourceSchema>;

export const PriorityInputSchema = z.object({
  probabilityOfSuccess: z.number().min(0).max(1),
  expectedDelta: z.number(),
  informationValue: z.number().nonnegative(),
  diversityValue: z.number().nonnegative(),
  gpuCost: z.number().nonnegative(),
  llmCost: z.number().nonnegative(),
  engineeringCost: z.number().nonnegative(),
  risk: z.number().nonnegative(),
});

export type PriorityInput = z.infer<typeof PriorityInputSchema>;

export const ExperimentSchema = z.object({
  id: z.string(),
  hypothesisId: z.string(),
  parentCommit: z.string(),
  worktreePath: z.string(),
  command: z.array(z.string()),
  status: z.enum(["proposed", "scheduled", "running", "completed", "failed", "invalid"]),
});

export type Experiment = z.infer<typeof ExperimentSchema>;

export const ExperimentManifestSchema = z.object({
  schemaVersion: z.number().int().positive().default(1),
  id: z.string().min(1),
  parent: z.string().nullable().default(null),
  parentHypothesisIds: z.array(z.string().min(1)).max(2).default([]),
  hypothesisId: z.string().min(1),
  outcomeType: z.enum(["metric", "artifact", "proof", "behavior", "system", "other"]).default("metric"),
  gitCommit: z.string().min(1),
  datasetVersion: z.string().min(1),
  splitVersion: z.string().min(1),
  change: z.object({ configPatch: z.record(z.string(), z.unknown()) }),
  resources: z.object({ executor: z.enum(["local", "container", "modal"]), image: z.string().min(1).optional(), gpu: z.string().optional(), timeoutMinutes: z.number().positive(), earlyStopping: z.object({ enabled: z.boolean(), metric: z.string().min(1), direction: z.enum(["maximize", "minimize"]), warmupSteps: z.number().int().nonnegative(), patience: z.number().int().positive(), minimumImprovement: z.number().nonnegative(), reference: z.array(z.object({ step: z.number().finite(), metric: z.number().finite() })).default([]) }).optional() }),
  evaluation: z.object({ folds: z.array(z.number().int().nonnegative()), seeds: z.array(z.number().int()), requiredArtifacts: z.array(z.string()), matrixRequired: z.boolean().default(false), metrics: z.array(z.object({ name: z.string().min(1), direction: z.enum(["minimize", "maximize"]), minimumDelta: z.number().nonnegative().default(0), maximumRegression: z.number().nonnegative().default(0) })).default([]), verificationCommand: z.array(z.string()).min(1).optional(), verificationCommands: z.array(z.array(z.string()).min(1)).min(1).optional() }).superRefine((evaluation, context) => {
    const metricNames = new Set<string>();
    for (const [index, metric] of evaluation.metrics.entries()) {
      if (metricNames.has(metric.name)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["metrics", index, "name"], message: "metric objective names must be unique" });
      metricNames.add(metric.name);
    }
    const commands = [
      ...(evaluation.verificationCommand ? [evaluation.verificationCommand] : []),
      ...(evaluation.verificationCommands ?? []),
    ];
    const seen = new Set<string>();
    for (const command of commands) {
      const key = JSON.stringify(command);
      if (seen.has(key)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["verificationCommands"], message: "verification commands must be exact-unique; duplicate commands are not independent evidence" });
      }
      seen.add(key);
    }
  }),
  acceptance: z.object({ minimumPrimaryDelta: z.number(), maximumRegressionShift: z.number(), requireReplication: z.boolean(), largeGainThreshold: z.number().positive().optional() }),
  searchOperator: z.string().min(1).default("ucb_portfolio"),
  createdAt: z.string().datetime(),
});

export type ExperimentManifest = z.infer<typeof ExperimentManifestSchema>;

export const RunResultSchema = z.object({
  runId: z.string(),
  status: z.enum(["completed", "failed", "orphaned", "cancelled"]),
  exitCode: z.number().int(),
  durationSeconds: z.number().nonnegative(),
  metrics: z.record(z.string(), z.number().finite()).default({}),
  metricsByFold: z.record(z.string(), z.array(z.number().finite())).default({}),
  learningCurve: z.array(z.object({ step: z.number().finite(), metric: z.number().finite() })).optional(),
  subgroupDeltas: z.array(z.number().finite()).default([]),
  matrix: z.array(z.object({ fold: z.number().int().nonnegative(), seed: z.number().int(), metrics: z.record(z.string(), z.number().finite()) })).optional(),
  artifacts: z.record(z.string(), z.string()).default({}),
  verification: z.object({ declared: z.number().int().nonnegative(), executed: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), independent: z.boolean(), formalDeclared: z.number().int().nonnegative().optional(), formalPassed: z.number().int().nonnegative().optional(), details: z.array(z.object({ kind: z.string(), evidence: z.string(), summary: z.string(), semanticMarker: z.string().optional() })).optional() }).superRefine((verification, context) => {
    if (verification.executed > verification.declared) context.addIssue({ code: z.ZodIssueCode.custom, path: ["executed"], message: "executed verifiers cannot exceed declared verifiers" });
    if (verification.passed + verification.failed !== verification.executed) context.addIssue({ code: z.ZodIssueCode.custom, path: ["passed"], message: "passed plus failed verifiers must equal executed verifiers" });
    if (verification.declared < 2 && verification.independent) context.addIssue({ code: z.ZodIssueCode.custom, path: ["independent"], message: "independent verification requires at least two declared verifiers" });
  }).optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  command: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  failureClass: z.enum(["cuda_oom", "transient_cloud", "data_missing", "nan_loss", "dependency", "timeout", "early_stopped", "corrupt_artifact", "invalid_metric", "code_regression", "auth", "rate_limit", "disk", "sandbox", "unknown"]).optional(),
});

export type RunResult = z.infer<typeof RunResultSchema>;

export const EvidenceGateSchema = z.object({
  validCommit: z.boolean(),
  datasetMatch: z.boolean(),
  splitMatch: z.boolean(),
  outputsComplete: z.boolean(),
  predictionsValid: z.boolean(),
  metricsRecomputed: z.boolean(),
  leakageAuditPassed: z.boolean(),
  reviewerApproved: z.boolean(),
  verifiersPassed: z.boolean().default(true),
  evaluationCoverage: z.boolean().default(true),
});

export type EvidenceGate = z.infer<typeof EvidenceGateSchema>;

export interface AgentTask {
  role: string;
  objective: string;
  context: Record<string, unknown>;
  outputSchema?: string;
}

export interface AgentResult {
  provider: string;
  model?: string;
  threadId?: string;
  output: unknown;
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; reasoningOutputTokens?: number };
}

export interface ResearchAgent {
  run(task: AgentTask): Promise<AgentResult>;
}

export interface ExperimentExecutor {
  run(experiment: Experiment): Promise<{
    status: "completed" | "failed";
    exitCode: number;
    durationMs: number;
    artifacts: string[];
  }>;
}

export interface ProcessResult {
  command: string[];
  cwd: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}
