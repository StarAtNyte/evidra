#!/usr/bin/env node
import { Command } from "commander";
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ResearchStore } from "./core/store.js";
import { materializeResearchDecision } from "./core/research-graph.js";
import { createExperimentManifest, createReplicationManifest, manifestSummary } from "./core/experiment-manifest.js";
import { activePhaseGoal, definePhaseGoals, evaluatePhaseGoalEvidence, phaseGoalsForMode } from "./core/phase-goals.js";
import { ExperimentManifestSchema, PhaseGoalSchema, RunResultSchema } from "./core/types.js";
import { loadCompetitionAdapter } from "./competitions/adapters.js";
import { auditData, dataAuditFingerprint } from "./core/data-audit.js";
import { createValidationPolicy, writeValidationPolicy } from "./core/validation-policy.js";
import { estimateDistributionBeliefs, type ExternalValidationObservation } from "./core/distribution-beliefs.js";
import { advanceExecutionStage, createExecutionPlan, validateExecutionContract, type ExecutionStage } from "./core/execution-stages.js";
import { retrieveSource, searchResearchSources, sourceClaims, sourceFrontier, sourceSearchText, sourceIsFresh } from "./core/sources.js";
import { prepareSubmission, validateSubmissionBundle } from "./core/submissions.js";
import { pollSubmissionScore, submitApprovedBundle } from "./core/submission-adapters.js";
import { evaluateSubmissionPolicy } from "./core/submission-policy.js";
import { renderTimeline } from "./core/timeline.js";
import { latestSourcePayloads, researchMemoryContext } from "./core/research-context.js";
import { detectStagnation } from "./core/stagnation.js";
import { recoveryDelay, recoveryPlan, recoveryRouteDirective } from "./core/recovery.js";
import { campaignElapsedMinutes, pauseCampaign, readCampaignRuntime, resumeCampaign, type CampaignRuntimeConfig } from "./core/campaign.js";
import { runReducedValidation } from "./core/stage-executor.js";
import { auditExperiment } from "./core/validation.js";
import { comparisonFamilySize, evaluateValidationAcceptance } from "./core/validation-engine.js";
import { renderReport, writeReport, type ReportKind } from "./core/reports.js";
import { runProcess } from "./core/process.js";
import { executeResearchTool } from "./core/tools.js";
import { executorFor, parseMetricOutput, validateRunMetric } from "./core/executors.js";
import { sha256File } from "./core/evidence.js";
import { captureEnvironment } from "./core/environment.js";
import { ensureWorktree } from "./core/worktree.js";
import { compareRuns } from "./core/statistics.js";
import { createToolTraceRecorder, evaluateTrajectory, type TrajectoryEvent } from "./core/trajectories.js";
import { applyUnifiedDiff, extractUnifiedDiff } from "./core/experiment-patches.js";
import { applyCriticGate, latestOpenCriticConstraint } from "./core/critic-gate.js";
import { recordBaselineEvidence } from "./core/baseline.js";
import { redactSecrets } from "./core/redaction.js";
import { enforceClaimTermination, enforceGoalTermination } from "./core/termination.js";
import { auditClaims, type ClaimAuditReport } from "./core/claim-audit.js";
import { analyzePredictionRows, parsePredictionRows } from "./core/error-analysis.js";
import { summarizeUsage } from "./core/usage.js";
import { createBlendCandidate, diversityReport, loadPredictionVector, safePredictionPath, validateBlendCandidate, type PredictionVector } from "./core/ensemble.js";
import { formatResearchDecision, runResearchDirector } from "./agents/research-director.js";
import { boundedPeerBoard, runResearchLanes } from "./agents/research-lanes.js";
import { runResearchCritic } from "./agents/research-lanes.js";
import { checkProvider, codexLoginStatus, isProviderUsageLimit, isRetryableAgentError, listLocalModels, providerRetryAfterMs, resolveCodexModel, resolveLocalFallbackModel, runWithUsageLimitWait, runWithLocalFallback } from "./agents/codex-exec.js";
import { startInteractive } from "./session/interactive.js";
import { render } from "ink";
import React from "react";
import { App } from "./ui/app.js";
import { findWorkspaceRoot } from "./core/workspace.js";
import { autonomyPolicy, type AutonomyLevel } from "./core/permissions.js";
import { capabilityOutcome, qualityFeedback, routeCapability } from "./core/capability-router.js";
import { allocateNextResearch } from "./core/allocation.js";
import { buildExperienceRecord, capabilityProfile, curriculumReplay, experienceJsonl, selectCurriculum } from "./core/experience.js";
import { evaluateReducedPromotion } from "./core/scheduler.js";
import { validateCompetitionContract } from "./core/competition-contract.js";
import { candidateChangePath } from "./core/hypothesis-path.js";
import { withExecutionHeartbeat } from "./core/execution-heartbeat.js";
import { researchFailureRecord } from "./core/research-failure.js";
import { DEFAULT_SEARCH_OPERATORS, DEFAULT_SEARCH_OPERATOR_COSTS, DEFAULT_SEARCH_OPERATOR_NOVELTY, rankSearchArms, searchReward, summarizeSearchPolicyEvidence } from "./core/search-policy.js";
import { planPortfolio } from "./core/portfolio.js";
import { promoteHalvingStage } from "./core/successive-halving.js";
import type { CostObservation } from "./core/cost-model.js";
import { synthesizeLaneReports } from "./core/cross-pollination.js";
import { learnPromotionPolicy, promotionObservations } from "./core/promotion-learning.js";
import { compareHarnesses, scoreHarnessTrials, validateBenchmarkProtocol, type HarnessTrial } from "./core/harness-scorecard.js";
import { captureProtectedFiles, changedProtectedFiles } from "./core/integrity.js";
import { assessHypothesisQuality } from "./core/hypothesis-quality.js";
import { assessResearchDecisionRubric } from "./core/research-rubric.js";
import { assertValidationPolicy, lockValidationPolicy, readValidationPolicyLock, unlockValidationPolicy } from "./core/validation-lock.js";
import { runBenchmarkArms, type BenchmarkArmSpec } from "./core/benchmark-runner.js";
import { createAirsBenchmarkProtocol, discoverAirsBenchTasks, type AirsBenchFamily, type AirsBenchDiscovery, type AirsHarnessTemplate } from "./core/airs-bench.js";
import { inventoryHarnessComponents, planHarnessInterventions } from "./core/harness-evolution.js";
import { planHarnessAdaptation } from "./core/harness-adaptation.js";
import { deriveAdaptiveHarnessPolicy } from "./core/adaptive-harness.js";
import { createTransferableMethod } from "./core/method-transfer.js";
import { createAblationPlan } from "./core/ablation.js";

const root = findWorkspaceRoot();
const stateDirectory = resolve(process.env.EVIDRA_STATE_DIR ?? join(root, ".sota"));
const statePath = join(stateDirectory, "database.sqlite");
const program = new Command();
const activeCompetition = () => {
  const store = new ResearchStore(statePath);
  const project = store.project();
  store.close();
  return loadCompetitionAdapter(root, project?.competitionId ?? "local-research");
};

function auditCurrentClaims(store: ResearchStore): ClaimAuditReport {
  const claims = store.claims();
  const sources = store.sources();
  const decisions = store.decisions();
  const runs = store.runs();
  const artifacts = store.artifacts();
  const contradictionEdges = store.edges().filter((edge) => edge.relation === "contradicts");
  const claimPayloads = claims.map((claim) => claim.payload && typeof claim.payload === "object" ? claim.payload as { sourceId?: unknown; observation?: unknown; findings?: unknown; evidence?: unknown } : {});
  const selfDescribingEvidenceIds = claimPayloads.flatMap((payload) => {
    const sourceId = typeof payload.sourceId === "string" ? payload.sourceId : "";
    const hasDurableObservation = Boolean(payload.observation && typeof payload.observation === "object");
    const hasDurableLaneReport = Array.isArray(payload.findings) && Array.isArray(payload.evidence);
    return sourceId && (hasDurableObservation || hasDurableLaneReport) ? [sourceId] : [];
  });
  return auditClaims({
    claims: claims.map((claim) => ({ id: claim.id, payload: claim.payload })),
    knownEvidenceIds: new Set([
      ...sources.map((source) => source.id),
      ...decisions.map((decision) => `decision_${decision.id}`),
      ...decisions.map((decision) => String(decision.id)),
      ...runs.map((run) => run.id),
      ...artifacts.map((artifact) => artifact.id),
      ...claims.map((claim) => claim.id),
      ...selfDescribingEvidenceIds,
    ]),
    conflictedClaimIds: new Set(contradictionEdges.flatMap((edge) => [edge.fromId, edge.toId])),
  });
}

function requireCompetitionContract(adapter: ReturnType<typeof activeCompetition>): void {
  const report = validateCompetitionContract(adapter.config, adapter.workspacePath(root));
  if (!report.valid) {
    throw new Error(`Invalid ${adapter.config.name} contract. Run 'evidra validate' for details.\n${report.checks.filter((check) => !check.passed).map((check) => `- ${check.name}: ${check.detail}`).join("\n")}`);
  }
}

const researchToolExecutor = (competition: ReturnType<typeof activeCompetition>, autonomy: AutonomyLevel = "safe") => (call: Parameters<typeof executeResearchTool>[0]) => executeResearchTool(call, {
  root,
  storePath: statePath,
  autonomy,
  competition: competition.config,
  onProgress: (message) => console.log(`· ${message}`),
});

function durationMinutes(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|minutes?|h|hours?|d|days?)?$/i);
  if (!match) throw new Error(`Invalid duration '${value}'. Use 90m, 4h, or 2d.`);
  const multiplier = (match[2] ?? "m").toLowerCase().startsWith("h") ? 60 : (match[2] ?? "m").toLowerCase().startsWith("d") ? 1440 : 1;
  return Math.max(1, Math.round(Number(match[1]) * multiplier));
}

function candidateEstimatorPath(payload: unknown): string | undefined {
  const value = payload as { proposedChange?: unknown };
  return candidateChangePath(value.proposedChange);
}

function experimentCommandFor(adapter: ReturnType<typeof activeCompetition>, hypothesisPayload?: unknown): string[] {
  const command = adapter.experimentCommand();
  const estimator = candidateEstimatorPath(hypothesisPayload);
  if (!estimator) return command;
  const index = command.indexOf("--estimator");
  if (index >= 0 && command[index + 1]) command[index + 1] = estimator;
  return command;
}

async function runCampaignExperiment(rootPath: string, experimentId: string, stage: "all" | "reduced" | "full-after-screen" = "all"): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const script = process.argv[1];
  if (!script) throw new Error("Unable to locate the Evidra CLI entrypoint for autonomous experiment execution.");
  return runProcess([process.execPath, script, "experiment", "run", experimentId, ...(stage === "reduced" ? ["--reduced-only"] : stage === "full-after-screen" ? ["--skip-reduced"] : [])], rootPath, 7 * 24 * 60 * 60_000, (stream, chunk) => {
    (stream === "stderr" ? process.stderr : process.stdout).write(chunk);
  });
}

async function implementCampaignHypothesis(
  rootPath: string,
  experimentId: string,
  hypothesis: unknown,
  manifest: unknown,
  options: { provider: "codex" | "local"; model: string; thinking: string; protectedCommands?: string[][] },
): Promise<void> {
  const worktree = await ensureWorktree(rootPath, rootPath, experimentId);
  const integrity = captureProtectedFiles(worktree, options.protectedCommands ?? []);
  const manifestValue = manifest as { change?: { configPatch?: { estimatorPath?: unknown } } };
  const target = typeof manifestValue.change?.configPatch?.estimatorPath === "string" ? manifestValue.change.configPatch.estimatorPath : undefined;
  const targetPath = target ? resolve(worktree, target) : undefined;
  const safeTarget = targetPath && (targetPath === worktree || targetPath.startsWith(`${worktree}/`)) && existsSync(targetPath) ? targetPath : undefined;
  const inventory = await runProcess(["rg", "--files", "-g", "!.git/**", "-g", "!.sota/**", "-g", "!node_modules/**"], worktree, 60_000);
  const task = {
    role: "experiment engineer",
    objective: "Implement the selected hypothesis in this isolated worktree. Inspect the existing project, make the smallest reproducible change described by the hypothesis, run relevant smoke checks, and leave the worktree ready for evaluation. Do not touch files outside this worktree, submit anything, or invent a result.",
    context: {
      manifest,
      hypothesis,
      worktree,
      workspaceFiles: inventory.stdout.split("\n").filter(Boolean).slice(0, 300),
      ...(safeTarget ? { targetFile: { path: target, content: readFileSync(safeTarget, "utf8").slice(0, 60_000) } } : {}),
    },
  } as const;
  if (options.provider === "codex") {
    await runWithUsageLimitWait(task, {
      provider: options.provider,
      model: options.model,
      cwd: worktree,
      reasoningEffort: options.thinking,
      sandbox: "workspace-write",
      limitPolicy: "wait",
    }, (message) => console.log(`Experiment ${experimentId} · ${message}`));
  } else {
    const result = await runWithLocalFallback({
      ...task,
      objective: `${task.objective}\nYou cannot call tools directly. Return ONLY a unified diff whose first line begins with diff --git. The diff must be applicable from the worktree root. Do not return a plan or prose.`,
    }, {
      provider: options.provider,
      model: options.model,
      cwd: worktree,
      reasoningEffort: options.thinking,
      sandbox: "read-only",
    }, undefined, (message) => console.log(`Experiment ${experimentId} · ${message}`));
    const diff = extractUnifiedDiff(String(result.output));
    if (!diff) throw new Error("Local experiment engineer did not return a valid unified diff.");
    await applyUnifiedDiff(worktree, diff);
  }
  const changed = changedProtectedFiles(integrity, worktree);
  if (changed.length) throw new Error(`Specification-gaming guard rejected ${experimentId}: protected evaluator files changed: ${changed.join(", ")}`);
}

type ControllerDirective = "run" | "pause" | "stop";

function controllerDirective(): ControllerDirective {
  // Local controllers are controlled through the durable lease. Modal uses a
  // small control file because its controller and client have separate
  // processes/volumes. Read both paths so pause/resume/stop have identical
  // semantics regardless of where the controller is running.
  try {
    const store = new ResearchStore(statePath);
    const requested = store.controllerLease()?.requestedAction;
    store.close();
    if (requested === "stop") return "stop";
    if (requested === "pause") return "pause";
  } catch {
    // The file-based control path remains available if the state volume is
    // temporarily unavailable.
  }
  const path = process.env.EVIDRA_CONTROLLER_CONTROL_FILE;
  if (!path || !existsSync(path)) return "run";
  try {
    const payload = JSON.parse(readFileSync(path, "utf8")) as { action?: string };
    return payload.action === "pause" || payload.action === "stop" ? payload.action : "run";
  } catch {
    return "run";
  }
}

async function waitForControllerDirective(onPause?: () => void, onResume?: () => void): Promise<"run" | "stop"> {
  let paused = false;
  while (true) {
    const directive = controllerDirective();
    if (directive === "stop") return "stop";
    if (directive === "pause") {
      if (!paused) {
        paused = true;
        onPause?.();
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      continue;
    }
    if (paused) onResume?.();
    return "run";
  }
}

function acquireCliControllerLease(mode: "research" | "challenge"): () => void {
  const controllerId = `cli-${process.pid}-${Date.now()}`;
  const initial = new ResearchStore(statePath);
  const acquired = initial.acquireControllerLease(controllerId, process.pid, mode, "starting");
  initial.close();
  if (!acquired.acquired) {
    const lease = acquired.lease;
    throw new Error(`Another Evidra controller is already running (pid ${lease?.pid ?? "unknown"}, step ${lease?.currentStep ?? "unknown"}). Use evidra controller status or pause it before starting another campaign.`);
  }
  const recoveredStore = new ResearchStore(statePath);
  const recoveredExperiments = recoveredStore.recoverStaleExperiments();
  recoveredStore.close();
  if (recoveredExperiments.length) console.log(`Recovered ${recoveredExperiments.length} stale experiment(s) from a previous controller.`);
  let released = false;
  const heartbeat = setInterval(() => {
    try {
      const store = new ResearchStore(statePath);
      store.heartbeatControllerLease(controllerId, mode, "research-cycle");
      store.close();
    } catch {
      // The active loop remains authoritative; a later lease check will detect failure.
    }
  }, 10_000);
  heartbeat.unref();
  const release = (): void => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    try {
      const store = new ResearchStore(statePath);
      store.releaseControllerLease(controllerId);
      store.close();
    } catch {
      // Process shutdown must not turn a completed campaign into an exit failure.
    }
  };
  process.once("exit", release);
  return release;
}

async function ingestCompetitionSources(adapter: ReturnType<typeof activeCompetition>): Promise<void> {
  if (!adapter.config.researchSources?.length) return;
  const store = new ResearchStore(statePath);
  const known = new Map<string, { payload: unknown; createdAt: string }>();
  for (const entry of store.sources()) {
    const url = (entry.payload as { url?: string }).url;
    if (url && !known.has(url)) known.set(url, entry);
  }
  for (const url of adapter.config.researchSources) {
    const prior = known.get(url);
    if (prior && sourceIsFresh(prior)) continue;
    try {
      const source = await retrieveSource(url);
      const claims = sourceClaims(source.text);
      store.saveSource({ id: source.id, payload: { ...source, claims } });
      for (const [index, statement] of claims.entries()) {
        const claimId = `${source.id}_claim_${index + 1}`;
        store.saveClaim({ id: claimId, payload: { id: claimId, statement, scope: source.url, confidence: 0.35, sourceType: "literature", sourceId: source.id, status: "active" } });
        store.saveEdge({ id: `edge_${claimId}_${source.id}`, fromId: claimId, toId: source.id, relation: "derived_from", confidence: 0.35, evidenceIds: [claimId] });
      }
      store.appendEvent(prior ? "challenge.source.refreshed" : "challenge.source.ingested", { url, title: source.title, claims: claims.length, previousSource: prior ? (prior.payload as { id?: string }).id : undefined });
    } catch (error) {
      store.appendEvent("challenge.source.failed", { url, error: error instanceof Error ? error.message : String(error) });
    }
  }
  store.close();
}

program.name("evidra").description("Research-focused autonomous experimentation workbench").version("0.1.0");

program.command("init")
  .argument("<workspace>", "workspace or competition manifest to initialize")
  .action((workspace: string) => {
    const adapter = loadCompetitionAdapter(root, workspace);
    const projectDir = join(root, "competitions", adapter.id);
    mkdirSync(join(projectDir, "experiments"), { recursive: true });
    mkdirSync(join(projectDir, "reports"), { recursive: true });
    mkdirSync(join(projectDir, "submissions"), { recursive: true });
    mkdirSync(join(root, ".sota"), { recursive: true });
    const configPath = join(projectDir, "competition.json");
    if (!existsSync(configPath)) writeFileSync(configPath, `${JSON.stringify(adapter.config, null, 2)}\n`);
    const store = new ResearchStore(statePath);
    if (!store.project()) {
      store.createProject({ id: `evidra-${adapter.id}`, name: adapter.config.name, competitionId: adapter.id, config: adapter.config });
    }
    store.close();
    console.log(`Initialized Evidra project for ${adapter.config.name}`);
    console.log(`Configuration: ${configPath}`);
  });

program.command("status").action(() => {
  const store = new ResearchStore(statePath);
  const project = store.project();
  if (!project) {
    console.log("No Evidra project initialized. Start with: evidra init local-research or evidra init <workspace>");
  } else {
    console.log(`Project       ${project.name}`);
  console.log(`Workspace     ${project.competitionId}`);
    console.log(`Events        ${store.eventCount()}`);
    const lease = store.liveControllerLease();
    const running = store.experiments().filter((entry) => (entry.payload as { status?: unknown }).status === "running");
    if (!lease && running.length) console.log(`Stale experiments ${running.length} (no live controller; run research/challenge to recover safely)`);
  }
  store.close();
});

program.command("doctor").description("Check local providers, runtimes, and execution backends").action(async () => {
  const checks: string[] = [`workspace     ${root}`, `node          ${process.versions.node}`];
  for (const command of ["git", "uv", "codex", "ollama", "modal", "docker", "podman"]) {
    const result = await runProcess(["which", command], root, 5_000);
    checks.push(`${command.padEnd(13)}${result.exitCode === 0 ? result.stdout.trim() : "not found"}`);
  }
  checks.push(`codex auth    ${codexLoginStatus() || "not authenticated"}`);
  try {
    const models = await listLocalModels();
    checks.push(`ollama models ${models.length ? models.map((model) => model.id).join(", ") : "none installed"}`);
  } catch (error) {
    checks.push(`ollama API    ${error instanceof Error ? error.message : String(error)}`);
  }
  const modalAuth = process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET
    ? "environment credentials"
    : (await runProcess(["modal", "profile", "current"], root, 10_000)).exitCode === 0 ? "CLI profile selected" : "not configured";
  checks.push(`modal auth    ${modalAuth}`);
  console.log(checks.join("\n"));
});

const controller = new Command("controller").description("Inspect or control a headless Modal Evidra controller");
function controllerEntrypoint(): string {
  return process.env.EVIDRA_MODAL_CONTROLLER_ENTRYPOINT ?? "modal_controller.py::run";
}
async function invokeModalController(action: "status" | "pause" | "resume" | "stop"): Promise<void> {
  const result = await runProcess(["modal", "run", controllerEntrypoint(), "--action", action], root, 120_000);
  if (result.stdout.trim()) process.stdout.write(result.stdout);
  if (result.stderr.trim()) process.stderr.write(result.stderr);
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}
for (const action of ["status", "pause", "resume", "stop"] as const) {
  controller.command(action).description(`${action[0].toUpperCase()}${action.slice(1)} the Modal controller`).action(() => invokeModalController(action));
}
program.addCommand(controller);

program.command("usage").description("Show research, experiment, and campaign usage").action(() => {
  const store = new ResearchStore(statePath);
  const counts = store.counts();
  const project = store.project();
  const usage = summarizeUsage(store.runs(), store.experiments());
  console.log(`Project       ${project?.name ?? "not initialized"}`);
  console.log(`Events        ${store.eventCount()}`);
  console.log(`Hypotheses    ${counts.hypotheses}`);
  console.log(`Claims        ${counts.claims}`);
  console.log(`Decisions     ${counts.decisions}`);
  console.log(`Experiments   ${counts.experiments}`);
  console.log(`Runs          ${counts.runs}`);
  console.log(`Artifacts     ${counts.artifacts}`);
  console.log(`Trajectories  ${counts.trajectories}`);
  console.log(`Wall time     ${usage.wallMinutes.toFixed(1)} minutes`);
  console.log(`GPU-tagged    ${usage.gpuWallHours.toFixed(3)} hours`);
  for (const [executor, bucket] of Object.entries(usage.byExecutor)) console.log(`  ${executor.padEnd(11)} ${bucket.runs} runs · ${bucket.wallMinutes.toFixed(1)}m · ${bucket.gpuWallHours.toFixed(3)} GPU-h`);
  store.close();
});

const benchmark = new Command("benchmark").description("Compare research harnesses under a common task/budget protocol");
benchmark.command("run")
  .argument("<file>", "JSON file containing { arms: [...] }")
  .option("--out <file>", "write the run report and scorecards to a JSON file")
  .option("--workspace <dir>", "explicit benchmark workspace root; defaults to the Evidra project")
  .option("--parallel <count>", "maximum independent benchmark arms to run concurrently", "1")
  .option("--challenger <harness>", "harness that must beat the incumbents", "evidra")
  .option("--incumbent <harness>", "compare only against this incumbent; by default compare against every other harness")
  .description("Execute matched arms, score the evidence, and verify the challenger beats incumbents")
  .action(async (file: string, options: { out?: string; workspace?: string; challenger: string; incumbent?: string; parallel: string }) => {
    const parsed: unknown = JSON.parse(readFileSync(resolve(file), "utf8"));
    const raw = parsed && typeof parsed === "object" && Array.isArray((parsed as { arms?: unknown }).arms) ? (parsed as { arms: unknown[] }).arms : undefined;
    if (!raw?.length) throw new Error("Benchmark protocol must contain a non-empty arms array.");
    const arms = raw.map((value, index) => {
      if (!value || typeof value !== "object") throw new Error(`Benchmark arm ${index + 1} is not an object.`);
      const arm = value as Partial<BenchmarkArmSpec>;
      const invalidReproducibility = arm.reproducibilityCommand !== undefined && (!Array.isArray(arm.reproducibilityCommand) || !arm.reproducibilityCommand.length || !arm.reproducibilityCommand.every((part) => typeof part === "string"));
      const invalidTolerance = arm.reproducibilityTolerance !== undefined && (typeof arm.reproducibilityTolerance !== "number" || !Number.isFinite(arm.reproducibilityTolerance) || arm.reproducibilityTolerance < 0);
      if (typeof arm.harness !== "string" || typeof arm.task !== "string" || typeof arm.arm !== "string" || arm.seed === undefined || typeof arm.model !== "string" || typeof arm.budgetMinutes !== "number" || (arm.retries !== undefined && (!Number.isInteger(arm.retries) || arm.retries < 0 || arm.retries > 3)) || typeof arm.metric !== "string" || !Array.isArray(arm.command) || !arm.command.every((part) => typeof part === "string") || invalidReproducibility || invalidTolerance) throw new Error(`Benchmark arm ${index + 1} is missing a required field or has invalid retry/reproducibility settings.`);
      return arm as BenchmarkArmSpec;
    });
    const protocol = validateBenchmarkProtocol(arms.map((arm) => ({ ...arm, validRun: false, durationSeconds: 0, recovered: false, reproducible: false })));
    if (!protocol.valid) throw new Error(`Benchmark protocol is not matched:\n${protocol.issues.map((issue) => `- ${issue.message}`).join("\n")}`);
    const benchmarkWorkspace = options.workspace ? resolve(options.workspace) : root;
    const maxParallel = Math.max(1, Math.min(32, Number.parseInt(options.parallel, 10) || 1));
    const report = await runBenchmarkArms(arms, benchmarkWorkspace, (message) => console.log(`· ${message}`), { maxParallel });
    const matched = validateBenchmarkProtocol(report.trials);
    if (!matched.valid) throw new Error(`Benchmark results are not matched:\n${matched.issues.map((issue) => `- ${issue.message}`).join("\n")}`);
    const scorecards = scoreHarnessTrials(report.trials);
    const harnesses = [...new Set(report.trials.map((trial) => trial.harness))];
    const incumbents = options.incumbent ? [options.incumbent] : harnesses.filter((harness) => harness !== options.challenger);
    const comparisons = incumbents.map((incumbent) => compareHarnesses(report.trials, options.challenger, incumbent));
    const adaptation = planHarnessAdaptation(report.trials, scorecards, comparisons, options.challenger);
    const output = { ...report, scorecards, protocol: matched, challenger: options.challenger, comparisons, adaptation };
    if (options.out) writeFileSync(resolve(options.out), `${JSON.stringify(output, null, 2)}\n`);
    const benchmarkStore = new ResearchStore(statePath);
    benchmarkStore.appendEvent("harness.benchmark.completed", {
      suite: "generic",
      workspace: benchmarkWorkspace,
      maxParallel,
      challenger: options.challenger,
      incumbents,
      scorecards: scorecards.map((scorecard) => ({ harness: scorecard.harness, competitiveScore: scorecard.competitiveScore, lower95: scorecard.competitiveScoreLower95, validRunRate: scorecard.validRunRate, failureProfile: scorecard.failureProfile })),
      comparisons: comparisons.map((comparison) => ({ incumbent: comparison.incumbent, challengerWins: comparison.challengerWins, reason: comparison.reason, pairedLower95: comparison.pairedLower95 })),
      adaptation,
    });
    benchmarkStore.close();
    console.log(`Harness benchmark run complete\n${scorecards.map((scorecard) => `${scorecard.harness}: ${scorecard.competitiveScore.toFixed(1)} (lower95 ${scorecard.competitiveScoreLower95.toFixed(1)})${Object.keys(scorecard.failureProfile).length ? ` · failures ${JSON.stringify(scorecard.failureProfile)}` : ""}`).join("\n")}`);
    if (comparisons.length) {
      console.log(`\nCompetitive gate · challenger ${options.challenger}`);
      for (const comparison of comparisons) {
        console.log(`vs ${comparison.incumbent}: ${comparison.challengerWins ? "WIN PROVEN" : "NOT PROVEN"} · ${comparison.reason}`);
      }
      console.log(`\nNext harness agenda · ${adaptation.interventions.length} intervention(s)`);
      for (const intervention of adaptation.interventions.slice(0, 5)) console.log(`- [${intervention.priority}] ${intervention.target}: ${intervention.action}`);
      if (comparisons.some((comparison) => !comparison.challengerWins)) process.exitCode = 2;
    } else {
      console.log(`\nCompetitive gate · no incumbent arm found; result is scored evidence, not a win claim.`);
    }
  });
benchmark.command("validate")
  .argument("<file>", "JSON file containing a trial array or { trials: [...] }")
  .option("--json", "emit machine-readable validation")
  .description("Validate matched task, seed, model, and budget arms before scoring")
  .action((file: string, options: { json?: boolean }) => {
    const parsed: unknown = JSON.parse(readFileSync(resolve(file), "utf8"));
    const raw = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { trials?: unknown }).trials) ? (parsed as { trials: unknown[] }).trials : undefined;
    if (!raw?.length) throw new Error("Benchmark input must contain a non-empty JSON trial array.");
    const trials = raw.map((value, index) => {
      if (!value || typeof value !== "object") throw new Error(`Benchmark trial ${index + 1} is not an object.`);
      return value as HarnessTrial;
    });
    const report = validateBenchmarkProtocol(trials);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      if (!report.valid) process.exitCode = 2;
      return;
    }
    console.log(`Benchmark protocol · ${report.valid ? "MATCHED" : report.complete ? "MISMATCHED" : "INCOMPLETE"}`);
    console.log(`Harnesses  ${report.harnesses.join(", ") || "none"}`);
    console.log(`Arms       ${report.arms}`);
    for (const issue of report.issues) console.log(`- ${issue.message}${issue.values.length ? ` [${issue.values.join(", ")}]` : ""}`);
    if (!report.valid) process.exitCode = 2;
  });
benchmark.command("score")
  .argument("<file>", "JSON file containing a trial array or { trials: [...] }")
  .option("--json", "emit machine-readable scorecards")
  .description("Score task-balanced, evaluator-backed harness trials")
  .action((file: string, options: { json?: boolean }) => {
    const parsed: unknown = JSON.parse(readFileSync(resolve(file), "utf8"));
    const raw = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { trials?: unknown }).trials) ? (parsed as { trials: unknown[] }).trials : undefined;
    if (!raw?.length) throw new Error("Benchmark input must contain a non-empty JSON trial array.");
    const trials = raw.map((value, index) => {
      if (!value || typeof value !== "object") throw new Error(`Benchmark trial ${index + 1} is not an object.`);
      const trial = value as Partial<HarnessTrial>;
      if (typeof trial.harness !== "string" || typeof trial.task !== "string" || (trial.direction !== "maximize" && trial.direction !== "minimize") || typeof trial.baselineMetric !== "number" || typeof trial.validRun !== "boolean" || typeof trial.durationSeconds !== "number" || typeof trial.recovered !== "boolean" || typeof trial.reproducible !== "boolean") {
        throw new Error(`Benchmark trial ${index + 1} is missing a required field.`);
      }
      return trial as HarnessTrial;
    });
    const scorecards = scoreHarnessTrials(trials);
    if (options.json) {
      console.log(JSON.stringify(scorecards, null, 2));
      return;
    }
    console.log("Harness benchmark · task-balanced evidence score");
    console.log("Harness                 Tasks  Trials  Score  Lower95  Valid  Improve  Repro  Align  TimeEff  Failures");
    for (const scorecard of scorecards) console.log(`${scorecard.harness.padEnd(23).slice(0, 23)} ${String(scorecard.tasks).padStart(5)} ${String(scorecard.trials).padStart(7)} ${scorecard.competitiveScore.toFixed(1).padStart(6)} ${scorecard.competitiveScoreLower95.toFixed(1).padStart(8)} ${(scorecard.validRunRate * 100).toFixed(0).padStart(5)}% ${(scorecard.improvementRate * 100).toFixed(0).padStart(7)}% ${(scorecard.reproducibilityRate * 100).toFixed(0).padStart(5)}% ${scorecard.executionAlignmentRate === null ? "n/a" : `${(scorecard.executionAlignmentRate * 100).toFixed(0)}%`.padStart(5)} ${scorecard.meanTimeEfficiency === null ? "n/a" : `${(scorecard.meanTimeEfficiency * 100).toFixed(0)}%`.padStart(7)} ${Object.entries(scorecard.failureProfile).map(([name, count]) => `${name}=${count}`).join(",") || "-"}`);
  });
benchmark.command("compare")
  .argument("<file>", "JSON file containing a trial array or { trials: [...] }")
  .argument("<challenger>", "harness claiming the win")
  .argument("<incumbent>", "harness being challenged")
  .option("--json", "emit machine-readable comparison")
  .description("Make a conservative paired, task-balanced win claim")
  .action((file: string, challenger: string, incumbent: string, options: { json?: boolean }) => {
    const parsed: unknown = JSON.parse(readFileSync(resolve(file), "utf8"));
    const raw = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { trials?: unknown }).trials) ? (parsed as { trials: unknown[] }).trials : undefined;
    if (!raw?.length) throw new Error("Benchmark input must contain a non-empty JSON trial array.");
    const trials = raw.map((value, index) => {
      if (!value || typeof value !== "object") throw new Error(`Benchmark trial ${index + 1} is not an object.`);
      const trial = value as Partial<HarnessTrial>;
      if (typeof trial.harness !== "string" || typeof trial.task !== "string" || (trial.direction !== "maximize" && trial.direction !== "minimize") || typeof trial.baselineMetric !== "number" || typeof trial.validRun !== "boolean" || typeof trial.durationSeconds !== "number" || typeof trial.recovered !== "boolean" || typeof trial.reproducible !== "boolean") throw new Error(`Benchmark trial ${index + 1} is missing a required field.`);
      return trial as HarnessTrial;
    });
    const protocol = validateBenchmarkProtocol(trials);
    if (!protocol.valid) throw new Error(`Benchmark protocol is not matched:\n${protocol.issues.map((issue) => `- ${issue.message}`).join("\n")}`);
    const comparison = compareHarnesses(trials, challenger, incumbent);
    if (options.json) {
      console.log(JSON.stringify(comparison, null, 2));
      if (!comparison.challengerWins) process.exitCode = 2;
      return;
    }
    console.log(`Harness comparison · ${challenger} vs ${incumbent}`);
    console.log(`Result       ${comparison.challengerWins ? "WIN PROVEN" : "NOT PROVEN"}`);
    console.log(`Paired arms  ${comparison.validPairedArms}/${comparison.comparableArms} (${(comparison.coverage * 100).toFixed(0)}%)`);
    console.log(`Tasks        ${comparison.tasks}`);
    console.log(`Mean delta   ${comparison.pairedMeanDelta?.toFixed(6) ?? "n/a"}`);
    console.log(`Lower 95%    ${comparison.pairedLower95?.toFixed(6) ?? "n/a"}`);
    console.log(`Process Δ    ${comparison.pairedProcessQualityDelta?.toFixed(3) ?? "n/a"}`);
    console.log(`TimeEff Δ    ${comparison.pairedTimeEfficiencyDelta?.toFixed(3) ?? "n/a"}`);
    console.log(`Reason       ${comparison.reason}`);
    if (!comparison.challengerWins) process.exitCode = 2;
  });
benchmark.command("export")
  .option("--out <file>", "write JSON to a file instead of stdout")
  .option("--harness <name>", "harness label", "evidra")
  .description("Export durable Evidra experiments as benchmark trial records")
  .action((options: { out?: string; harness: string }) => {
    const store = new ResearchStore(statePath);
    const adapter = activeCompetition();
    const project = store.project();
    const baselineEvent = store.recentEvents(5_000).reverse().find((event) => event.type === "baseline.completed");
    const baselinePayload = baselineEvent?.payload as { metric?: unknown; stdout?: string } | undefined;
    const baselineMetric = typeof baselinePayload?.metric === "number" ? baselinePayload.metric : baselinePayload?.stdout ? parseMetricOutput(baselinePayload.stdout, adapter.config.metric.name).metrics[adapter.config.metric.name] : undefined;
    if (!Number.isFinite(baselineMetric)) { store.close(); throw new Error("No finite baseline.completed metric is available for benchmark export."); }
    const events = store.recentEvents(5_000);
    const campaign = store.campaign() as { budgetMinutes?: unknown; runtime?: { model?: unknown } } | undefined;
    const independentlyReplicatedParents = new Set(events
      .filter((event) => event.type === "experiment.autonomous.replication.completed")
      .map((event) => (event.payload as { parentId?: unknown }).parentId)
      .filter((parentId): parentId is string => typeof parentId === "string"));
    const trials: HarnessTrial[] = [];
    for (const run of store.runs()) {
      const payload = run.payload as { metrics?: Record<string, number>; durationSeconds?: number; recoveryAttempts?: number; status?: string; artifacts?: Record<string, string> };
      const experiment = store.experiments().find((entry) => entry.id === run.experimentId);
      const manifest = experiment?.payload as { datasetVersion?: unknown; splitVersion?: unknown; evaluation?: { seeds?: unknown } } | undefined;
      const candidateMetric = payload.metrics?.[adapter.config.metric.name];
      let runtimeFingerprint: string | undefined;
      const environmentPath = payload.artifacts?.["environment.json"];
      if (environmentPath) {
        try {
          const environment = JSON.parse(readFileSync(environmentPath, "utf8")) as { entropyAudit?: { reproducibilityFingerprint?: unknown } };
          if (typeof environment.entropyAudit?.reproducibilityFingerprint === "string") runtimeFingerprint = environment.entropyAudit.reproducibilityFingerprint;
        } catch { /* Older exports may not contain a readable environment artifact. */ }
      }
      const experimentEvents = events.filter((event) => (event.payload as { experimentId?: unknown }).experimentId === run.experimentId);
      const trajectory = store.trajectories().find((entry) => entry.runId === run.id || entry.id === `trajectory_${run.id}`);
      const trajectoryQuality = trajectory?.quality as { overall?: string; executionAlignment?: { verdict?: string }; structural?: { verdict?: string }; goalAttainment?: { verdict?: string }; evidenceConsistency?: { verdict?: string }; errorRecovery?: { verdict?: string }; termination?: { verdict?: string } } | undefined;
      const qualityVerdicts = trajectoryQuality ? [trajectoryQuality.structural, trajectoryQuality.goalAttainment, trajectoryQuality.evidenceConsistency, trajectoryQuality.errorRecovery, trajectoryQuality.termination].filter(Boolean).map((dimension) => dimension?.verdict === "PASS" ? 1 : dimension?.verdict === "WARN" ? 0.5 : 0) : [];
      trials.push({
        harness: options.harness,
        task: project?.competitionId ?? adapter.id,
        arm: `${String(manifest?.datasetVersion ?? "unknown-dataset")}::${String(manifest?.splitVersion ?? "unknown-split")}`,
        seed: Array.isArray(manifest?.evaluation?.seeds) ? manifest.evaluation.seeds.join(",") : "unknown-seed",
        model: typeof campaign?.runtime?.model === "string" ? campaign.runtime.model : "unknown-model",
        budgetMinutes: typeof campaign?.budgetMinutes === "number" ? campaign.budgetMinutes : 0,
        ...(typeof manifest?.datasetVersion === "string" ? { dataRevision: manifest.datasetVersion } : {}),
        ...(runtimeFingerprint ? { runtimeFingerprint } : {}),
        direction: adapter.config.metric.direction,
        baselineMetric: baselineMetric as number,
        candidateMetric: Number.isFinite(candidateMetric) ? candidateMetric : undefined,
        validRun: run.status === "completed" && Number.isFinite(candidateMetric),
        durationSeconds: typeof payload.durationSeconds === "number" ? payload.durationSeconds : 0,
        recovered: (payload.recoveryAttempts ?? 1) > 1 || experimentEvents.some((event) => event.type === "run.retry.scheduled"),
        // Fold/seed bootstrap evidence is not the same as an independent
        // replication experiment. Only a completed child manifest counts.
        reproducible: independentlyReplicatedParents.has(run.experimentId),
        ...(qualityVerdicts.length ? { processQuality: qualityVerdicts.reduce<number>((sum, value) => sum + value, 0) / qualityVerdicts.length } : {}),
        ...(trajectoryQuality?.executionAlignment?.verdict ? { executionAlignment: trajectoryQuality.executionAlignment.verdict === "PASS" } : {}),
      });
    }
    store.close();
    const output = `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), metric: adapter.config.metric, trials }, null, 2)}\n`;
    if (options.out) writeFileSync(resolve(options.out), output);
    else process.stdout.write(output);
  });
const airsBenchmark = benchmark.command("airs").description("Discover and import AIRS-Bench task contracts");
airsBenchmark.command("discover")
  .argument("<repository>", "AIRS-Bench repository checkout")
  .option("--family <family>", "task family: rad, mlgym, or all", "all")
  .option("--out <file>", "write the normalized task inventory to JSON")
  .description("Validate public AIRS-Bench task specifications and emit a normalized inventory")
  .action((repository: string, options: { family: string; out?: string }) => {
    if (!["rad", "mlgym", "all"].includes(options.family)) throw new Error("AIRS-Bench family must be rad, mlgym, or all.");
    const report = discoverAirsBenchTasks(repository, options.family as AirsBenchFamily);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (options.out) writeFileSync(resolve(options.out), output);
    else process.stdout.write(output);
    if (report.invalidTasks > 0) process.exitCode = 2;
  });
airsBenchmark.command("protocol")
  .argument("<inventory>", "JSON inventory produced by benchmark airs discover")
  .option("--arm <json>", "harness template JSON; repeat for every matched harness", (value: string, previous: string[] = []) => [...previous, value], [])
  .requiredOption("--model <model>", "fixed model identifier for every harness arm")
  .requiredOption("--seed <seed>", "fixed seed for every harness arm")
  .requiredOption("--budget <minutes>", "fixed per-arm wall-clock budget in minutes")
  .option("--baseline <metric>", "explicit fallback baseline metric for every task")
  .option("--baseline-map <file>", "JSON object keyed by task id or family/task id with measured baselines")
  .option("--out <file>", "write the generated protocol to JSON")
  .description("Generate matched AIRS benchmark arms from explicit harness command templates")
  .action((inventory: string, options: { arm: string[]; model: string; seed: string; budget: string; baseline?: string; baselineMap?: string; out?: string }) => {
    const parsed = JSON.parse(readFileSync(resolve(inventory), "utf8")) as AirsBenchDiscovery;
    const templates = options.arm.map((raw) => {
      const value = JSON.parse(raw) as Partial<AirsHarnessTemplate>;
      if (typeof value.harness !== "string" || !Array.isArray(value.command) || !value.command.every((part) => typeof part === "string")) throw new Error("Each --arm value must be JSON like {\"harness\":\"evidra\",\"command\":[\"...\"]}.");
      return { harness: value.harness, command: value.command, ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}) };
    });
    const baselineMetrics = options.baselineMap ? JSON.parse(readFileSync(resolve(options.baselineMap), "utf8")) as Record<string, number> : undefined;
    if (options.baseline === undefined && !baselineMetrics) throw new Error("Supply --baseline-map for heterogeneous AIRS tasks or an explicit --baseline fallback.");
    const protocol = createAirsBenchmarkProtocol(parsed, { templates, model: options.model, seed: options.seed, budgetMinutes: Number(options.budget), ...(options.baseline !== undefined ? { baselineMetric: Number(options.baseline) } : {}), ...(baselineMetrics ? { baselineMetrics } : {}) });
    const output = `${JSON.stringify(protocol, null, 2)}\n`;
    if (options.out) writeFileSync(resolve(options.out), output);
    else process.stdout.write(output);
  });
program.addCommand(benchmark);

const sources = new Command("sources").description("Retrieve and search durable research sources");
sources.command("list").action(() => {
  const store = new ResearchStore(statePath);
  const entries = store.sources();
  console.log(entries.length ? entries.map((entry) => `${entry.id} · ${String((entry.payload as { title?: string }).title ?? "Untitled")} · ${String((entry.payload as { url?: string }).url ?? "")}`).join("\n") : "No research sources cached.");
  store.close();
});
sources.command("search").argument("<query>").action((query: string) => {
  const store = new ResearchStore(statePath);
  const entries = store.sources().filter((entry) => sourceSearchText(entry).includes(query.toLowerCase()));
  console.log(entries.length ? entries.map((entry) => `${entry.id} · ${String((entry.payload as { title?: string }).title ?? "Untitled")}`).join("\n") : "No matching research sources.");
  store.close();
});
sources.command("frontier").description("Show the durable literature-search frontier and retrieval coverage").action(() => {
  const store = new ResearchStore(statePath);
  const report = sourceFrontier(store.recentEvents(2_000));
  store.close();
  console.log(JSON.stringify({ ...report, candidates: report.candidates.slice(0, 40) }, null, 2));
});
sources.command("discover").argument("<query>").option("--limit <count>", "maximum scholarly candidates", "8").description("Search scholarly sources and persist a deduplicated frontier without trusting claims").action(async (query: string, options: { limit: string }) => {
  const results = await searchResearchSources(query, Number.parseInt(options.limit, 10) || 8);
  const store = new ResearchStore(statePath);
  store.appendEvent("research.source.search.completed", { query, results, source: "openalex" });
  const frontier = sourceFrontier(store.recentEvents(2_000));
  store.close();
  console.log(`${results.length ? results.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}${result.venue ? ` · ${result.venue}` : ""}${result.publicationDate ? ` · ${result.publicationDate}` : ""}${result.authors.length ? `\n   authors: ${result.authors.join(", ")}` : ""}`).join("\n") : "No scholarly sources found."}\n\nFrontier: ${frontier.uniqueWorks} unique works · ${frontier.retrievedWorks} retrieved · ${frontier.pendingWorks} pending across ${frontier.queryCount} queries`);
});
sources.command("add").argument("<url>").action(async (url: string) => {
  const retrieved = await retrieveSource(url);
  const claims = sourceClaims(retrieved.text);
  const store = new ResearchStore(statePath);
  store.saveSource({ id: retrieved.id, payload: { ...retrieved, claims } });
  for (const [index, statement] of claims.entries()) {
    const claimId = `${retrieved.id}_claim_${index + 1}`;
    store.saveClaim({ id: claimId, payload: { id: claimId, statement, scope: retrieved.url, confidence: 0.35, sourceType: "literature", sourceId: retrieved.id, status: "active" } });
    store.saveEdge({ id: `edge_${claimId}_${retrieved.id}`, fromId: claimId, toId: retrieved.id, relation: "derived_from", confidence: 0.35, evidenceIds: [claimId] });
  }
  store.appendEvent("research.source.retrieved", { id: retrieved.id, url: retrieved.url, contentHash: retrieved.contentHash, claimCount: claims.length });
  store.close();
  console.log(`${retrieved.id}\n${retrieved.title}\n${retrieved.url}\nclaims: ${claims.length}\nhash: ${retrieved.contentHash}`);
});
sources.command("adapt")
  .argument("<id>", "cached source identifier")
  .argument("[objective]", "what the technique should improve in the active workspace")
  .description("Adapt a cached source into grounded, falsifiable workspace hypotheses")
  .action(async (id: string, objective?: string) => {
    const store = new ResearchStore(statePath);
    const sourceEntry = store.sources().find((entry) => entry.id === id);
    if (!sourceEntry) { store.close(); throw new Error(`Research source ${id} is not cached. Run: evidra sources add <url>`); }
    const project = store.project();
    const adapter = activeCompetition();
    const source = sourceEntry.payload as { title?: unknown; url?: unknown; claims?: unknown; excerpt?: unknown; contentHash?: unknown };
    const adaptationObjective = objective?.trim() || `Adapt the technique from '${typeof source.title === "string" ? source.title : id}' into testable improvements for the active workspace.`;
    const recentEvents = store.recentEvents(20);
    const researchMemory = researchMemoryContext(store, 20, adaptationObjective);
    const sourceContext = {
      id,
      title: typeof source.title === "string" ? source.title : "untitled",
      url: typeof source.url === "string" ? source.url : "",
      contentHash: typeof source.contentHash === "string" ? source.contentHash : "",
      claims: Array.isArray(source.claims) ? source.claims.slice(0, 24) : [],
      excerpt: typeof source.excerpt === "string" ? source.excerpt.slice(0, 8_000) : "",
    };
    store.appendEvent("research.source.adaptation.started", { sourceId: id, objective: adaptationObjective });
    store.close();
    const decision = await runResearchDirector(adaptationObjective, {
      project,
      competition: adapter.config,
      source: sourceContext,
      constraints: { source_claims_are_literature_not_workspace_measurements: true, no_submission: true, no_file_edits: true },
      recentEvents,
      researchMemory,
      ultimateGoal: adaptationObjective,
    }, { provider: "codex", model: "default", reasoningEffort: "high", fallbackLocalModel: process.env.EVIDRA_FALLBACK_MODEL ?? "auto", cwd: root, executeTool: researchToolExecutor(adapter) });
    const adapted = new ResearchStore(statePath);
    materializeResearchDecision(adapted, decision, { evidenceSourceId: id, evidenceScope: typeof source.url === "string" ? source.url : id });
    adapted.appendEvent("research.source.adapted", { sourceId: id, objective: adaptationObjective, decision });
    adapted.close();
    console.log(formatResearchDecision(decision));
  });
program.addCommand(sources);

const evidence = new Command("evidence").description("Inspect and verify durable research evidence");
evidence.command("audit").option("--json", "emit machine-readable JSON").description("Audit claim provenance and completion blockers").action((options: { json?: boolean }) => {
  const store = new ResearchStore(statePath);
  const report = auditCurrentClaims(store);
  store.close();
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Claim verification · ${report.publishable ? "PUBLISHABLE" : "BLOCKED"}`);
    console.log(`Total ${report.total} · verified ${report.verified} · provisional ${report.provisional} · literature-only ${report.literatureOnly} · unsupported ${report.unsupported} · conflicted ${report.conflicted}`);
    for (const entry of report.entries) console.log(`${entry.status === "verified" ? "✓" : "!"} ${entry.id} · ${entry.reasons.join("; ")}`);
  }
  if (!report.publishable && report.total > 0) process.exitCode = 2;
});
evidence.command("analyze").argument("<file>", "JSON array, {predictions: [...]}, or JSONL prediction artifact").option("--max-rows <count>", "bounded rows to inspect", "100000").description("Analyze prediction errors and worst groups").action((file: string, options: { maxRows: string }) => {
  const path = resolve(file);
  const text = readFileSync(path, "utf8");
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* JSONL is parsed row-by-row. */ }
  const maxRows = Math.max(1, Math.min(100_000, Number.parseInt(options.maxRows, 10) || 100_000));
  const rows = parsePredictionRows(parsed, maxRows);
  console.log(JSON.stringify({ path, rows: rows.length, analysis: analyzePredictionRows(rows) }, null, 2));
});
program.addCommand(evidence);

const memory = new Command("memory").description("Search durable research claims, hypotheses, and sources");
memory.command("search").argument("<query>").action((query: string) => {
  const store = new ResearchStore(statePath);
  const matches = store.searchMemory(query, 20);
  console.log(matches.length ? matches.map((match) => `${match.kind} ${match.id} · ${JSON.stringify(match.payload)}`).join("\n") : "No matching research memory.");
  store.close();
});
program.addCommand(memory);

const experience = new Command("experience").description("Inspect and export reusable research trajectories");
function storedExperiences(store: ResearchStore) {
  const byId = new Map(store.trajectories(1000).map((entry) => [entry.id, buildExperienceRecord({ trajectoryId: entry.id, payload: entry.payload, quality: entry.quality as ReturnType<typeof evaluateTrajectory> })]));
  for (const event of store.recentEvents(1000).reverse()) {
    if (event.type !== "research.experience.recorded") continue;
    const experience = (event.payload as { experience?: unknown }).experience;
    if (experience && typeof experience === "object" && typeof (experience as { trajectoryId?: unknown }).trajectoryId === "string") byId.set((experience as { trajectoryId: string }).trajectoryId, experience as ReturnType<typeof buildExperienceRecord>);
  }
  return [...byId.values()];
}
experience.command("status").action(() => {
  const store = new ResearchStore(statePath);
  const records = storedExperiences(store);
  store.close();
  console.log(JSON.stringify({ profile: capabilityProfile(records), curriculum: selectCurriculum(records) }, null, 2));
});
experience.command("export")
  .option("-o, --output <path>", "JSONL output path", ".sota/experience.jsonl")
  .option("--include-replay", "include recoverable failure trajectories for replay")
  .action((options: { output: string; includeReplay?: boolean }) => {
    const output = resolve(root, options.output);
    const outputRelative = relative(root, output);
    if (outputRelative.startsWith("..") || outputRelative.startsWith("/") || outputRelative.includes("..")) throw new Error("Experience export path must stay inside the project root.");
    const store = new ResearchStore(statePath);
    const records = storedExperiences(store);
    store.close();
    mkdirSync(dirname(output), { recursive: true });
    const content = experienceJsonl(records, options.includeReplay === true);
    writeFileSync(output, content);
    const exported = content ? content.trimEnd().split("\n").length : 0;
    console.log(`Exported ${exported} experience record(s) to ${output}`);
  });
program.addCommand(experience);

const submission = new Command("submission").description("Prepare, approve, and validate safe submission bundles");
submission.command("status").action(() => {
  const store = new ResearchStore(statePath);
  const submissions = store.submissions();
  console.log(submissions.length ? submissions.map((entry) => `${entry.status} ${entry.id} · experiment ${entry.experimentId} · ${entry.path}`).join("\n") : "No submission bundles prepared.");
  store.close();
});
submission.command("validate").argument("<bundle>").action((bundle: string) => {
  const path = bundle.startsWith("/") ? bundle : join(root, ".sota", "submissions", bundle);
  const report = validateSubmissionBundle(path);
  console.log(report.checks.map((check) => `${check.passed ? "✓" : "✗"} ${check.name} · ${check.detail}`).join("\n"));
  if (!report.valid) process.exitCode = 1;
});
submission.command("prepare").argument("<experiment>").action((experimentId: string) => {
  const store = new ResearchStore(statePath);
  const experiment = store.experiments().find((entry) => entry.id === experimentId);
  const run = store.runs().find((entry) => entry.experimentId === experimentId);
  store.close();
  if (!experiment || !run) throw new Error(`Experiment ${experimentId} must have a recorded run before preparation.`);
  const adapter = activeCompetition();
  const bundle = prepareSubmission(root, experimentId, ExperimentManifestSchema.parse(experiment.payload), RunResultSchema.parse(run.payload), adapter.config);
  const recordStore = new ResearchStore(statePath);
  recordStore.saveSubmission({ id: bundle.id, experimentId, path: bundle.path, status: "prepared", payload: { competition: adapter.id } });
  recordStore.close();
  console.log(`Prepared ${bundle.id}\n${bundle.path}\nExternal submission remains approval-gated.`);
});
submission.command("approve").argument("<bundle>").action((bundle: string) => {
  const store = new ResearchStore(statePath);
  const entry = store.submissions().find((candidate) => candidate.id === bundle);
  if (!entry) { store.close(); throw new Error(`Submission bundle ${bundle} is not registered.`); }
  const report = validateSubmissionBundle(entry.path);
  if (!report.valid) { store.close(); throw new Error(`Submission bundle is not valid; run evidra submission validate ${bundle}`); }
  store.updateSubmissionStatus(bundle, "approved", { approvedAt: new Date().toISOString(), externalSubmission: "not configured" });
  store.close();
  console.log(`Approved ${bundle}. Submit explicitly with: evidra submission submit ${bundle}`);
});
submission.command("submit").argument("<bundle>").option("--message <message>", "submission message", "Evidra research submission").option("--information-value <value>", "expected information value of this submission").option("--local-confidence <value>", "confidence in the local validation").option("--final", "identify this as a final ensemble submission").action(async (bundle: string, options: { message: string; informationValue?: string; localConfidence?: string; final?: boolean }) => {
  const store = new ResearchStore(statePath);
  const entry = store.submissions().find((candidate) => candidate.id === bundle);
  if (!entry) { store.close(); throw new Error(`Submission bundle ${bundle} is not registered.`); }
  if (entry.status !== "approved") { store.close(); throw new Error(`Submission ${bundle} is '${entry.status}'. Run submission approve first.`); }
  const gates = store.experimentGates(entry.experimentId);
  if (!gates.leakageAuditPassed) { store.close(); throw new Error(`Submission ${bundle} is blocked: leakage audit approval is required. Run evidra experiment gate ${entry.experimentId} leakage approve.`); }
  const adapter = activeCompetition();
  const policy = adapter.config.submissionPolicy;
  const priorSubmittedAt = store.submissions().filter((candidate) => candidate.status === "submitted" || candidate.status === "scored").map((candidate) => {
    const payload = candidate.payload as { receipt?: { submittedAt?: unknown } };
    return typeof payload.receipt?.submittedAt === "string" ? payload.receipt.submittedAt : candidate.updatedAt;
  });
  const payload = entry.payload as { informationValue?: unknown; localConfidence?: unknown; isFinalEnsemble?: unknown };
  const informationValue = options.informationValue === undefined ? (typeof payload.informationValue === "number" ? payload.informationValue : undefined) : Number(options.informationValue);
  const localConfidence = options.localConfidence === undefined ? (typeof payload.localConfidence === "number" ? payload.localConfidence : undefined) : Number(options.localConfidence);
  const policyDecision = evaluateSubmissionPolicy(policy, { submittedAt: priorSubmittedAt, informationValue, localConfidence, leakageFlagged: !gates.leakageAuditPassed, isFinalEnsemble: options.final || payload.isFinalEnsemble === true });
  if (!policyDecision.allowed) { store.close(); throw new Error(`Submission policy blocked ${bundle}: ${policyDecision.reasons.join("; ")}`); }
  try {
    const attempt = await submitApprovedBundle(root, entry.path, adapter.config, options.message);
    store.updateSubmissionStatus(bundle, "submitted", { ...(typeof entry.payload === "object" && entry.payload ? entry.payload : {}), receipt: attempt.receipt });
    store.appendEvent("submission.external.submitted", { id: bundle, platform: attempt.receipt.platform, predictionFile: attempt.receipt.predictionFile, submittedAt: attempt.receipt.submittedAt });
    console.log(`Submitted ${bundle} via ${attempt.receipt.platform}\n${attempt.receipt.stdout.trim()}`);
  } finally { store.close(); }
});
submission.command("poll").argument("<bundle>").description("Poll a configured external score adapter").action(async (bundle: string) => {
  const store = new ResearchStore(statePath);
  const entry = store.submissions().find((candidate) => candidate.id === bundle);
  if (!entry) { store.close(); throw new Error(`Submission bundle ${bundle} is not registered.`); }
  if (entry.status !== "submitted" && entry.status !== "scored") { store.close(); throw new Error(`Submission ${bundle} is '${entry.status}'. Submit it before polling.`); }
  const adapter = activeCompetition();
  try {
    const observation = await pollSubmissionScore(root, entry.path, bundle, adapter.config);
    const recordedAt = observation.observedAt;
    store.updateSubmissionStatus(bundle, "scored", { ...(typeof entry.payload === "object" && entry.payload ? entry.payload : {}), publicScore: observation.score, platform: observation.platform, recordedAt, scoreObservation: observation });
    store.saveClaim({ id: `claim_external_score_${bundle}_${Date.now()}`, payload: { statement: `External ${observation.platform} score for ${bundle}: ${observation.score}`, scope: entry.experimentId, confidence: 1, sourceType: "external_score", sourceId: bundle, status: "active", score: observation.score, platform: observation.platform, recordedAt } });
    store.appendEvent("submission.score.polled", { id: bundle, score: observation.score, platform: observation.platform, recordedAt });
    console.log(`Polled ${observation.platform} score ${observation.score} for ${bundle}.`);
  } finally { store.close(); }
});
submission.command("record").argument("<bundle>").requiredOption("--public-score <score>", "score returned by the competition platform").option("--platform <name>", "platform or evaluation source", "manual").option("--validation <json>", "local split scores as JSON").action((bundle: string, options: { publicScore: string; platform: string; validation?: string }) => {
  const score = Number(options.publicScore);
  if (!Number.isFinite(score)) throw new Error("Public score must be a finite number.");
  const store = new ResearchStore(statePath);
  const entry = store.submissions().find((candidate) => candidate.id === bundle);
  if (!entry) { store.close(); throw new Error(`Submission bundle ${bundle} is not registered.`); }
  const validation = validateSubmissionBundle(entry.path);
  if (!validation.valid) { store.close(); throw new Error(`Submission bundle is not valid; score was not recorded.`); }
  const recordedAt = new Date().toISOString();
  let validationScores: Record<string, number> = {};
  if (options.validation) {
    const parsed = JSON.parse(options.validation) as Record<string, unknown>;
    validationScores = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "number" && Number.isFinite(value)) as Array<[string, number]>);
  }
  store.updateSubmissionStatus(bundle, "scored", { ...(typeof entry.payload === "object" && entry.payload ? entry.payload : {}), publicScore: score, validationScores, platform: options.platform, recordedAt });
  store.saveClaim({ id: `claim_external_score_${bundle}_${Date.now()}`, payload: { statement: `External ${options.platform} score for ${bundle}: ${score}`, scope: entry.experimentId, confidence: 1, sourceType: "external_score", sourceId: bundle, status: "active", score, platform: options.platform, recordedAt } });
  store.appendEvent("submission.score.recorded", { id: bundle, score, platform: options.platform, recordedAt });
  store.close();
  console.log(`Recorded ${options.platform} score ${score} for ${bundle}.`);
});
submission.command("distribution").description("Estimate which local validation split tracks external scores").action(() => {
  const store = new ResearchStore(statePath);
  const observations: ExternalValidationObservation[] = store.submissions()
    .map((entry) => entry.payload as { publicScore?: unknown; validationScores?: unknown })
    .filter((payload) => typeof payload.publicScore === "number" && payload.validationScores && typeof payload.validationScores === "object")
    .map((payload, index) => ({ id: `submission-${index}`, externalScore: payload.publicScore as number, validationScores: payload.validationScores as Record<string, number> }));
  store.close();
  console.log(JSON.stringify(estimateDistributionBeliefs(observations), null, 2));
});
program.addCommand(submission);

const ensemble = new Command("ensemble").description("Inspect and create durable prediction blend candidates");
function predictionVectors(store: ResearchStore): PredictionVector[] {
  return store.artifacts()
    .filter((entry) => /prediction|oof/i.test(entry.name))
    .filter((entry) => safePredictionPath(root, entry.path))
    .flatMap((entry) => { try { return [loadPredictionVector(entry.id, entry.path)]; } catch { return []; } });
}
ensemble.command("candidates").action(() => {
  const store = new ResearchStore(statePath);
  const vectors = predictionVectors(store);
  const blends = store.ensembleCandidates(20);
  store.close();
  console.log(`${vectors.length ? `Prediction candidates\n${vectors.map((vector) => `- ${vector.id} · ${vector.values.length} values · ${vector.path}`).join("\n")}` : "No valid prediction or OOF artifacts found."}${blends.length ? `\n\nBlend candidates\n${blends.map((blend) => `- ${blend.status} ${blend.id} · ${blend.path} · ${blend.checksum}`).join("\n")}` : ""}`);
});
ensemble.command("diversity").action(() => {
  const store = new ResearchStore(statePath);
  const vectors = predictionVectors(store);
  store.close();
  if (vectors.length < 2) throw new Error("At least two valid prediction artifacts are required for ensemble analysis.");
  console.log(diversityReport(vectors).map((pair) => `${pair.left} ↔ ${pair.right} · correlation ${pair.correlation.toFixed(4)} · disagreement ${pair.disagreement.toFixed(6)}`).join("\n"));
});
ensemble.command("propose").action(() => {
  const store = new ResearchStore(statePath);
  const vectors = predictionVectors(store);
  if (vectors.length < 2) { store.close(); throw new Error("At least two valid prediction artifacts are required to create an ensemble candidate."); }
  const candidate = createBlendCandidate(root, vectors);
  store.saveEnsembleCandidate({ id: candidate.id, path: candidate.path, checksum: candidate.checksum, status: candidate.status, payload: candidate });
  store.appendEvent("ensemble.candidate.created", { id: candidate.id, path: candidate.path, checksum: candidate.checksum, members: candidate.members, diversity: diversityReport(vectors) });
  store.close();
  console.log(`Ensemble candidate created\n  id: ${candidate.id}\n  members: ${candidate.members.length}\n  path: ${candidate.path}\n  checksum: ${candidate.checksum}\n  status: ${candidate.status}`);
});
for (const action of ["validate", "promote", "reject"] as const) {
  ensemble.command(action).argument("<candidate>").action((candidateId: string) => {
    const store = new ResearchStore(statePath);
    const candidate = store.ensembleCandidates(100).find((entry) => entry.id === candidateId);
    if (!candidate) { store.close(); throw new Error(`Ensemble candidate ${candidateId} is not registered.`); }
    try {
      if (action === "validate") {
        const report = validateBlendCandidate(candidate.path, candidate.checksum);
        if (!report.valid) throw new Error(`Ensemble validation failed: ${report.reason}`);
        store.updateEnsembleCandidateStatus(candidate.id, "validated", { ...(candidate.payload as Record<string, unknown>), validatedAt: new Date().toISOString(), validation: report });
        console.log(`Validated ensemble ${candidate.id}: ${report.reason}`);
      } else {
        const next = action === "promote" ? "promoted" : "rejected";
        if (next === "promoted") {
          const report = validateBlendCandidate(candidate.path, candidate.checksum);
          if (!report.valid) throw new Error(`Promotion refused: ${report.reason}`);
        }
        store.updateEnsembleCandidateStatus(candidate.id, next, { ...(candidate.payload as Record<string, unknown>), [`${next}At`]: new Date().toISOString() });
        console.log(`Marked ensemble ${candidate.id} ${next}. External submission remains approval-gated.`);
      }
    } finally { store.close(); }
  });
}
program.addCommand(ensemble);

const queue = new Command("queue").description("Inspect the durable research work queue");
queue.command("status").action(() => {
  const store = new ResearchStore(statePath);
  const tasks = store.queueTasks();
  console.log(tasks.length ? tasks.map((task) => `${task.status} ${task.id} · ${task.kind} · priority ${task.priority} · attempts ${task.attempts}`).join("\n") : "Research queue is empty.");
  store.close();
});
queue.command("recover").action(() => {
  const store = new ResearchStore(statePath);
  console.log(`Requeued ${store.requeueStaleTasks()} stale tasks.`);
  store.close();
});
program.addCommand(queue);

program.command("timeline")
  .option("--limit <count>", "number of recent events", "30")
  .action((options: { limit: string }) => {
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 30));
    const store = new ResearchStore(statePath);
    const events = store.recentEvents(limit);
    store.close();
    console.log(renderTimeline(events, limit));
  });

program.command("report")
  .argument("[kind]", "research, challenge, or final", "research")
  .action((kind: string) => {
    if (!["research", "challenge", "final"].includes(kind)) throw new Error("Report kind must be research, challenge, or final.");
    const store = new ResearchStore(statePath);
    // A report must not present a dead controller's in-flight records as live
    // work. Active controllers retain ownership; otherwise stale experiments
    // are durably quarantined for the normal bounded recovery path.
    if (!store.liveControllerLease()) store.recoverStaleExperiments();
    const content = renderReport(store, kind as ReportKind);
    const path = writeReport(root, kind as ReportKind, content);
    store.appendEvent("report.generated", { kind, path });
    store.close();
    console.log(path);
  });

program.command("inspect").action(() => {
  const store = new ResearchStore(statePath);
  const project = store.project();
  if (!project) {
    console.log("No project initialized.");
  } else {
    console.log(JSON.stringify(project.config, null, 2));
  }
  store.close();
});

program.command("validate")
  .alias("contract")
  .description("Validate the active workspace and experiment contract without running compute")
  .action(() => {
    const adapter = activeCompetition();
    const report = validateCompetitionContract(adapter.config, adapter.workspacePath(root));
    console.log(`Contract · ${adapter.config.name}\n${report.checks.map((check) => `  ${check.passed ? "✓" : "✗"} ${check.name}: ${check.detail}`).join("\n")}`);
    if (!report.valid) process.exitCode = 2;
  });

const project = new Command("project").description("Inspect the active Evidra project");
project.command("status").action(() => {
  const store = new ResearchStore(statePath);
  const active = store.project();
  console.log(active ? `${active.name}\nWorkspace: ${active.competitionId}\nEvents: ${store.eventCount()}` : "No Evidra project initialized.");
  store.close();
});
project.command("inspect").action(() => {
  const store = new ResearchStore(statePath);
  console.log(JSON.stringify(store.project()?.config ?? null, null, 2));
  store.close();
});
program.addCommand(project);

const challenge = new Command("challenge").description("Manage the active challenge adapter");
challenge.command("list").action(() => {
  const adapter = activeCompetition();
  console.log(`* ${adapter.id} — ${adapter.config.name}`);
});
challenge.command("status").action(() => {
  const store = new ResearchStore(statePath);
  const active = store.project();
  const adapter = activeCompetition();
  const campaign = store.campaign() as { status?: string; goal?: string; budgetMinutes?: number; autoExecuteExperiments?: boolean } | undefined;
  const lease = store.liveControllerLease();
  console.log(`Challenge: ${adapter.config.name}\nInitialized: ${active?.competitionId === adapter.id ? "yes" : "no"}${campaign ? `\nCampaign: ${campaign.status ?? "unknown"}\nGoal: ${campaign.goal ?? "(none)"}\nBudget: ${campaign.budgetMinutes ?? "?"} minutes\nAutonomous experiments: ${campaign.autoExecuteExperiments ? "enabled" : "approval-gated"}` : "\nCampaign: none"}${lease ? `\nController: running (pid ${lease.pid}, step ${lease.currentStep ?? "unknown"})` : "\nController: idle"}`);
  store.close();
});
for (const action of ["pause", "resume", "stop"] as const) {
  challenge.command(action).description(`${action[0].toUpperCase()}${action.slice(1)} the durable challenge campaign`).action(async () => {
    const store = new ResearchStore(statePath);
    const campaign = store.campaign() as Record<string, unknown> | undefined;
    if (!campaign) { store.close(); throw new Error("No challenge campaign exists. Start one in the Evidra TUI with /challenge start."); }
    if (action === "resume" && campaign.status === "completed") { store.close(); throw new Error("The challenge campaign is completed/stopped. Start a new campaign with evidra challenge start."); }
    const lease = store.liveControllerLease();
    if (lease) {
      store.requestControllerAction(action);
      store.setSchedulerState({ status: action === "resume" ? "running" : "draining", mode: "challenge", currentStep: `requested-${action}` });
      store.close();
      console.log(`Challenge ${action} requested; active controller pid ${lease.pid} will apply it at the next safe boundary.`);
      return;
    }
    const status = action === "resume" ? "running" : action === "pause" ? "paused" : "completed";
    const updated = { ...campaign, status };
    store.saveCampaign(updated);
    store.setSchedulerState({ status: action === "stop" ? "idle" : action === "resume" ? "running" : "paused", mode: "challenge", currentStep: action });
    store.close();
    console.log(`Challenge campaign ${action === "stop" ? "stopped" : `${action}d`}.`);
    if (action === "resume") {
      const script = process.argv[1];
      if (!script) throw new Error("Unable to locate the Evidra CLI entrypoint.");
      const result = await runProcess([process.execPath, script, "research", "--mode", "challenge", "--resume"], root, 7 * 24 * 60 * 60_000, (stream, chunk) => {
        (stream === "stderr" ? process.stderr : process.stdout).write(chunk);
      });
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    }
  });
}
challenge.command("inspect").action(() => console.log(JSON.stringify(activeCompetition().config, null, 2)));
challenge.command("audit").option("--accept <reason>", "explicitly accept unresolved audit findings with a reason").action((options: { accept?: string }) => {
  const adapter = activeCompetition();
  const report = auditData(adapter.workspacePath(root));
  const fingerprint = dataAuditFingerprint(report);
  const store = new ResearchStore(statePath);
  store.appendEvent("data.audit.completed", { ...report, fingerprint });
  if (options.accept?.trim()) store.appendEvent("data.audit.accepted", { accepted: true, fingerprint, reason: options.accept.trim(), findings: { duplicateGroups: report.duplicateGroups.length, distributionShift: report.distributionShift.length, warnings: report.warnings.length } });
  store.close();
  console.log(JSON.stringify(report, null, 2));
});
challenge.command("policy").action(() => {
  const adapter = activeCompetition();
  const paths = validationPaths();
  if (readValidationPolicyLock(paths.lock)?.locked) throw new Error("Validation policy is locked. Use 'evidra validation unlock --reason <reason>' before regenerating it.");
  const policy = createValidationPolicy(adapter.config);
  mkdirSync(stateDirectory, { recursive: true });
  console.log(`Validation policy: ${paths.policy}\nChecksum: ${writeValidationPolicy(paths.policy, policy)}\n${JSON.stringify(policy, null, 2)}`);
});
challenge.command("baseline").description("Run the canonical baseline").action(async () => {
  const adapter = activeCompetition();
  requireCompetitionContract(adapter);
  const result = await runProcess(adapter.baselineCommand(), adapter.workspacePath(root), adapter.config.evaluatorTimeoutMinutes * 60_000);
  console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
});

challenge.command("start")
  .description("Start a fully autonomous headless challenge campaign")
  .option("--goal <goal>", "ultimate challenge goal", "Win the active challenge with robust, reproducible evidence")
  .option("--budget <duration>", "autonomous budget, e.g. 90m or 4h", "60m")
  .option("--stop <condition>", "campaign stopping condition", "stop after a replicated improvement or when evidence is exhausted")
  .option("--provider <provider>", "agent provider: codex or local", "codex")
  .option("--model <model>", "provider model; use default for Codex", "default")
  .option("--thinking <effort>", "reasoning effort", "high")
  .option("--lanes <count>", "maximum independent research lanes", "3")
  .option("--autonomy <level>", "autonomous tool policy: safe, fast, or yolo", "safe")
  .option("--limit-policy <policy>", "on provider usage limit: auto, wait, fallback, or stop", "auto")
  .option("--executor <executor>", "experiment execution target: local, container, or modal", "local")
  .option("--resume", "resume the saved challenge campaign")
  .option("--skip-baseline", "reuse the latest recorded baseline observation")
  .action(async (options: { goal: string; budget: string; stop: string; provider: string; model: string; thinking: string; lanes: string; autonomy: string; limitPolicy: string; executor: string; resume?: boolean; skipBaseline?: boolean }) => {
    const script = process.argv[1];
    if (!script) throw new Error("Unable to locate the Evidra CLI entrypoint.");
    const args = ["research", "--mode", "challenge", "--goal", options.goal, "--budget", options.budget, "--stop", options.stop, "--provider", options.provider, "--model", options.model, "--thinking", options.thinking, "--lanes", options.lanes, "--autonomy", options.autonomy, "--limit-policy", options.limitPolicy, "--executor", options.executor];
    if (options.resume) args.push("--resume");
    if (options.skipBaseline) args.push("--skip-baseline");
    const result = await runProcess([process.execPath, script, ...args], root, 7 * 24 * 60 * 60_000, (stream, chunk) => {
      (stream === "stderr" ? process.stderr : process.stdout).write(chunk);
    });
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  });
program.addCommand(challenge);

const research = new Command("research").description("Ask the embedded research agent for the next research decision");
research
  .option("--mode <mode>", "campaign mode: research or challenge", "research")
  .option("--goal <goal>", "ultimate research goal", "Improve the current workspace or research problem with robust, reproducible evidence")
  .option("--budget <duration>", "autonomous budget, e.g. 90m or 4h", "60m")
  .option("--stop <condition>", "campaign stopping condition", "stop when the research director has sufficient evidence for the stated goal")
  .option("--provider <provider>", "agent provider: codex or local", "codex")
  .option("--model <model>", "provider model; use default for Codex", "default")
  .option("--thinking <effort>", "reasoning effort", "high")
  .option("--lanes <count>", "maximum independent research lanes", "3")
  .option("--autonomy <level>", "autonomous tool policy: safe, fast, or yolo", "safe")
  .option("--limit-policy <policy>", "on provider usage limit: auto, wait, fallback, or stop", "auto")
  .option("--executor <executor>", "experiment execution target: local, container, or modal", "local")
  .option("--resume", "resume the latest durable non-completed research campaign")
  .option("--skip-baseline", "reuse the latest recorded baseline observation")
  .action(async (options: { mode: string; goal: string; budget: string; stop: string; provider: string; model: string; thinking: string; lanes: string; autonomy: string; limitPolicy: string; executor: string; resume?: boolean; skipBaseline?: boolean }) => {
    const savedStore = new ResearchStore(statePath);
    const savedCampaign = savedStore.campaign() as { goal?: string; budgetMinutes?: number; stopCondition?: string; startedAt?: string; status?: "setup" | "running" | "paused" | "completed"; pausedAt?: string; pausedDurationMinutes?: number; runtime?: unknown } | undefined;
    savedStore.close();
    // A resume is a continuation of the durable campaign, not a new run with
    // whichever defaults the current terminal happens to have. Legacy
    // campaigns without runtime metadata retain the explicit CLI settings.
    const savedRuntime = options.resume && savedCampaign && savedCampaign.status !== "completed"
      ? readCampaignRuntime(savedCampaign)
      : undefined;
    if (savedRuntime) {
      options.mode = savedRuntime.mode;
      options.provider = savedRuntime.provider;
      options.model = savedRuntime.model;
      options.thinking = savedRuntime.thinking;
      options.lanes = String(savedRuntime.lanes);
      options.autonomy = savedRuntime.autonomy;
      options.limitPolicy = savedRuntime.limitPolicy;
      options.executor = savedRuntime.executor;
    }
    if (options.provider !== "codex" && options.provider !== "local") throw new Error("Provider must be 'codex' or 'local'.");
    if (!["auto", "wait", "fallback", "stop"].includes(options.limitPolicy)) throw new Error("Limit policy must be 'auto', 'wait', 'fallback', or 'stop'.");
    if (options.mode !== "research" && options.mode !== "challenge") throw new Error("Mode must be 'research' or 'challenge'.");
    if (!["safe", "fast", "yolo"].includes(options.autonomy)) throw new Error("Autonomy must be 'safe', 'fast', or 'yolo'.");
    if (!["local", "container", "modal"].includes(options.executor)) throw new Error("Executor must be 'local', 'container', or 'modal'.");
    const mode = options.mode as "research" | "challenge";
    const autonomy = options.autonomy as AutonomyLevel;
    const adapter = activeCompetition();
    requireCompetitionContract(adapter);
    await ingestCompetitionSources(adapter);
    const budget = durationMinutes(options.budget);
    const selectedModel = options.provider === "local" && options.model === "default"
      ? await resolveLocalFallbackModel("auto")
      : options.provider === "codex"
        ? await resolveCodexModel(options.model)
        : options.model;
    let researchModelPool: Array<{ provider: "codex" | "local"; model: string }> = [{ provider: options.provider as "codex" | "local", model: selectedModel }];
    if (options.provider === "local") {
      try {
        const models = await listLocalModels();
        researchModelPool = models.length ? models.map((model) => ({ provider: "local" as const, model: model.id })) : researchModelPool;
      } catch { /* The already-validated primary model remains usable if discovery briefly fails. */ }
    }
    const laneLimit = Math.max(1, Math.min(6, Number.parseInt(options.lanes, 10) || 1));
    await checkProvider({ provider: options.provider, model: selectedModel, cwd: root });
    const releaseLease = acquireCliControllerLease(mode);
    const started = Date.now();
    const runtime: CampaignRuntimeConfig = { mode, provider: options.provider as CampaignRuntimeConfig["provider"], model: selectedModel, thinking: options.thinking, lanes: laneLimit, autonomy, limitPolicy: options.limitPolicy as CampaignRuntimeConfig["limitPolicy"], executor: options.executor as CampaignRuntimeConfig["executor"] };
    let campaign: { goal: string; budgetMinutes: number; stopCondition: string; startedAt: string; status: "running" | "paused" | "completed"; pausedAt?: string; pausedDurationMinutes?: number; runtime: CampaignRuntimeConfig } = options.resume && savedCampaign && savedCampaign.status !== "completed"
      ? { ...resumeCampaign({ goal: savedCampaign.goal ?? options.goal, budgetMinutes: savedCampaign.budgetMinutes ?? budget, stopCondition: savedCampaign.stopCondition ?? options.stop, startedAt: savedCampaign.startedAt ?? new Date(started).toISOString(), status: savedCampaign.status === "paused" ? "paused" : "running", pausedAt: savedCampaign.pausedAt, pausedDurationMinutes: savedCampaign.pausedDurationMinutes, runtime: savedRuntime ?? runtime }), status: "running", runtime }
      : { goal: options.goal, budgetMinutes: budget, stopCondition: options.stop, startedAt: new Date(started).toISOString(), status: "running", runtime };
    if (options.resume) console.log(savedCampaign && savedCampaign.status !== "completed" ? `Resuming durable research campaign from ${savedCampaign.startedAt ?? "saved state"}.` : "No resumable campaign found; starting a new research campaign.");
    const objective = `${campaign.goal}. Stop condition: ${campaign.stopCondition}`;
    let cycle = 0;
    do {
      const directive = await waitForControllerDirective(
        () => {
          if (campaign.status === "paused") return;
          campaign = pauseCampaign(campaign);
          const pausedStore = new ResearchStore(statePath);
          pausedStore.saveCampaign(campaign);
          pausedStore.setSchedulerState({ status: "paused", mode, currentStep: "controller-paused" });
          pausedStore.appendEvent("research.controller.paused", { cycle, source: "controller request" });
          pausedStore.close();
          console.log("Research controller paused; waiting for a resume request.");
        },
        () => {
          campaign = resumeCampaign(campaign);
          const resumedStore = new ResearchStore(statePath);
          resumedStore.saveCampaign(campaign);
          resumedStore.setSchedulerState({ status: "running", mode, currentStep: "controller-resumed" });
          resumedStore.appendEvent("research.controller.resumed", { cycle, source: "controller request" });
          resumedStore.close();
          console.log("Research controller resumed from the durable pause boundary.");
        },
      );
      if (directive === "stop") {
        campaign.status = "completed";
        const stoppedStore = new ResearchStore(statePath);
        stoppedStore.saveCampaign(campaign);
        stoppedStore.appendEvent("research.controller.stop", { cycle, reason: "remote controller stop request" });
        stoppedStore.setSchedulerState({ status: "idle", mode, currentStep: "controller-stopped" });
        stoppedStore.close();
        console.log("Research controller stop requested; stopped at the next safe boundary.");
        break;
      }
      cycle += 1;
      await ingestCompetitionSources(adapter);
      const store = new ResearchStore(statePath);
      if (!store.project()) store.createProject({ id: `evidra-${adapter.id}`, name: adapter.config.name, competitionId: adapter.id, config: adapter.config });
      store.saveCampaign(campaign);
      if (!store.phaseGoals().length) for (const goal of definePhaseGoals(objective, mode)) store.savePhaseGoal({ id: goal.id, phase: goal.phase, status: goal.status, payload: goal });
      const staleExperiment = store.experiments().find((entry) => {
        const payload = entry.payload && typeof entry.payload === "object" ? entry.payload as { status?: unknown; stale?: unknown; recoveryAttempted?: unknown } : {};
        return payload.status === "failed" && payload.stale === true && payload.recoveryAttempted !== true;
      });
      if (staleExperiment) {
        const stalePayload = staleExperiment.payload && typeof staleExperiment.payload === "object" ? staleExperiment.payload as Record<string, unknown> : {};
        store.saveExperiment({ id: staleExperiment.id, payload: { ...stalePayload, status: "scheduled", recoveryAttempted: true, recoveryAttemptedAt: new Date().toISOString() } });
        store.appendEvent("experiment.recovery.scheduled", { experimentId: staleExperiment.id, reason: "controller restart", attempt: Number(stalePayload.recoveryAttempts ?? 0) + 1, policy: "one bounded retry of the immutable manifest" });
        store.close();
        console.log(`Recovering stale experiment ${staleExperiment.id} once before choosing a new research action...`);
        let recovery: { exitCode: number; stdout: string; stderr: string };
        try {
          recovery = await runCampaignExperiment(root, staleExperiment.id);
        } catch (error) {
          recovery = {
            exitCode: 1,
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
          };
        }
        const recoveryStore = new ResearchStore(statePath);
        if (recovery.exitCode !== 0) {
          const recoveredEntry = recoveryStore.experiments().find((entry) => entry.id === staleExperiment.id);
          if (recoveredEntry) {
            const recoveredPayload = recoveredEntry.payload && typeof recoveredEntry.payload === "object" ? recoveredEntry.payload as Record<string, unknown> : {};
            recoveryStore.saveExperiment({ id: staleExperiment.id, payload: { ...recoveredPayload, status: "failed", stale: false, recoveryAttempted: true, recoveryError: recovery.stderr || recovery.stdout || `exit code ${recovery.exitCode}` } });
          }
        }
        recoveryStore.appendEvent(recovery.exitCode === 0 ? "experiment.recovery.completed" : "experiment.recovery.failed", { experimentId: staleExperiment.id, exitCode: recovery.exitCode, stdout: recovery.stdout.slice(-2000), stderr: recovery.stderr.slice(-2000) });
        recoveryStore.close();
        continue;
      }
      const phaseGoal = activePhaseGoal(phaseGoalsForMode(store.phaseGoals().map((entry) => PhaseGoalSchema.parse(entry.payload)), mode));
      const durableEvents = store.recentEvents(500);
      const recentEvents = durableEvents.slice(-20);
      const openCriticConstraint = latestOpenCriticConstraint(durableEvents);
      const literatureFrontier = sourceFrontier(durableEvents);
      const harnessBenchmarkEvidence = durableEvents
        .filter((event) => event.type === "harness.benchmark.completed")
        .slice(-3)
        .map((event) => event.payload)
        .slice(-3);
      const harnessAdaptationAgenda = harnessBenchmarkEvidence
        .map((payload) => (payload as { adaptation?: unknown }).adaptation)
        .filter((adaptation): adaptation is Record<string, unknown> => Boolean(adaptation && typeof adaptation === "object"))
        .slice(-1)[0];
      const harnessComponents = inventoryHarnessComponents(root);
      const harnessFailureProfile = Object.fromEntries(Object.entries(harnessBenchmarkEvidence
        .flatMap((payload) => Array.isArray((payload as { scorecards?: unknown }).scorecards) ? (payload as { scorecards: Array<{ failureProfile?: Record<string, number> }> }).scorecards : [])
        .flatMap((scorecard) => Object.entries(scorecard.failureProfile ?? {}))
        .reduce((counts, [failureClass, count]) => counts.set(failureClass, (counts.get(failureClass) ?? 0) + Number(count)), new Map<string, number>())));
      const harnessEvolutionPlan = planHarnessInterventions({
        inventory: harnessComponents,
        failureProfile: harnessFailureProfile,
        qualityGaps: durableEvents.slice(-20).filter((event) => event.type === "trajectory.capability_gaps").flatMap((event) => {
          const quality = (event.payload as { quality?: Record<string, { verdict?: string }> }).quality ?? {};
          return Object.entries(quality).filter(([, value]) => value?.verdict === "FAIL" || value?.verdict === "WARN").map(([key]) => key);
        }),
        benchmarkAvailable: harnessBenchmarkEvidence.length > 0,
      });
      store.appendEvent("harness.evolution.plan", { cycle, components: harnessComponents.map((component) => ({ id: component.id, path: component.path, kind: component.kind, checksum: component.checksum })), interventions: harnessEvolutionPlan, failureProfile: harnessFailureProfile });
      const harnessGuidance = harnessBenchmarkEvidence.length
        ? `Harness-evolution evidence from matched benchmark runs (diagnostic, not workspace task evidence): ${JSON.stringify(harnessBenchmarkEvidence).slice(0, 8_000)}. Prioritize these checksummed, falsifiable interventions and remeasure them under the same protocol: ${JSON.stringify(harnessEvolutionPlan).slice(0, 8_000)}${harnessAdaptationAgenda ? `\n\nLocked adaptive retest agenda (must be addressed before claiming a win): ${JSON.stringify(harnessAdaptationAgenda).slice(0, 8_000)}` : ""}`
        : `No matched harness benchmark evidence is recorded yet; preserve failure telemetry for the first comparison. The harness action space is inventory-backed; use these candidate intervention contracts when a failure is observed: ${JSON.stringify(harnessEvolutionPlan).slice(0, 8_000)}`;
      const recentTrajectories = store.trajectories(20);
      const recentQuality = recentTrajectories.map((entry) => qualityFeedback(entry.quality));
      const failureClasses = store.runs().slice(0, 20).map((entry) => (entry.payload as { failureClass?: unknown }).failureClass).filter((failureClass): failureClass is string => typeof failureClass === "string" && failureClass.length > 0);
      const recoveryRoutes = durableEvents
        .filter((event) => event.type === "experiment.recovery.route_changed")
        .slice(-5)
        .map((event) => event.payload as { experimentId?: unknown; routeKey?: unknown; failureClass?: unknown; instruction?: unknown; attempts?: unknown })
        .map((route) => `- experiment ${String(route.experimentId ?? "unknown")}: ${String(route.routeKey ?? route.failureClass ?? "unknown")} after ${String(route.attempts ?? "?")} attempt(s). ${String(route.instruction ?? "Choose an alternate route; do not replay the same manifest.")}`)
        .join("\n");
      const route = routeCapability({ objective: `${campaign.goal}. Stop condition: ${campaign.stopCondition}`, mode, provider: options.provider as "codex" | "local", autonomy, recentFailureCount: recentTrajectories.filter((entry) => (entry.quality as { overall?: string }).overall === "FAIL").length, recentQuality, budgetRemainingMinutes: Math.max(0, campaign.budgetMinutes - campaignElapsedMinutes(campaign)), requestedParallel: laneLimit });
      const effectiveLaneLimit = route.parallelLanes;
      store.appendEvent("research.capability_route", { route, predictedTier: route.tier, servedProvider: options.provider, servedModel: selectedModel, recentQuality });
      const evidenceConflicts = {
        contradictions: store.edges().filter((edge) => edge.relation === "contradicts").length,
        duplicates: store.recentEvents(200).filter((event) => event.type === "evidence.claim.duplicate_detected").length,
      };
      const allocation = allocateNextResearch({ trajectories: recentTrajectories, phase: phaseGoal?.phase, evidenceConflicts, failureClasses });
      store.appendEvent("research.next_allocation", { allocation, objective: `${campaign.goal}. Stop condition: ${campaign.stopCondition}` });
      const adaptiveHarness = deriveAdaptiveHarnessPolicy({
        quality: recentQuality as Array<{ overall?: string; toolUse?: { verdict?: string }; evidenceConsistency?: { verdict?: string }; errorRecovery?: { verdict?: string }; termination?: { verdict?: string } }>,
        failureClasses,
        evidenceConflicts: evidenceConflicts.contradictions + evidenceConflicts.duplicates,
        budgetRemainingMinutes: Math.max(0, campaign.budgetMinutes - campaignElapsedMinutes(campaign)),
        benchmarkInterventions: harnessEvolutionPlan.map((item) => ({ priority: item.priority >= 8 ? "critical" : item.priority >= 5 ? "high" : "normal" })),
      });
      store.appendEvent("research.adaptive_harness.policy", { cycle, policy: adaptiveHarness });
      const searchPolicy = rankSearchArms({
        arms: [
          ...DEFAULT_SEARCH_OPERATORS.map((operator, index) => {
            const activeCompetitionId = store.project()?.competitionId;
            const outcomes = store.recentEvents(500).filter((event) => {
              if (event.type !== "research.search.reward") return false;
              const payload = event.payload as { operator?: string; competitionId?: string };
              // Legacy rewards without a competition id remain usable for a
              // fresh project, but once a reward is scoped it must not leak
              // across unrelated competitions.
              const sameCompetition = payload.competitionId === undefined || payload.competitionId === activeCompetitionId;
              return payload.operator === operator && sameCompetition;
            });
            const rewards = outcomes.map((event) => Number((event.payload as { reward?: number }).reward)).filter(Number.isFinite);
            const observedCosts = outcomes.map((event) => Number((event.payload as { durationSeconds?: number }).durationSeconds) / 60).filter((minutes) => Number.isFinite(minutes) && minutes > 0);
            const meanReward = rewards.length ? rewards.reduce((sum, reward) => sum + reward, 0) / rewards.length : 0;
            const rewardVariance = rewards.length > 1 ? rewards.reduce((sum, reward) => sum + (reward - meanReward) ** 2, 0) / rewards.length : undefined;
            return { id: operator, operator, attempts: rewards.length, successes: rewards.filter((reward) => reward > 0).length, meanReward, rewardVariance, cost: observedCosts.length ? observedCosts.reduce((sum, minutes) => sum + minutes, 0) / observedCosts.length : DEFAULT_SEARCH_OPERATOR_COSTS[index], novelty: DEFAULT_SEARCH_OPERATOR_NOVELTY[index] };
          }),
        ],
        remainingBudgetMinutes: Math.max(0, campaign.budgetMinutes - campaignElapsedMinutes(campaign)),
        recentFailures: recentTrajectories.filter((entry) => (entry.quality as { overall?: string }).overall === "FAIL").length,
        evidenceConflicts: evidenceConflicts.contradictions + evidenceConflicts.duplicates,
      });
      store.appendEvent("research.search_policy.selected", {
        cycle,
        competitionId: store.project()?.competitionId,
        selected: searchPolicy[0],
        // Persist the complete bounded ranking so policy analysis can explain
        // both the chosen operator and the alternatives it rejected.
        ranked: searchPolicy,
        portfolio: searchPolicy.slice(0, 4),
        remainingBudgetMinutes: Math.max(0, campaign.budgetMinutes - campaignElapsedMinutes(campaign)),
        recentFailures: recentTrajectories.filter((entry) => (entry.quality as { overall?: string }).overall === "FAIL").length,
        evidenceConflicts: evidenceConflicts.contradictions + evidenceConflicts.duplicates,
      });
      const experienceRecords = recentTrajectories.map((entry) => buildExperienceRecord({ trajectoryId: entry.id, payload: entry.payload, quality: entry.quality as ReturnType<typeof evaluateTrajectory> }));
      const experienceMix = selectCurriculum(experienceRecords);
      const curriculumGuidance = experienceMix.map((stage) => `stage ${stage.stage}: ${stage.trajectoryIds.join(", ") || "none"} (${stage.rationale})`).join("; ");
      const replayContext = curriculumReplay(experienceRecords, experienceMix);
      const replayGuidance = replayContext.length
        ? replayContext.map((item) => `- ${item.trajectoryId}: ${item.outcome}/${item.quality}; objective=${item.objective}; acceptance=${item.acceptance}; evidence=${item.evidence.join(" | ") || "none"}; gaps=${item.gaps.join(" | ") || "none"}`).join("\n")
        : "- none";
      const criticConstraintGuidance = openCriticConstraint
        ? `\n\nOPEN CRITIC CONSTRAINT (${openCriticConstraint.verdict}):\n${openCriticConstraint.summary}\nObjections: ${openCriticConstraint.objections.join("; ") || "none listed"}\nRequired checks: ${openCriticConstraint.requiredChecks.join("; ") || "produce an independent evidence check"}\nDo not run or stop until these checks are addressed with durable evidence.`
        : "";
      const literatureGuidance = `Literature frontier: ${literatureFrontier.uniqueWorks} unique works discovered across ${literatureFrontier.queryCount} queries; ${literatureFrontier.retrievedWorks} retrieved; ${literatureFrontier.pendingWorks} pending. Treat pending works as search leads, not evidence. Deepen or broaden search when the objective still lacks primary support.`;
      const recoveryGuidance = recoveryRoutes ? `\n\nMANDATORY RECOVERY ROUTES FROM PRIOR FAILURES:\n${recoveryRoutes}\nDo not schedule the same experiment manifest or unchanged command after a terminal recovery directive. The next action must implement the listed alternate route and explain its falsification target.` : "";
      const allocatedObjective = `${campaign.goal}. Stop condition: ${campaign.stopCondition}\n\nEvidra capability allocation for this cycle:\nFocus: ${allocation.focus}\nPriority: ${allocation.priority}\nStrategy: ${allocation.strategy}\nReasons: ${allocation.reasons.join("; ")}\n\nEvidra search policy:\nPrioritize the '${searchPolicy[0]?.operator ?? "ucb_portfolio"}' operator (${searchPolicy[0]?.rationale ?? "portfolio default"}) while preserving at least one diverse alternative.\n\n${literatureGuidance}\n\n${harnessGuidance}\n\nEvidra experience curriculum guidance:\n${curriculumGuidance || "No prior experience; establish a clean baseline."}\n\nBounded experience replay (use as lessons, not proof):\n${replayGuidance}${recoveryGuidance}${criticConstraintGuidance}`;
      const priorRubricGaps = recentEvents
        .filter((event) => event.type === "research.rubric.assessed")
        .slice(-2)
        .flatMap((event) => ((event.payload as { gaps?: unknown }).gaps ?? []))
        .filter((gap): gap is string => typeof gap === "string");
      const rubricGuidance = priorRubricGaps.length
        ? `\n\nPrior decision-rubric gaps to repair before spending compute:\n${[...new Set(priorRubricGaps)].join("\n")}`
        : "";
      const cycleObjective = allocatedObjective + rubricGuidance;
      const researchSources = latestSourcePayloads(store.sources(), 12, cycleObjective);
      const researchMemory = researchMemoryContext(store, 30, cycleObjective);
      const peerLaneBoard = boundedPeerBoard(recentEvents);
      console.log(`${mode === "challenge" ? "Challenge" : "Research"} ${cycle} · inspecting workspace${mode === "challenge" ? " and baseline" : ""} (budget ${campaign.budgetMinutes}m)...`);
      const gitStatus = await runProcess(["git", "status", "--short"], root);
      const files = await runProcess(["rg", "--files", "-g", "!.sota/**", "-g", "!node_modules/**"], root, 60_000);
      const priorBaseline = mode === "challenge" ? store.recentEvents(100).reverse().find((event) => event.type === "baseline.completed") : undefined;
      let baseline: { command: string[]; cwd: string; exitCode: number; durationMs: number; stdout: string; stderr: string } | undefined;
      if (mode === "challenge" && options.skipBaseline && priorBaseline) {
        const payload = priorBaseline.payload as { command?: string[]; cwd?: string; exitCode?: number; durationMs?: number; stdout?: string; stderr?: string };
        baseline = { command: payload.command ?? adapter.baselineCommand(), cwd: payload.cwd ?? adapter.workspacePath(root), exitCode: payload.exitCode ?? 0, durationMs: payload.durationMs ?? 0, stdout: payload.stdout ?? "", stderr: payload.stderr ?? "" };
        console.log("Research · reusing the latest recorded baseline observation (--skip-baseline).");
      } else if (mode === "challenge") {
        if (options.skipBaseline) throw new Error("--skip-baseline requested, but no baseline.completed event exists. Run evidra baseline first.");
        baseline = await runProcess(adapter.baselineCommand(), adapter.workspacePath(root), adapter.config.evaluatorTimeoutMinutes * 60_000);
      }
      if (mode === "challenge" && baseline && !(options.skipBaseline && priorBaseline)) {
        const metric = parseMetricOutput(baseline.stdout, adapter.config.metric.name).metrics[adapter.config.metric.name] ?? null;
        recordBaselineEvidence(store, root, baseline, metric);
      }
      const observation = { gitStatus: gitStatus.stdout.trim().split("\n").filter(Boolean).slice(0, 40), repositoryFiles: files.stdout.trim().split("\n").filter(Boolean).slice(0, 120), ...(baseline ? { baseline: { exitCode: baseline.exitCode, durationMs: baseline.durationMs, stdout: redactSecrets(baseline.stdout.slice(-4000)), stderr: redactSecrets(baseline.stderr.slice(-4000)) } } : {}) };
      store.appendEvent("research.observation", observation);
      store.saveClaim({ id: `claim_observation_${Date.now()}`, payload: { statement: "Repository inspection and canonical baseline execution completed before the research decision.", scope: "current-workspace", confidence: 1, sourceType: "observation", sourceId: `observation_${Date.now()}`, status: "active", observation } });
      store.close();
      const projectStore = new ResearchStore(statePath);
      const activeProject = projectStore.project();
      projectStore.close();
      let decision: Awaited<ReturnType<typeof runResearchDirector>>;
      let criticReview: Awaited<ReturnType<typeof runResearchCritic>> | undefined;
      let laneReports: Awaited<ReturnType<typeof runResearchLanes>> = [];
      const toolTrace = createToolTraceRecorder(`research-${cycle}`);
      let researchAttempt = 0;
      // Keep the complete cycle guidance on the first attempt. Retries replace
      // this objective with an explicit alternate-route instruction so a
      // provider/tool failure cannot silently replay the same route.
      let agentObjective = cycleObjective;
      const remainingBudgetMs = Math.max(10_000, campaign.budgetMinutes * 60_000 - (Date.now() - started));
      const agentTimeoutMs = Math.max(10_000, Math.min(3 * 60_000, remainingBudgetMs));
      while (true) {
        try {
          console.log("Research · independent lanes are investigating the evidence...");
          laneReports = await runResearchLanes(agentObjective, {
            project: activeProject,
            competition: adapter.config,
            observation,
            recentEvents,
            researchSources,
            harnessBenchmarkEvidence,
            harnessEvolutionPlan,
            harnessAdaptationAgenda: harnessAdaptationAgenda ?? null,
            ultimateGoal: options.goal,
            phaseGoal: phaseGoal ?? null,
            allocation,
            evidenceConflicts,
            researchMemory,
            experienceReplay: replayContext,
            literatureFrontier,
            openCriticConstraint,
            peerLaneBoard,
          }, {
            provider: options.provider,
            model: selectedModel,
            modelPool: researchModelPool,
            fallbackLocalModel: options.limitPolicy === "fallback" || options.limitPolicy === "auto" ? (process.env.EVIDRA_FALLBACK_MODEL ?? "auto") : undefined,
            limitPolicy: options.limitPolicy as "auto" | "wait" | "fallback" | "stop",
            reasoningEffort: options.thinking,
            timeoutMs: agentTimeoutMs,
            cwd: root,
            storePath: statePath,
            maxParallel: effectiveLaneLimit,
            autonomy,
            executeTool: researchToolExecutor(adapter, autonomy),
            onToolCall: toolTrace.onToolCall,
            onToolResult: toolTrace.onToolResult,
          });
          let crossPollination = synthesizeLaneReports(laneReports);
          // Independent groups should be able to challenge one another before
          // the director commits to an experiment. Keep this bounded: the
          // second pass is only activated for a genuinely uncertain board and
          // only when the selected autonomy level can afford parallel review.
          if ((crossPollination.needsAdversarialReview || adaptiveHarness.peerReview) && laneReports.filter((lane) => lane.status === "completed").length > 1 && autonomy !== "safe") {
            console.log("Research · evidence is contested; independent lanes are peer-reviewing the board...");
            const peerReports = await runResearchLanes(
              `${agentObjective}\n\nPeer-review the supplied lane board. Challenge unsupported agreements, resolve tensions where primary evidence permits, and identify the cheapest discriminating test. Do not repeat workspace inspection unless the board exposes a specific evidence gap.`,
              {
                project: activeProject,
                competition: adapter.config,
                observation,
                recentEvents,
                researchSources,
                harnessAdaptationAgenda: harnessAdaptationAgenda ?? null,
                ultimateGoal: options.goal,
                phaseGoal: phaseGoal ?? null,
                allocation,
                evidenceConflicts,
                researchMemory,
                peerLaneBoard: crossPollination,
                priorLaneReports: laneReports.map((lane) => ({ role: lane.role, summary: lane.summary, findings: lane.findings, uncertainties: lane.uncertainties, evidence: lane.evidence })),
              },
              {
                provider: options.provider,
                model: selectedModel,
                modelPool: researchModelPool,
                fallbackLocalModel: options.limitPolicy === "fallback" || options.limitPolicy === "auto" ? (process.env.EVIDRA_FALLBACK_MODEL ?? "auto") : undefined,
                limitPolicy: options.limitPolicy as "auto" | "wait" | "fallback" | "stop",
                reasoningEffort: options.thinking,
                timeoutMs: agentTimeoutMs,
                cwd: root,
                storePath: statePath,
                maxParallel: effectiveLaneLimit,
                autonomy,
                // The first pass already collected bounded workspace evidence;
                // the peer pass reasons over that evidence rather than
                // multiplying shell calls.
                onToolCall: toolTrace.onToolCall,
                onToolResult: toolTrace.onToolResult,
              },
            );
            laneReports = [
              ...laneReports,
              ...peerReports.map((lane) => ({ ...lane, role: `${lane.role} peer-review` })),
            ];
            crossPollination = synthesizeLaneReports(laneReports);
            const peerStore = new ResearchStore(statePath);
            peerStore.appendEvent("research.peer_review.completed", { cycle, initialBoard: synthesizeLaneReports(laneReports.slice(0, -peerReports.length)), board: crossPollination, reviewers: peerReports.map((lane) => lane.role) });
            peerStore.close();
          }
          const crossPollinationStore = new ResearchStore(statePath);
          crossPollinationStore.appendEvent("research.cross_pollination.completed", { cycle, board: crossPollination });
          crossPollinationStore.close();
          console.log("Research · director is cross-pollinating lane findings...");
          decision = await runResearchDirector(agentObjective, { project: activeProject, competition: adapter.config, constraints: { research_agents_no_file_edits: true, no_submission: true, controller_executes_isolated_experiments: autonomyPolicy(autonomy).canRunIsolatedExperiments }, recentEvents, researchSources, observation, ultimateGoal: campaign.goal, phaseGoal: phaseGoal ?? null, allocation, evidenceConflicts, laneReports, crossPollination, researchMemory, experienceReplay: replayContext, literatureFrontier, harnessBenchmarkEvidence, harnessEvolutionPlan, harnessAdaptationAgenda: harnessAdaptationAgenda ?? null, openCriticConstraint, adaptiveHarnessPolicy: adaptiveHarness }, { provider: options.provider, model: selectedModel, reasoningEffort: options.thinking, timeoutMs: agentTimeoutMs, limitPolicy: options.limitPolicy as "auto" | "wait" | "fallback" | "stop", fallbackLocalModel: options.limitPolicy === "fallback" || options.limitPolicy === "auto" ? (process.env.EVIDRA_FALLBACK_MODEL ?? "auto") : undefined, cwd: root, executeTool: researchToolExecutor(adapter, autonomy), maxToolRounds: adaptiveHarness.maxToolRounds, maxToolAttempts: adaptiveHarness.maxToolAttempts, onToolCall: toolTrace.onToolCall, onToolResult: toolTrace.onToolResult });
          criticReview = await runResearchCritic(cycleObjective, decision, laneReports, {
            provider: options.provider,
            model: selectedModel,
            fallbackLocalModel: options.limitPolicy === "fallback" || options.limitPolicy === "auto" ? (process.env.EVIDRA_FALLBACK_MODEL ?? "auto") : undefined,
            limitPolicy: options.limitPolicy as "auto" | "wait" | "fallback" | "stop",
            reasoningEffort: options.thinking,
            timeoutMs: agentTimeoutMs,
            cwd: root,
            storePath: statePath,
            maxParallel: 1,
            autonomy,
          });
          break;
        } catch (error) {
          if (isProviderUsageLimit(error)) {
            if (options.limitPolicy !== "wait" && options.limitPolicy !== "auto") throw error;
            const delay = providerRetryAfterMs(error);
            const remainingMs = budget * 60_000 - (Date.now() - started);
            if (remainingMs <= 0) throw new Error("Research budget expired while waiting for the provider usage limit to reset.");
            const waitMs = Math.min(delay, remainingMs);
            console.log(`Provider usage limit reached; waiting ${Math.ceil(waitMs / 60_000)} minute(s) before retrying. Campaign state is durable.`);
            await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
            continue;
          }
          const routeError = error instanceof Error ? error.message : String(error);
          // A provider timeout is already the bounded alternate route. Do not
          // multiply it through lane, director, and outer-cycle retries after
          // the campaign has spent its allotted turn budget.
          const routeTimedOut = /request timed out|campaign budget expired/i.test(routeError);
          researchAttempt += 1;
          if (routeTimedOut || Date.now() - started >= budget * 60_000 || !isRetryableAgentError(error) || researchAttempt >= 3) {
            const failure = researchFailureRecord(cycle, error, toolTrace.events, laneReports.filter((lane) => lane.status === "failed"));
            const failureStore = new ResearchStore(statePath);
            failureStore.appendEvent("research.agent.failed", { cycle, error: failure.error, attempts: researchAttempt, quality: failure.quality });
            failureStore.saveTrajectory({ id: `trajectory_${failure.events.at(-1)?.id ?? Date.now()}`, payload: { objective, cycle, status: "failed", error: failure.error, events: failure.events }, quality: failure.quality });
            const savedCampaign = failureStore.campaign() as { status?: string } | undefined;
            if (savedCampaign?.status === "running") {
              const paused = pauseCampaign(savedCampaign as typeof campaign);
              failureStore.saveCampaign(paused);
              failureStore.setSchedulerState({ status: "paused", mode, currentStep: "agent-failed" });
              failureStore.appendEvent("research.campaign.paused", { cycle, reason: "agent route exhausted", resumeWith: "the saved campaign and failure trajectory" });
            }
            failureStore.close();
            throw error;
          }
          const message = error instanceof Error ? error.message : String(error);
          agentObjective = `${cycleObjective}\n\nBounded retry ${researchAttempt}: the previous research-agent route failed with '${message}'. Inspect the failure evidence and deliberately choose an alternate route instead of repeating it unchanged.`;
          const retryStore = new ResearchStore(statePath);
          retryStore.appendEvent("research.agent.retrying", { attempt: researchAttempt + 1, previousError: message, strategy: "alternate-route" });
          retryStore.close();
          const delay = researchAttempt * 1_000;
          console.log(`Research agent route failed; replanning in ${delay / 1000}s (retry ${researchAttempt}/2)...`);
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
        }
      }
      let decisionStore = new ResearchStore(statePath);
      // In autonomous modes, a single concrete proposal plus a non-rejecting
      // critic is enough to enter the controller's bounded execution path.
      // Without this transition a director can repeatedly emit `propose`
      // forever even though it has already supplied the exact hypothesis the
      // controller needs. Safe mode deliberately remains approval-gated.
      if (autonomyPolicy(autonomy).canRunIsolatedExperiments && criticReview?.verdict !== "reject" && decision.decision === "propose" && !decision.selectedHypothesis && decision.hypotheses.length === 1) {
        const selected = decision.hypotheses[0];
        decision = {
          ...decision,
          decision: "run",
          selectedHypothesis: selected.title,
          nextAction: `Execute the single concrete hypothesis in an isolated worktree: ${selected.title}.`,
        };
        decisionStore.appendEvent("research.autonomous.execution_promoted", { reason: "single concrete proposal with non-rejecting critic", hypothesis: selected.title, autonomy });
      }
      const criticGate = applyCriticGate(decision, criticReview);
      const criticBlocks = criticGate.blocked;
      if (criticBlocks) {
        decisionStore.appendEvent("research.critic.gate", { verdict: criticReview?.verdict, confidence: criticReview?.confidence, objections: criticReview?.objections, requiredChecks: criticReview?.requiredChecks });
        decision = criticGate.decision;
      }
      const decisionRubric = assessResearchDecisionRubric(decision, {
        baselineAvailable: Boolean(observation.baseline?.exitCode === 0),
        sourceCount: researchSources.length,
        evidenceConflicts: evidenceConflicts.contradictions + evidenceConflicts.duplicates,
      });
      decisionStore.appendEvent("research.rubric.assessed", {
        cycle,
        score: decisionRubric.score,
        threshold: decisionRubric.threshold,
        verdict: decisionRubric.verdict,
        criteria: decisionRubric.criteria,
        gaps: decisionRubric.gaps,
      });
      decision = enforceGoalTermination(decision);
      const claimAudit = auditCurrentClaims(decisionStore);
      const claimGateBefore = decision;
      decision = enforceClaimTermination(decision, claimAudit);
      if (decision !== claimGateBefore) decisionStore.appendEvent("research.claim_gate.rejected", { ...claimAudit, phase: phaseGoal?.phase ?? null });
      if (phaseGoal && decision.goalStatus === "met") {
        const phaseEvents = decisionStore.recentEvents(500);
        const gate = evaluatePhaseGoalEvidence(phaseGoal, {
          mode,
          eventTypes: phaseEvents.map((event) => event.type),
          eventPayloads: phaseEvents.map((event) => ({ type: event.type, payload: event.payload })),
          ...decisionStore.counts(),
          candidateHypotheses: decision.hypotheses.length,
        });
        if (!gate.met) {
          decision = { ...decision, goalStatus: "active", nextAction: decision.nextAction + " (phase gate missing: " + gate.missing.join(", ") + ")" };
          decisionStore.appendEvent("research.phase_gate.rejected", { phase: phaseGoal.phase, missing: gate.missing });
        }
      }
      const materialized = materializeResearchDecision(decisionStore, decision);
      const hypothesisQuality = decision.hypotheses.map((hypothesis) => assessHypothesisQuality({
        title: hypothesis.title,
        mechanism: hypothesis.mechanism,
        evidence: hypothesis.evidence,
        proposedChange: hypothesis.proposedChange,
        falsificationTest: hypothesis.falsificationTest,
        expectedDelta: hypothesis.expectedMetricDelta.median,
        costGpuHours: hypothesis.computeCostGpuHours,
        implementationRisk: hypothesis.implementationRisk,
        leakageRisk: hypothesis.leakageRisk,
      }));
      decisionStore.appendEvent("research.hypothesis_quality.assessed", { cycle, hypotheses: decision.hypotheses.map((hypothesis, index) => ({ title: hypothesis.title, ...hypothesisQuality[index] })) });
      const portfolioBudget = Math.max(1, campaign.budgetMinutes - campaignElapsedMinutes(campaign));
      const costHistory: CostObservation[] = decisionStore.recentEvents(2_000).flatMap((event) => {
        if (event.type !== "research.search.reward") return [];
        const payload = event.payload as { operator?: unknown; durationSeconds?: unknown; valid?: unknown };
        if (typeof payload.operator !== "string" || typeof payload.durationSeconds !== "number" || !Number.isFinite(payload.durationSeconds) || payload.durationSeconds <= 0) return [];
        return [{ operator: payload.operator, actualMinutes: payload.durationSeconds / 60, status: payload.valid === true ? "completed" : "failed", context: { executor: typeof (payload as { executor?: unknown }).executor === "string" ? (payload as { executor: string }).executor : undefined, gpu: typeof (payload as { gpu?: unknown }).gpu === "string" ? (payload as { gpu: string }).gpu : undefined, provider: typeof (payload as { provider?: unknown }).provider === "string" ? (payload as { provider: string }).provider : undefined, model: typeof (payload as { model?: unknown }).model === "string" ? (payload as { model: string }).model : undefined } }];
      });
      const portfolioPlan = planPortfolio(decision.hypotheses.map((hypothesis, index) => ({
        id: materialized.hypothesisIds[index] ?? `hypothesis-${index}`,
        title: hypothesis.title,
        // A single director operator describes the cycle; hypotheses still
        // need distinct search families so best-of-k does not collapse into
        // repeated variants of the same move.
        operator: index === 0 ? decision.searchOperator : (["evolutionary", "mcts", "ablation", "combination", "replication", "audit"] as const)[(index - 1) % 6],
        expectedValue: hypothesis.expectedMetricDelta.median,
        costMinutes: Math.max(1, hypothesis.computeCostGpuHours * 60),
        novelty: hypothesis.evidence.length === 0 ? 1 : 0.4,
        risk: hypothesis.implementationRisk === "high" ? 1 : hypothesis.implementationRisk === "medium" ? 0.5 : 0.1,
        family: hypothesis.formulationFamily,
        quality: hypothesisQuality[index]?.score,
      })), {
        maxCandidates: autonomy === "yolo" ? 3 : autonomy === "fast" ? 2 : 1,
        maxParallel: effectiveLaneLimit,
        budgetMinutes: portfolioBudget,
        reserveMinutes: Math.min(5, portfolioBudget * 0.1),
        costHistory,
        executionContext: { executor: options.executor },
      });
      decisionStore.appendEvent("research.portfolio.planned", {
        cycle,
        selected: portfolioPlan.selected,
        rejected: portfolioPlan.rejected,
        reservedMinutes: portfolioPlan.reservedMinutes,
        parallelism: portfolioPlan.parallelism,
        successiveHalving: portfolioPlan.halving,
        costEstimates: portfolioPlan.costEstimates,
        policy: "bounded-best-of-k",
      });
      // A director may return several hypotheses without selecting one. In an
      // autonomous campaign, promote the portfolio's highest value-per-minute
      // candidate; safe mode keeps the normal approval gate.
      if (autonomyPolicy(autonomy).canRunIsolatedExperiments && criticReview?.verdict !== "reject" && !decision.selectedHypothesis && portfolioPlan.selected[0]) {
        const promoted = decision.hypotheses[materialized.hypothesisIds.indexOf(portfolioPlan.selected[0].id)];
        if (promoted) {
          decision = { ...decision, decision: "run", selectedHypothesis: promoted.title, nextAction: `Execute the highest-ranked bounded portfolio candidate: ${promoted.title}.` };
          decisionStore.appendEvent("research.autonomous.execution_promoted", { reason: "bounded portfolio ranking", hypothesis: promoted.title, portfolioSize: portfolioPlan.selected.length, autonomy });
        }
      }
      const policyBlocksExecution = !autonomyPolicy(autonomy).canRunIsolatedExperiments && decision.decision === "run" && Boolean(decision.selectedHypothesis);
      if (policyBlocksExecution) {
        const selectedIndex = decision.hypotheses.findIndex((hypothesis) => hypothesis.title === decision.selectedHypothesis);
        const selectedHypothesisId = selectedIndex >= 0 ? materialized.hypothesisIds[selectedIndex] : undefined;
        const selectedHypothesis = selectedIndex >= 0 ? decision.hypotheses[selectedIndex] : undefined;
        const existingProposal = selectedHypothesis
          ? decisionStore.experiments().find((entry) => {
            const payload = entry.payload as { hypothesisId?: unknown; status?: unknown };
            return payload.hypothesisId === selectedHypothesisId && payload.status === "proposed";
          })
          : undefined;
        let proposalId = existingProposal?.id;
        if (!proposalId && selectedHypothesisId && selectedHypothesis) {
          const commit = await runProcess(["git", "rev-parse", "HEAD"], root);
          if (commit.exitCode === 0) {
            proposalId = `exp_${Date.now()}_${selectedHypothesisId.slice(-32)}`;
            const proposal = createExperimentManifest({
              id: proposalId,
              hypothesisId: selectedHypothesisId,
              outcomeType: selectedHypothesis.outcomeType,
              gitCommit: commit.stdout.trim(),
              datasetVersion: adapter.config.datasetRevision,
              executor: options.executor as "local" | "container" | "modal",
              searchOperator: decision.searchOperator,
              configPatch: { estimatorPath: candidateEstimatorPath(selectedHypothesis) ?? adapter.config.evaluator.estimatorPath },
            }, adapter.config);
            decisionStore.saveExperiment({ id: proposalId, payload: { ...proposal, status: "proposed", executionPlan: createExecutionPlan(proposal) } });
          }
        }
        decisionStore.appendEvent("experiment.autonomous.approval_required", { experimentId: proposalId, decision: decision.decision, selectedHypothesis: decision.selectedHypothesis, autonomy, nextAction: proposalId ? `Run evidra experiment run ${proposalId} after approval.` : "Create an explicit experiment proposal before execution." });
        console.log(`Autonomous experiment held by ${autonomy.toUpperCase()} permissions${proposalId ? `; proposal ${proposalId} is ready for explicit approval. Continuing research on other directions.` : ". Continuing evidence gathering."}`);
      }
      const selectedDecisionIndex = decision.hypotheses.findIndex((hypothesis) => hypothesis.title === decision.selectedHypothesis);
      const selectedDecisionCandidate = selectedDecisionIndex >= 0 ? portfolioPlan.selected.find((candidate) => candidate.id === materialized.hypothesisIds[selectedDecisionIndex]) ?? {
        id: materialized.hypothesisIds[selectedDecisionIndex],
        title: decision.hypotheses[selectedDecisionIndex].title,
        operator: decision.searchOperator,
        expectedValue: decision.hypotheses[selectedDecisionIndex].expectedMetricDelta.median,
        costMinutes: Math.max(1, decision.hypotheses[selectedDecisionIndex].computeCostGpuHours * 60),
        family: decision.hypotheses[selectedDecisionIndex].formulationFamily,
        quality: hypothesisQuality[selectedDecisionIndex]?.score,
      } : undefined;
      const executionCandidates = !criticBlocks && !policyBlocksExecution && decision.decision === "run" && decision.selectedHypothesis && autonomyPolicy(autonomy).canRunIsolatedExperiments
        ? (portfolioPlan.selected.length ? portfolioPlan.selected : selectedDecisionCandidate ? [selectedDecisionCandidate] : [])
        : [];
      const halvingEnabled = executionCandidates.length > 1 && portfolioPlan.halving.feasible && portfolioPlan.halving.stages.length > 1;
      const screenedCandidates: Array<{ experimentId: string; metric?: number; valid: boolean }> = [];
      const finalizeAutonomousRun = async (experimentId: string, run: { exitCode: number; stdout: string; stderr: string }): Promise<void> => {
        const completionStore = new ResearchStore(statePath);
        completionStore.appendEvent(run.exitCode === 0 ? "experiment.autonomous.completed" : "experiment.autonomous.failed", { experimentId, exitCode: run.exitCode, stdout: run.stdout.slice(-4000), stderr: run.stderr.slice(-4000) });
        const comparisonEvent = completionStore.recentEvents(500).reverse().find((event) => event.type === "experiment.comparison.completed" && (event.payload as { experimentId?: unknown }).experimentId === experimentId);
        const comparison = comparisonEvent?.payload as { comparison?: { direction?: string } } | undefined;
        const parent = completionStore.experiments().find((entry) => entry.id === experimentId);
        const parentManifest = parent ? ExperimentManifestSchema.safeParse(parent.payload) : undefined;
        if (run.exitCode === 0 && comparison?.comparison?.direction === "improved" && parentManifest?.success && parentManifest.data.acceptance.requireReplication) {
          const hypothesisPayload = parentManifest.data.hypothesisId
            ? completionStore.hypotheses().find((entry) => entry.id === parentManifest.data.hypothesisId)?.payload as { ablationFactors?: unknown } | undefined
            : undefined;
          const ablationFactors = Array.isArray(hypothesisPayload?.ablationFactors) ? hypothesisPayload.ablationFactors : [];
          const ablationPlan = decision.searchOperator === "ablation" && ablationFactors.length
            ? createAblationPlan({ hypothesisId: parentManifest.data.hypothesisId, factors: ablationFactors as Parameters<typeof createAblationPlan>[0]["factors"] })
            : undefined;
          if (ablationPlan) {
            const ablationIds: string[] = [];
            for (const variant of ablationPlan.variants.filter((candidate) => !candidate.control).slice(0, 4)) {
              const ablationId = `abl_${experimentId}_${variant.factorId}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 96);
              const existing = completionStore.experiments().find((entry) => entry.id === ablationId);
              if (existing) { ablationIds.push(ablationId); continue; }
              const ablationManifest = createExperimentManifest({
                id: ablationId,
                parent: experimentId,
                hypothesisId: parentManifest.data.hypothesisId,
                outcomeType: parentManifest.data.outcomeType,
                gitCommit: parentManifest.data.gitCommit,
                datasetVersion: parentManifest.data.datasetVersion,
                splitVersion: parentManifest.data.splitVersion,
                executor: parentManifest.data.resources.executor,
                image: parentManifest.data.resources.image,
                gpu: parentManifest.data.resources.gpu,
                timeoutMinutes: parentManifest.data.resources.timeoutMinutes,
                folds: parentManifest.data.evaluation.folds,
                seeds: parentManifest.data.evaluation.seeds,
                requiredArtifacts: parentManifest.data.evaluation.requiredArtifacts,
                verificationCommand: parentManifest.data.evaluation.verificationCommand,
                verificationCommands: parentManifest.data.evaluation.verificationCommands,
                minimumPrimaryDelta: parentManifest.data.acceptance.minimumPrimaryDelta,
                maximumRegressionShift: parentManifest.data.acceptance.maximumRegressionShift,
                requireReplication: false,
                searchOperator: "ablation",
                configPatch: { ...parentManifest.data.change.configPatch, ...variant.configPatch },
              }, adapter.config);
              completionStore.saveExperiment({ id: ablationId, payload: { ...ablationManifest, status: "proposed", ablationOf: experimentId, ablationFactorId: variant.factorId, ablationLabel: variant.label, executionPlan: createExecutionPlan(ablationManifest) } });
              completionStore.appendEvent("research.ablation.variant.scheduled", { parentId: experimentId, experimentId: ablationId, factorId: variant.factorId, label: variant.label, plan: ablationPlan });
              ablationIds.push(ablationId);
            }
            completionStore.appendEvent("research.ablation.plan", ablationPlan);
            console.log(`Ablation plan scheduled: ${ablationIds.join(", ")}`);
            completionStore.close();
            for (const ablationId of ablationIds) {
              const ablationRun = await runCampaignExperiment(root, ablationId);
              const ablationStore = new ResearchStore(statePath);
              ablationStore.appendEvent(ablationRun.exitCode === 0 ? "research.ablation.variant.completed" : "research.ablation.variant.failed", { parentId: experimentId, experimentId: ablationId, exitCode: ablationRun.exitCode, stdout: ablationRun.stdout.slice(-4000), stderr: ablationRun.stderr.slice(-4000) });
              ablationStore.close();
            }
          } else {
            completionStore.close();
          }
          const replication = createReplicationManifest(parentManifest.data, adapter.config);
          const replicationSetupStore = new ResearchStore(statePath);
          replicationSetupStore.saveExperiment({ id: replication.id, payload: { ...replication, status: "proposed", replicationOf: experimentId, automatic: true, executionPlan: createExecutionPlan(replication) } });
          replicationSetupStore.appendEvent("replication.manifest.created", { parentId: experimentId, replicationId: replication.id, automatic: true });
          console.log(`Independent replication scheduled: ${replication.id}\n${manifestSummary(replication)}`);
          replicationSetupStore.close();
          const replicationRun = await runCampaignExperiment(root, replication.id);
          const replicationStore = new ResearchStore(statePath);
          replicationStore.appendEvent(replicationRun.exitCode === 0 ? "experiment.autonomous.replication.completed" : "experiment.autonomous.replication.failed", { parentId: experimentId, replicationId: replication.id, exitCode: replicationRun.exitCode, stdout: replicationRun.stdout.slice(-4000), stderr: replicationRun.stderr.slice(-4000) });
          const replicationComparisonEvent = replicationStore.recentEvents(500).reverse().find((event) => event.type === "experiment.comparison.completed" && (event.payload as { experimentId?: unknown }).experimentId === replication.id);
          const replicationComparison = replicationComparisonEvent?.payload as { comparison?: { direction?: unknown } } | undefined;
          const replicationHypothesisPayload = parentManifest.data.hypothesisId
            ? replicationStore.hypotheses().find((entry) => entry.id === parentManifest.data.hypothesisId)?.payload as { title?: unknown; formulationFamily?: unknown; mechanism?: unknown; proposedChange?: unknown } | undefined
            : undefined;
          if (replicationRun.exitCode === 0 && replicationComparison?.comparison?.direction === "improved" && replicationHypothesisPayload) {
            replicationStore.appendEvent("research.method.transferable", createTransferableMethod({
              id: `method_${experimentId}`,
              sourceCompetition: adapter.id,
              sourceTaskType: adapter.config.taskType,
              title: typeof replicationHypothesisPayload.title === "string" ? replicationHypothesisPayload.title : parentManifest.data.hypothesisId,
              formulationFamily: typeof replicationHypothesisPayload.formulationFamily === "string" ? replicationHypothesisPayload.formulationFamily : "other",
              mechanism: typeof replicationHypothesisPayload.mechanism === "string" ? replicationHypothesisPayload.mechanism : "",
              proposedChange: typeof replicationHypothesisPayload.proposedChange === "string" ? replicationHypothesisPayload.proposedChange : "",
              evidenceIds: [experimentId, replication.id],
              tags: [adapter.config.taskType, typeof replicationHypothesisPayload.formulationFamily === "string" ? replicationHypothesisPayload.formulationFamily : "other"],
            }));
          }
          replicationStore.close();
        } else {
          completionStore.close();
        }
        decisionStore = new ResearchStore(statePath);
      };
      for (const portfolioCandidate of executionCandidates) {
        const selectedIndex = materialized.hypothesisIds.indexOf(portfolioCandidate.id);
        const selectedHypothesisId = selectedIndex >= 0 ? materialized.hypothesisIds[selectedIndex] : undefined;
        const selectedHypothesis = selectedIndex >= 0 ? decision.hypotheses[selectedIndex] : undefined;
        const hypothesisAlreadyScheduled = selectedHypothesis
          ? decisionStore.experiments().some((entry) => {
            const payload = entry.payload as { hypothesisId?: string; status?: string };
            const hypothesis = payload.hypothesisId ? decisionStore.hypotheses().find((candidate) => candidate.id === payload.hypothesisId) : undefined;
            return hypothesis && (hypothesis.payload as { title?: unknown }).title === selectedHypothesis.title;
          })
          : false;
        if (selectedHypothesisId && selectedHypothesis && !hypothesisAlreadyScheduled) {
          const commit = await runProcess(["git", "rev-parse", "HEAD"], root);
          if (commit.exitCode === 0) {
            const experimentId = `exp_${Date.now()}_${selectedHypothesisId.slice(-32)}`;
            const manifest = createExperimentManifest({
              id: experimentId,
              hypothesisId: selectedHypothesisId,
              outcomeType: selectedHypothesis.outcomeType,
              gitCommit: commit.stdout.trim(),
              datasetVersion: adapter.config.datasetRevision,
              executor: options.executor as "local" | "container" | "modal",
              searchOperator: decision.searchOperator,
              configPatch: { estimatorPath: candidateEstimatorPath(selectedHypothesis) ?? adapter.config.evaluator.estimatorPath },
            }, adapter.config);
            decisionStore.saveExperiment({ id: experimentId, payload: { ...manifest, status: "proposed", executionPlan: createExecutionPlan(manifest) } });
            decisionStore.appendEvent("experiment.autonomous.scheduled", { experimentId, hypothesisId: selectedHypothesisId, decision: decision.decision, executor: options.executor });
            console.log(`Autonomous experiment scheduled: ${experimentId}\n${manifestSummary(manifest)}`);
            decisionStore.close();
            let run: { exitCode: number; stdout: string; stderr: string };
            try {
              await implementCampaignHypothesis(root, experimentId, selectedHypothesis, manifest, { provider: options.provider as "codex" | "local", model: selectedModel, thinking: options.thinking, protectedCommands: [adapter.config.evaluator.command] });
              if (halvingEnabled) {
                run = await runCampaignExperiment(root, experimentId, "reduced");
                const screenStore = new ResearchStore(statePath);
                const screenEvent = screenStore.recentEvents(500).reverse().find((event) => event.type === "experiment.screening.completed" && (event.payload as { experimentId?: unknown }).experimentId === experimentId);
                const screenPayload = screenEvent?.payload as { metric?: unknown } | undefined;
                const metric = typeof screenPayload?.metric === "number" && Number.isFinite(screenPayload.metric) ? screenPayload.metric : undefined;
                screenedCandidates.push({ experimentId, metric, valid: run.exitCode === 0 && metric !== undefined });
                screenStore.appendEvent(run.exitCode === 0 ? "experiment.autonomous.screened" : "experiment.autonomous.screening_failed", { experimentId, metric: metric ?? null, exitCode: run.exitCode });
                screenStore.close();
                decisionStore = new ResearchStore(statePath);
                continue;
              }
              run = await runCampaignExperiment(root, experimentId);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const failedImplementationStore = new ResearchStore(statePath);
              const failedEntry = failedImplementationStore.experiments().find((entry) => entry.id === experimentId);
              if (failedEntry) failedImplementationStore.saveExperiment({ id: experimentId, payload: { ...(failedEntry.payload as Record<string, unknown>), status: "failed" } });
              failedImplementationStore.appendEvent("experiment.autonomous.implementation.failed", { experimentId, error: message });
              failedImplementationStore.close();
              run = { exitCode: 1, stdout: "", stderr: message };
            }
            await finalizeAutonomousRun(experimentId, run);
          }
        }
      }
      if (halvingEnabled) {
        const screeningStage = portfolioPlan.halving.stages[0];
        const promoted = promoteHalvingStage(screeningStage, screenedCandidates.map((candidate) => ({ id: candidate.experimentId, metric: candidate.metric, valid: candidate.valid })), adapter.config.metric.direction);
        const promotionStore = new ResearchStore(statePath);
        promotionStore.appendEvent("research.portfolio.screening_promoted", { cycle, stage: screeningStage.index, candidates: screenedCandidates, promoted, retainCount: screeningStage.retainCount, direction: adapter.config.metric.direction });
        promotionStore.close();
        for (const candidate of screenedCandidates.filter((entry) => promoted.includes(entry.experimentId))) {
          const fullRun = await runCampaignExperiment(root, candidate.experimentId, "full-after-screen");
          await finalizeAutonomousRun(candidate.experimentId, fullRun);
        }
      }
      const trajectoryStamp = `research-${Date.now()}`;
      const researchTrajectoryEvents: TrajectoryEvent[] = [
        { id: `${trajectoryStamp}-observation`, kind: "process", payload: { status: "completed", observationKeys: Object.keys(observation) } },
        ...toolTrace.events,
        ...laneReports.filter((lane) => lane.status === "failed").map((lane, index) => ({ id: `${trajectoryStamp}-lane-${index}`, kind: "process" as const, payload: { status: "failed", error: lane.error ?? `${lane.role} failed` } })),
        { id: `${trajectoryStamp}-evaluator`, kind: "evaluator", payload: {
          evidenceConsistent: criticReview?.verdict === "proceed",
          criticVerdict: criticReview?.verdict ?? "missing",
          // A failed inspection route must not be silently converted into an
          // execution decision. Record this explicitly for harness scoring.
          executionAlignment: toolTrace.events.some((event) => event.kind === "tool_result")
            ? toolTrace.events.some((event) => event.kind === "tool_result" && event.payload.ok === true)
            : undefined,
        } },
        { id: `${trajectoryStamp}-terminal`, kind: "terminal", payload: { status: "completed", goalStatus: decision.goalStatus, goalAttained: decision.goalStatus === "met" || decision.decision === "stop" } },
      ];
      const researchQuality = evaluateTrajectory(researchTrajectoryEvents);
      const routingOutcome = capabilityOutcome({ objective: allocatedObjective, mode, route, provider: options.provider, model: selectedModel, quality: researchQuality, parallelLanes: effectiveLaneLimit });
      const trajectoryId = `trajectory_research_${Date.now()}`;
      const trajectoryPayload = { objective, observation, laneReports, criticReview, decision, routing: { predictedTier: route.tier, tierScores: route.tierScores, provider: options.provider, model: selectedModel }, events: researchTrajectoryEvents };
      decisionStore.saveTrajectory({ id: trajectoryId, payload: trajectoryPayload, quality: researchQuality });
      const experience = buildExperienceRecord({ trajectoryId, payload: trajectoryPayload, quality: researchQuality, routing: { predictedTier: route.tier, tierScores: route.tierScores, provider: options.provider, model: selectedModel } });
      const priorExperiences = decisionStore.trajectories(100).filter((entry) => entry.id !== trajectoryId).map((entry) => buildExperienceRecord({ trajectoryId: entry.id, payload: entry.payload, quality: entry.quality as ReturnType<typeof evaluateTrajectory> }));
      decisionStore.appendEvent("research.experience.recorded", { experience, capabilityProfile: capabilityProfile([...priorExperiences, experience]), curriculum: selectCurriculum([...priorExperiences, experience]) });
      const researchGaps = Object.entries(researchQuality).filter(([key, value]) => key !== "overall" && (value as { verdict: string }).verdict !== "PASS").map(([key]) => key);
      decisionStore.appendEvent("research.capability_outcome", { ...routingOutcome, objective, predictedTier: route.tier, servedProvider: options.provider, servedModel: selectedModel, lanes: laneReports.map((lane) => ({ role: lane.role, provider: lane.provider, model: lane.model, status: lane.status })), quality: researchQuality.overall, gaps: researchGaps, laneCount: laneReports.length });
      if (researchQuality.overall !== "PASS") decisionStore.appendEvent("trajectory.capability_gaps", { trajectoryType: "research", quality: researchQuality, objective });
      const recentDecisions = decisionStore.decisions().map((entry) => entry.payload as Awaited<ReturnType<typeof runResearchDirector>>).slice(0, 3);
      const stagnation = detectStagnation(recentDecisions);
      if (phaseGoal) {
        const now = new Date().toISOString();
        const goals = phaseGoalsForMode(decisionStore.phaseGoals().map((entry) => PhaseGoalSchema.parse(entry.payload)), mode);
        const index = goals.findIndex((goal) => goal.id === phaseGoal.id);
        if (index >= 0) {
          const met = decision.goalStatus === "met";
          const nextStatus = met ? "met" : decision.goalStatus === "blocked" ? "blocked" : "active";
          decisionStore.savePhaseGoal({ id: phaseGoal.id, phase: phaseGoal.phase, status: nextStatus, payload: { ...goals[index], status: nextStatus, attempts: phaseGoal.attempts + 1, updatedAt: now } });
          if (met && goals[index + 1]) {
            const next = goals[index + 1];
            decisionStore.savePhaseGoal({ id: next.id, phase: next.phase, status: "active", payload: { ...next, status: "active", updatedAt: now } });
          }
        }
      }
      const elapsedMinutes = campaignElapsedMinutes(campaign);
      // Approval-gated experiments must not freeze the research program. The
      // pending proposal is durable and visible; subsequent cycles can gather
      // evidence or select an unrelated hypothesis until the budget/stop
      // condition is reached.
      const terminal = decision.decision === "stop" || decision.goalStatus === "blocked" || stagnation.stagnant || elapsedMinutes >= campaign.budgetMinutes;
      if (terminal) {
        if (decision.goalStatus === "blocked" || stagnation.stagnant) Object.assign(campaign, pauseCampaign(campaign));
        else campaign.status = "completed";
        if (stagnation.stagnant) decisionStore.appendEvent("research.stagnation.detected", { cycles: stagnation.cycles, signature: stagnation.signature, action: "pause_for_review" });
        decisionStore.saveCampaign(campaign);
      }
      decisionStore.close();
      console.log(formatResearchDecision(decision));
      if (stagnation.stagnant) console.log(`\nCampaign paused after ${stagnation.cycles} unchanged active decisions; review the bottleneck before resuming.`);
      if (criticReview) console.log(`\nCritic: ${criticReview.verdict} · confidence ${criticReview.confidence.toFixed(2)}\n${criticReview.summary}${criticReview.objections.length ? `\nObjections:\n${criticReview.objections.map((item) => `- ${item}`).join("\n")}` : ""}`);
      if (terminal) break;
    } while (true);
  });

research.command("policy")
  .description("Show empirical search-operator evidence from autonomous cycles")
  .action(() => {
    const store = new ResearchStore(statePath);
    const project = store.project();
    const report = summarizeSearchPolicyEvidence(store.recentEvents(5000), project?.competitionId);
    store.close();
    console.log(JSON.stringify(report, null, 2));
  });

research.command("propose")
  .argument("[objective]", "research objective", "Inspect the current workspace and propose three falsifiable, evidence-driven hypotheses.")
  .action(async (objective: string) => {
    const store = new ResearchStore(statePath);
    const project = store.project();
    if (!store.phaseGoals().length) {
      for (const goal of definePhaseGoals(objective, "research")) store.savePhaseGoal({ id: goal.id, phase: goal.phase, status: goal.status, payload: goal });
    }
    const phaseGoal = activePhaseGoal(phaseGoalsForMode(store.phaseGoals().map((entry) => PhaseGoalSchema.parse(entry.payload)), "research"));
    console.log("Research 1/3 · inspecting repository...");
    const gitStatus = await runProcess(["git", "status", "--short"], root);
    const files = await runProcess(["rg", "--files", "-g", "!.sota/**", "-g", "!node_modules/**"], root, 60_000);
    console.log("Research 2/3 · running canonical baseline...");
    const adapter = activeCompetition();
    requireCompetitionContract(adapter);
    const baseline = await runProcess(adapter.baselineCommand(), adapter.workspacePath(root), adapter.config.evaluatorTimeoutMinutes * 60_000);
    const observation = {
      gitStatus: gitStatus.stdout.trim().split("\n").filter(Boolean).slice(0, 40),
      repositoryFiles: files.stdout.trim().split("\n").filter(Boolean).slice(0, 120),
      baseline: { exitCode: baseline.exitCode, durationMs: baseline.durationMs, stdout: redactSecrets(baseline.stdout.slice(-4000)), stderr: redactSecrets(baseline.stderr.slice(-4000)) },
    };
    const metric = parseMetricOutput(baseline.stdout, adapter.config.metric.name).metrics[adapter.config.metric.name] ?? null;
    recordBaselineEvidence(store, root, baseline, metric);
    store.appendEvent("research.observation", observation);
    store.saveClaim({ id: `claim_observation_${Date.now()}`, payload: { statement: "Repository inspection and canonical baseline execution completed before the research decision.", scope: "current-workspace", confidence: 1, sourceType: "observation", sourceId: `observation_${Date.now()}`, status: "active", observation } });
    const recentEvents = store.recentEvents(20);
    const researchMemory = researchMemoryContext(store, 30, objective);
    store.close();
    console.log("Research 3/3 · analyzing observed evidence...");
    let decision = await runResearchDirector(objective, {
      project,
      competition: adapter.config,
      constraints: { no_submission: true, no_file_edits: true },
      recentEvents,
      observation,
      ultimateGoal: objective,
      phaseGoal: phaseGoal ?? null,
      researchMemory,
    }, { provider: "codex", model: "default", reasoningEffort: "medium", fallbackLocalModel: "qwen3.6:27b", cwd: root, executeTool: researchToolExecutor(adapter) });
    const decisionStore = new ResearchStore(statePath);
    decision = enforceGoalTermination(decision);
    const claimAudit = auditCurrentClaims(decisionStore);
    const claimGateBefore = decision;
    decision = enforceClaimTermination(decision, claimAudit);
    if (decision !== claimGateBefore) decisionStore.appendEvent("research.claim_gate.rejected", { ...claimAudit, phase: phaseGoal?.phase ?? null });
    if (phaseGoal && decision.goalStatus === "met") {
      const phaseEvents = decisionStore.recentEvents(500);
      const gate = evaluatePhaseGoalEvidence(phaseGoal, {
        mode: "research",
        eventTypes: phaseEvents.map((event) => event.type),
        eventPayloads: phaseEvents.map((event) => ({ type: event.type, payload: event.payload })),
        ...decisionStore.counts(),
        candidateHypotheses: decision.hypotheses.length,
      });
      if (!gate.met) {
        decision = { ...decision, goalStatus: "active", nextAction: decision.nextAction + " (phase gate missing: " + gate.missing.join(", ") + ")" };
        decisionStore.appendEvent("research.phase_gate.rejected", { phase: phaseGoal.phase, missing: gate.missing });
      }
    }
    materializeResearchDecision(decisionStore, decision);
    if (phaseGoal) {
      const now = new Date().toISOString();
      const nextStatus = decision.goalStatus === "met" ? "met" : decision.goalStatus === "blocked" ? "blocked" : "active";
      decisionStore.savePhaseGoal({ id: phaseGoal.id, phase: phaseGoal.phase, status: nextStatus, payload: { ...phaseGoal, status: nextStatus, attempts: phaseGoal.attempts + 1, updatedAt: now } });
    }
    if (phaseGoal && decision.goalStatus === "met") {
      const goals = decisionStore.phaseGoals().map((entry) => PhaseGoalSchema.parse(entry.payload));
      const index = goals.findIndex((goal) => goal.id === phaseGoal.id);
      const now = new Date().toISOString();
      if (index >= 0) {
        decisionStore.savePhaseGoal({ id: phaseGoal.id, phase: phaseGoal.phase, status: "met", payload: { ...goals[index], status: "met", updatedAt: now } });
        const next = goals[index + 1];
        if (next) decisionStore.savePhaseGoal({ id: next.id, phase: next.phase, status: "active", payload: { ...next, status: "active", updatedAt: now } });
      }
    }
    decisionStore.close();
    console.log(formatResearchDecision(decision));
  });
program.addCommand(research);

program.command("baseline")
  .description("Run the active workspace baseline locally")
  .option("--name <name>", "starter-kit baseline", "mean_propagation")
  .action(async (options: { name: string }) => {
    const adapter = activeCompetition();
    requireCompetitionContract(adapter);
    const command = adapter.baselineCommand();
    if (options.name !== "mean_propagation" && adapter.id === "arc-whestbench-2026") {
      command.push("--baseline", options.name);
    }
    const result = await runProcess(command, adapter.workspacePath(root), adapter.config.evaluatorTimeoutMinutes * 60_000);
    const store = new ResearchStore(statePath);
    const metric = parseMetricOutput(result.stdout, adapter.config.metric.name).metrics[adapter.config.metric.name] ?? null;
    recordBaselineEvidence(store, root, result, metric);
    store.close();
    console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  });

const validation = new Command("validation").description("Manage the immutable validation policy");
const validationPaths = () => ({ policy: join(stateDirectory, "validation-policy.json"), lock: join(stateDirectory, "validation-policy.lock.json") });
validation.command("inspect").action(() => {
  const paths = validationPaths();
  const lock = readValidationPolicyLock(paths.lock);
  console.log(existsSync(paths.policy) ? readFileSync(paths.policy, "utf8").trim() : "No validation policy generated.");
  console.log(`Lock: ${lock?.locked ? `locked (${lock.checksum})` : lock ? `unlocked (${lock.unlockReason ?? "no reason"})` : "not locked"}`);
});
validation.command("generate").description("Generate a policy; locked policies require an explicit unlock first").action(() => {
  const paths = validationPaths();
  if (readValidationPolicyLock(paths.lock)?.locked) throw new Error("Validation policy is locked. Run 'evidra validation unlock --reason <reason>' first.");
  const adapter = activeCompetition();
  const policy = createValidationPolicy(adapter.config);
  mkdirSync(stateDirectory, { recursive: true });
  const checksum = writeValidationPolicy(paths.policy, policy);
  const store = new ResearchStore(statePath);
  store.appendEvent("validation.policy.created", { path: paths.policy, checksum, policy });
  store.close();
  console.log(`Validation policy generated\nVersion: ${policy.version}\nChecksum: ${checksum}`);
});
validation.command("lock").description("Lock the current policy against mutation").action(() => {
  const paths = validationPaths();
  const record = lockValidationPolicy(paths.policy, paths.lock);
  const store = new ResearchStore(statePath);
  store.appendEvent("validation.policy.locked", record);
  store.close();
  console.log(`Validation policy locked\nChecksum: ${record.checksum}`);
});
validation.command("unlock").requiredOption("--reason <reason>", "why the validation policy must change").description("Unlock only with an auditable reason").action((options: { reason: string }) => {
  const paths = validationPaths();
  const record = unlockValidationPolicy(paths.policy, paths.lock, options.reason);
  const store = new ResearchStore(statePath);
  store.appendEvent("validation.policy.unlocked", record);
  store.close();
  console.log(`Validation policy unlocked\nReason: ${record.unlockReason}`);
});
program.addCommand(validation);

const experiment = new Command("experiment").description("Manage research experiments");
experiment.command("propose")
  .argument("[hypothesis]", "hypothesis identifier; defaults to the newest hypothesis")
  .option("--executor <executor>", "experiment executor: local, container, or modal", "local")
  .action(async (hypothesisId: string | undefined, options: { executor: string }) => {
    if (!["local", "container", "modal"].includes(options.executor)) throw new Error("Executor must be 'local', 'container', or 'modal'.");
    const store = new ResearchStore(statePath);
    const hypothesis = hypothesisId ?? store.hypotheses()[0]?.id;
    if (!hypothesis) {
      store.close();
      throw new Error("No hypothesis exists. Run: evidra research propose");
    }
    const commit = await runProcess(["git", "rev-parse", "HEAD"], root);
    if (commit.exitCode !== 0) {
      store.close();
      throw new Error(`Cannot create manifest: ${commit.stderr || commit.stdout}`);
    }
    const id = `exp_${Date.now()}_${hypothesis.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32)}`;
    const adapter = activeCompetition();
    const hypothesisPayload = store.hypotheses().find((entry) => entry.id === hypothesis)?.payload as { outcomeType?: "metric" | "artifact" | "proof" | "behavior" | "system" | "other" } | undefined;
    const manifest = createExperimentManifest({ id, hypothesisId: hypothesis, outcomeType: hypothesisPayload?.outcomeType, gitCommit: commit.stdout.trim(), datasetVersion: adapter.config.datasetRevision, executor: options.executor as "local" | "container" | "modal", configPatch: { estimatorPath: candidateEstimatorPath(hypothesisPayload) ?? adapter.config.evaluator.estimatorPath } }, adapter.config);
    store.saveExperiment({ id, payload: { ...manifest, status: "proposed", executionPlan: createExecutionPlan(manifest) } });
    store.close();
    console.log(`Immutable experiment manifest created\n${manifestSummary(manifest)}`);
  });
experiment.command("gate")
  .argument("<experiment>", "experiment identifier")
  .argument("<gate>", "leakage or review")
  .argument("[action]", "approve or clear", "approve")
  .action((experimentId: string, gate: string, action: string) => {
    if (!["leakage", "review"].includes(gate) || !["approve", "clear"].includes(action)) throw new Error("Usage: evidra experiment gate <id> leakage|review approve|clear");
    const store = new ResearchStore(statePath);
    if (!store.experiments().some((entry) => entry.id === experimentId)) { store.close(); throw new Error(`Experiment not found: ${experimentId}`); }
    const approved = action === "approve";
    store.setExperimentGates(experimentId, gate === "leakage" ? { leakageAuditPassed: approved } : { reviewerApproved: approved });
    const gates = store.experimentGates(experimentId);
    store.close();
    console.log(`Experiment ${experimentId} gates\n  leakage audit: ${gates.leakageAuditPassed ? "approved" : "pending"}\n  reviewer: ${gates.reviewerApproved ? "approved" : "pending"}`);
  });
experiment.command("run")
  .argument("<id>", "experiment identifier")
  .option("--reduced-only", "stop after the reduced validation gate and persist its metric")
  .option("--skip-reduced", "reuse a previously completed reduced screening stage")
  .action(async (id: string, options: { reducedOnly?: boolean; skipReduced?: boolean }) => {
    if (options.reducedOnly && options.skipReduced) throw new Error("Choose either --reduced-only or --skip-reduced, not both.");
    const adapter = activeCompetition();
    const store = new ResearchStore(statePath);
    const entry = store.experiments().find((candidate) => candidate.id === id);
    if (!entry) { store.close(); throw new Error(`Experiment ${id} is not registered. Run: evidra experiment propose`); }
    const entryPayload = entry.payload as Record<string, unknown>;
    if (options.skipReduced && (entryPayload.status !== "screened" || typeof entryPayload.reducedRunId !== "string")) {
      store.close();
      throw new Error("--skip-reduced requires a durable completed reduced screening for this experiment.");
    }
    const manifest = ExperimentManifestSchema.parse(entry.payload);
    const validationPathsForRun = validationPaths();
    if (readValidationPolicyLock(validationPathsForRun.lock)?.locked) {
      assertValidationPolicy(validationPathsForRun.policy, validationPathsForRun.lock);
      store.appendEvent("validation.policy.verified", { experimentId: id, lockPath: validationPathsForRun.lock });
    }
    let executionPlan: ExecutionStage[] = Array.isArray((entry.payload as { executionPlan?: unknown }).executionPlan)
      ? (entry.payload as { executionPlan: ExecutionStage[] }).executionPlan
      : createExecutionPlan(manifest);
    const hypothesis = store.hypotheses().find((candidate) => candidate.id === manifest.hypothesisId);
    store.saveExperiment({ id, payload: { ...(entry.payload as Record<string, unknown>), status: "running" } });
    store.close();
    const worktreePath = await ensureWorktree(root, root, id);
    const experimentCwd = join(worktreePath, relative(root, adapter.workspacePath(root)));
    const protectedReference = captureProtectedFiles(adapter.workspacePath(root), [adapter.config.evaluator.command]);
    const changedProtected = changedProtectedFiles(protectedReference, experimentCwd);
    if (changedProtected.length) {
      const integrityStore = new ResearchStore(statePath);
      integrityStore.appendEvent("experiment.integrity.failed", { experimentId: id, protectedFiles: changedProtected, reason: "evaluator or configuration changed inside the isolated worktree" });
      integrityStore.saveExperiment({ id, payload: { ...(entry.payload as Record<string, unknown>), status: "invalid", integrityFailure: changedProtected } });
      integrityStore.close();
      throw new Error(`Experiment ${id} rejected: protected evaluator files changed: ${changedProtected.join(", ")}`);
    }
    const command = experimentCommandFor(adapter, hypothesis?.payload);
    const contract = validateExecutionContract(manifest, experimentCwd, command);
    const contractStore = new ResearchStore(statePath);
    contractStore.appendEvent(contract.valid ? "experiment.stage.feasibility.completed" : "experiment.stage.feasibility.failed", { experimentId: id, reasons: contract.reasons, command, cwd: experimentCwd });
    contractStore.close();
    executionPlan = advanceExecutionStage(executionPlan, "feasibility", contract.valid ? "completed" : "failed");
    if (!contract.valid) {
      const failedStore = new ResearchStore(statePath);
      failedStore.saveExperiment({ id, payload: { ...(entry.payload as Record<string, unknown>), status: "failed", executionPlan } });
      failedStore.close();
      throw new Error(`Experiment feasibility check failed:\n${contract.reasons.map((reason) => `- ${reason}`).join("\n")}`);
    }
    const candidateEstimator = (manifest.change.configPatch as { estimatorPath?: unknown }).estimatorPath;
    const isCandidateEvaluation = typeof candidateEstimator === "string" && candidateEstimator !== adapter.config.evaluator.estimatorPath;
    const executor = executorFor(manifest.resources.executor, root);
    const smokeCommand = adapter.config.execution?.smokeCommand;
    if (smokeCommand) {
      const smokeManifest = { ...manifest, evaluation: { ...manifest.evaluation, requiredArtifacts: [] } };
      const smokeContract = validateExecutionContract(smokeManifest, experimentCwd, smokeCommand);
      if (!smokeContract.valid) {
        executionPlan = advanceExecutionStage(executionPlan, "smoke", "failed");
        const failedStore = new ResearchStore(statePath);
        failedStore.appendEvent("experiment.stage.smoke.failed", { experimentId: id, reasons: smokeContract.reasons, command: smokeCommand });
        failedStore.saveExperiment({ id, payload: { ...(entry.payload as Record<string, unknown>), status: "failed", executionPlan } });
        failedStore.close();
        throw new Error(`Smoke feasibility check failed:\n${smokeContract.reasons.map((reason) => `- ${reason}`).join("\n")}`);
      }
      const smoke = await withExecutionHeartbeat(
        () => runReducedValidation(executor, manifest, experimentCwd, smokeCommand, adapter.config.metric.name),
        { storePath: statePath, experimentId: id, stage: "smoke", executor: manifest.resources.executor },
      );
      executionPlan = advanceExecutionStage(executionPlan, "smoke", smoke.status === "completed" ? "completed" : "failed");
      const smokeStore = new ResearchStore(statePath);
      smokeStore.appendEvent(smoke.status === "completed" ? "experiment.stage.smoke.completed" : "experiment.stage.smoke.failed", { experimentId: id, runId: smoke.runId, metric: smoke.metrics[adapter.config.metric.name] ?? null, exitCode: smoke.exitCode, command: smokeCommand });
      if (smoke.status !== "completed") smokeStore.saveExperiment({ id, payload: { ...(entry.payload as Record<string, unknown>), status: "failed", executionPlan } });
      smokeStore.close();
      if (smoke.status !== "completed") throw new Error(`Smoke validation failed (${smoke.exitCode}): ${smoke.stderr || smoke.stdout}`);
    } else {
      executionPlan = advanceExecutionStage(executionPlan, "smoke", "skipped");
      const stageStore = new ResearchStore(statePath);
      stageStore.appendEvent("experiment.stage.smoke.skipped", { experimentId: id, reason: "manifest has no configured smoke command" });
      stageStore.close();
    }
    const reducedCommand = adapter.config.execution?.reducedValidationCommand;
    if (options.skipReduced) {
      executionPlan = advanceExecutionStage(executionPlan, "reduced_validation", "completed");
      const reusedStore = new ResearchStore(statePath);
      reusedStore.appendEvent("experiment.stage.reduced_validation.reused", { experimentId: id, reason: "previous reduced-only screening was completed" });
      reusedStore.close();
    } else if (reducedCommand) {
      const reducedManifest = { ...manifest, evaluation: { ...manifest.evaluation, requiredArtifacts: [] } };
      const reducedContract = validateExecutionContract(reducedManifest, experimentCwd, reducedCommand);
      if (!reducedContract.valid) {
        executionPlan = advanceExecutionStage(executionPlan, "reduced_validation", "failed");
        const failedStore = new ResearchStore(statePath);
        failedStore.appendEvent("experiment.stage.reduced_validation.failed", { experimentId: id, reasons: reducedContract.reasons, command: reducedCommand });
        failedStore.saveExperiment({ id, payload: { ...(entry.payload as Record<string, unknown>), status: "failed", executionPlan } });
        failedStore.close();
        throw new Error(`Reduced validation feasibility check failed:\n${reducedContract.reasons.map((reason) => `- ${reason}`).join("\n")}`);
      }
      const reduced = await withExecutionHeartbeat(
        () => runReducedValidation(executor, manifest, experimentCwd, reducedCommand, adapter.config.metric.name),
        { storePath: statePath, experimentId: id, stage: "reduced_validation", executor: manifest.resources.executor },
      );
      executionPlan = advanceExecutionStage(executionPlan, "reduced_validation", reduced.status === "completed" ? "completed" : "failed");
      const reducedStore = new ResearchStore(statePath);
      reducedStore.appendEvent(reduced.status === "completed" ? "experiment.stage.reduced_validation.completed" : "experiment.stage.reduced_validation.failed", { experimentId: id, runId: reduced.runId, metric: reduced.metrics[adapter.config.metric.name] ?? null, exitCode: reduced.exitCode, command: reducedCommand });
      if (reduced.status !== "completed") reducedStore.saveExperiment({ id, payload: { ...(entry.payload as Record<string, unknown>), status: "failed", executionPlan } });
      reducedStore.close();
      if (reduced.status !== "completed") throw new Error(`Reduced validation failed (${reduced.exitCode}): ${reduced.stderr || reduced.stdout}`);
      const promotionPolicy = adapter.config.execution?.reducedPromotion;
      if (promotionPolicy?.enabled) {
        const promotionStore = new ResearchStore(statePath);
        const baselineEvent = promotionStore.recentEvents(500).reverse().find((event) => event.type === "baseline.completed");
        const baselinePayload = baselineEvent?.payload as { metric?: unknown; stdout?: string } | undefined;
        const baselineMetric = typeof baselinePayload?.metric === "number" ? baselinePayload.metric : baselinePayload?.stdout ? parseMetricOutput(baselinePayload.stdout, adapter.config.metric.name).metrics[adapter.config.metric.name] : undefined;
        const learned = learnPromotionPolicy(promotionObservations(promotionStore.recentEvents(2_000), adapter.config.metric.direction), promotionPolicy.minimumDelta);
        const gate = evaluateReducedPromotion({ candidateMetric: reduced.metrics[adapter.config.metric.name], baselineMetric, direction: adapter.config.metric.direction, minimumDelta: learned.minimumDelta, tolerance: promotionPolicy.tolerance });
        promotionStore.appendEvent(gate.promote ? "experiment.stage.reduced_validation.promoted" : "experiment.stage.reduced_validation.rejected", { experimentId: id, runId: reduced.runId, ...gate, configuredMinimumDelta: promotionPolicy.minimumDelta, learnedPromotion: learned, baselineMetric, candidateMetric: reduced.metrics[adapter.config.metric.name] ?? null });
        if (!gate.promote) {
          executionPlan = advanceExecutionStage(executionPlan, "full_validation", "skipped");
          promotionStore.saveExperiment({ id, payload: { ...(entry.payload as Record<string, unknown>), status: "rejected", rejection: gate.reason, executionPlan } });
          promotionStore.close();
          throw new Error(`Reduced validation did not earn full validation: ${gate.reason}`);
        }
        promotionStore.close();
      }
      if (options.reducedOnly) {
        const screenedStore = new ResearchStore(statePath);
        screenedStore.saveExperiment({ id, payload: { ...(entry.payload as Record<string, unknown>), status: "screened", reducedRunId: reduced.runId, reducedMetric: reduced.metrics[adapter.config.metric.name] ?? null, executionPlan } });
        screenedStore.appendEvent("experiment.screening.completed", { experimentId: id, runId: reduced.runId, metric: reduced.metrics[adapter.config.metric.name] ?? null, command: reducedCommand });
        screenedStore.close();
        console.log(`Experiment ${id}: reduced screening completed`);
        console.log(`Run: ${reduced.runId}`);
        console.log(`Metric (${adapter.config.metric.name}): ${reduced.metrics[adapter.config.metric.name] ?? "not parsed"}`);
        return;
      }
    } else {
      if (options.reducedOnly) {
        const failedStore = new ResearchStore(statePath);
        failedStore.saveExperiment({ id, payload: { ...(entry.payload as Record<string, unknown>), status: "failed", executionPlan } });
        failedStore.close();
        throw new Error("Reduced-only execution requires execution.reducedValidationCommand in the competition manifest.");
      }
      executionPlan = advanceExecutionStage(executionPlan, "reduced_validation", "skipped");
      const skippedStore = new ResearchStore(statePath);
      skippedStore.appendEvent("experiment.stage.reduced_validation.skipped", { experimentId: id, reason: "manifest has no generic reduced-data contract" });
      skippedStore.close();
    }
    let attempt = 1;
    const recordAttemptStarted = (attemptNumber: number): void => {
      const attemptStore = new ResearchStore(statePath);
      attemptStore.appendEvent("run.attempt.started", { experimentId: id, attempt: attemptNumber, command, cwd: experimentCwd, executor: manifest.resources.executor });
      attemptStore.close();
    };
    const recordAttempt = (attemptNumber: number, attemptResult: typeof result): void => {
      const attemptStore = new ResearchStore(statePath);
      attemptStore.appendEvent("run.attempt.completed", {
        experimentId: id,
        attempt: attemptNumber,
        runId: attemptResult.runId,
        status: attemptResult.status,
        exitCode: attemptResult.exitCode,
        durationSeconds: attemptResult.durationSeconds,
        metric: attemptResult.metrics[adapter.config.metric.name] ?? null,
        failureClass: attemptResult.failureClass ?? null,
        command: attemptResult.command ?? command,
        cwd: attemptResult.cwd ?? experimentCwd,
      });
      attemptStore.close();
    };
    recordAttemptStarted(attempt);
    let result = await withExecutionHeartbeat(
      () => executor.run(manifest, experimentCwd, command, undefined, adapter.config.metric.name),
      { storePath: statePath, experimentId: id, attempt, stage: "full_validation", executor: manifest.resources.executor },
    );
    recordAttempt(attempt, result);
    while (result.status !== "completed") {
      const plan = recoveryPlan(result.failureClass);
      if (!plan.retry || attempt >= plan.maxAttempts) break;
      const delay = recoveryDelay(plan, attempt);
      const retryStore = new ResearchStore(statePath);
      retryStore.appendEvent("run.retry.scheduled", { experimentId: id, runId: result.runId, attempt, delaySeconds: delay, failureClass: result.failureClass, action: plan.action });
      retryStore.close();
      console.log(`Retrying experiment ${id} (${attempt + 1}/${plan.maxAttempts}) after ${plan.action}; waiting ${delay}s...`);
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delay * 1000));
      attempt += 1;
      recordAttemptStarted(attempt);
      result = await withExecutionHeartbeat(
        () => executor.run(manifest, experimentCwd, command, undefined, adapter.config.metric.name),
        { storePath: statePath, experimentId: id, attempt, stage: "full_validation", executor: manifest.resources.executor },
      );
      recordAttempt(attempt, result);
    }
    if (result.status !== "completed") {
      const route = recoveryRouteDirective(result.failureClass);
      const routeStore = new ResearchStore(statePath);
      routeStore.appendEvent("experiment.recovery.route_changed", { experimentId: id, runId: result.runId, attempts: attempt, ...route });
      routeStore.close();
    }
    const evaluatorCommand = isCandidateEvaluation ? command : adapter.config.evaluator.command;
    const sameCommand = evaluatorCommand.length === command.length && evaluatorCommand.every((part, index) => part === command[index]);
    let evaluator: { stdout: string; stderr: string; exitCode: number } | undefined;
    const verifications: Array<{ command: string[]; stdout: string; stderr: string; exitCode: number }> = [];
    if (result.status === "completed" && !sameCommand) {
      const evaluated = await withExecutionHeartbeat(
        () => runProcess(evaluatorCommand, experimentCwd, manifest.resources.timeoutMinutes * 60_000),
        { storePath: statePath, experimentId: id, attempt, stage: "evaluator", executor: manifest.resources.executor },
      );
      evaluator = { stdout: evaluated.stdout, stderr: evaluated.stderr, exitCode: evaluated.exitCode };
      const parsed = parseMetricOutput(evaluated.stdout, adapter.config.metric.name);
      result = { ...result, status: evaluated.exitCode === 0 ? "completed" : "failed", exitCode: evaluated.exitCode, metrics: { ...result.metrics, ...parsed.metrics }, metricsByFold: { ...result.metricsByFold, ...parsed.metricsByFold }, stdout: `${result.stdout ?? ""}\n[EVALUATOR]\n${evaluated.stdout}`, stderr: `${result.stderr ?? ""}\n[EVALUATOR]\n${evaluated.stderr}`, ...(evaluated.exitCode === 0 ? {} : { failureClass: "unknown" as const }) };
    }
    const verificationCommands = [...(manifest.evaluation.verificationCommand ? [manifest.evaluation.verificationCommand] : []), ...(manifest.evaluation.verificationCommands ?? [])];
    if (result.status === "completed") {
      for (const verificationCommand of verificationCommands) {
        const checked = await withExecutionHeartbeat(
          () => runProcess(verificationCommand, experimentCwd, manifest.resources.timeoutMinutes * 60_000),
          { storePath: statePath, experimentId: id, attempt, stage: "verification", executor: manifest.resources.executor },
        );
        verifications.push({ command: verificationCommand, stdout: checked.stdout, stderr: checked.stderr, exitCode: checked.exitCode });
        const verificationStore = new ResearchStore(statePath);
        verificationStore.appendEvent(checked.exitCode === 0 ? "experiment.verification.completed" : "experiment.verification.failed", { experimentId: id, runId: result.runId, verifierIndex: verifications.length, command: verificationCommand, exitCode: checked.exitCode, stdout: checked.stdout.slice(-4000), stderr: checked.stderr.slice(-4000) });
        verificationStore.close();
        result = { ...result, status: checked.exitCode === 0 ? "completed" : "failed", exitCode: checked.exitCode, stdout: `${result.stdout ?? ""}\n[VERIFICATION ${verifications.length}]\n${checked.stdout}`, stderr: `${result.stderr ?? ""}\n[VERIFICATION ${verifications.length}]\n${checked.stderr}`, ...(checked.exitCode === 0 ? {} : { failureClass: "unknown" as const }) };
        if (checked.exitCode !== 0) break;
      }
    }
    if (manifest.outcomeType === "metric") result = validateRunMetric(result, adapter.config.metric.name);
    executionPlan = advanceExecutionStage(executionPlan, "full_validation", result.status === "completed" ? "completed" : "failed");
    const fullStageStore = new ResearchStore(statePath);
    fullStageStore.appendEvent(result.status === "completed" ? "experiment.stage.full_validation.completed" : "experiment.stage.full_validation.failed", { experimentId: id, runId: result.runId, metric: result.metrics[adapter.config.metric.name] ?? null, exitCode: result.exitCode, attempts: attempt });
    fullStageStore.close();
    const artifactDir = join(root, ".sota", "artifacts", result.runId);
    mkdirSync(artifactDir, { recursive: true });
    const artifactPaths: Record<string, string> = {};
    const environment = await captureEnvironment(root, result.cwd ?? experimentCwd, result.command ?? command, manifest.resources.executor, manifest.resources.gpu);
    const verificationArtifacts = Object.fromEntries(verifications.flatMap((verification, index) => [[`verification-${index + 1}.stdout.log`, verification.stdout], [`verification-${index + 1}.stderr.log`, verification.stderr]]));
    for (const [name, content] of Object.entries({ "stdout.log": result.stdout ?? "", "stderr.log": result.stderr ?? "", "metrics.json": `${JSON.stringify(result.metrics, null, 2)}\n`, "environment.json": `${JSON.stringify(environment, null, 2)}\n`, ...(evaluator ? { "evaluator.stdout.log": evaluator.stdout, "evaluator.stderr.log": evaluator.stderr } : {}), ...verificationArtifacts })) {
      const path = join(artifactDir, name);
      writeFileSync(path, content);
      artifactPaths[name] = path;
    }
    const recorded = { ...result, recoveryAttempts: attempt, artifacts: { ...result.artifacts, ...artifactPaths } };
    const resultStore = new ResearchStore(statePath);
    resultStore.saveRun({ id: result.runId, experimentId: id, status: recorded.status, payload: recorded });
    for (const [name, path] of Object.entries(artifactPaths)) resultStore.saveArtifact({ id: `${result.runId}-${name}`, runId: result.runId, name, path, checksum: sha256File(path) });
    const experimentTrajectoryEvents: TrajectoryEvent[] = [
      { id: `${result.runId}-process`, kind: "process", payload: { status: recorded.status, exitCode: recorded.exitCode, failureClass: recorded.failureClass ?? null } },
      ...Array.from({ length: Math.max(0, attempt - 1) }, (_, index) => ({ id: `${result.runId}-recovery-${index + 1}`, kind: "recovery" as const, payload: { attempt: index + 1, status: "completed" } })),
      { id: `${result.runId}-evaluator`, kind: "evaluator", payload: { metric: recorded.metrics[adapter.config.metric.name] ?? null, evidenceConsistent: recorded.status === "completed" } },
      { id: `${result.runId}-terminal`, kind: "terminal", payload: { status: recorded.status, goalAttained: recorded.status === "completed" && (manifest.outcomeType !== "metric" || recorded.metrics[adapter.config.metric.name] !== undefined) } },
    ];
    const experimentQuality = evaluateTrajectory(experimentTrajectoryEvents);
    const experimentTrajectoryId = `trajectory_${result.runId}`;
    const experimentTrajectoryPayload = { manifest, hypothesis: hypothesis?.payload ?? null, events: experimentTrajectoryEvents };
    resultStore.saveTrajectory({ id: experimentTrajectoryId, runId: result.runId, experimentId: id, payload: experimentTrajectoryPayload, quality: experimentQuality });
    const experimentExperience = buildExperienceRecord({ trajectoryId: experimentTrajectoryId, payload: experimentTrajectoryPayload, quality: experimentQuality });
    const priorExperiences = resultStore.trajectories(100).filter((entry) => entry.id !== experimentTrajectoryId).map((entry) => buildExperienceRecord({ trajectoryId: entry.id, payload: entry.payload, quality: entry.quality as ReturnType<typeof evaluateTrajectory> }));
    resultStore.appendEvent("research.experience.recorded", { experience: experimentExperience, capabilityProfile: capabilityProfile([...priorExperiences, experimentExperience]), curriculum: selectCurriculum([...priorExperiences, experimentExperience]), source: "experiment" });
    if (experimentQuality.overall !== "PASS") resultStore.appendEvent("trajectory.capability_gaps", { trajectoryId: `trajectory_${result.runId}`, gaps: Object.entries(experimentQuality).filter(([key, value]) => key !== "overall" && (value as { verdict: string }).verdict !== "PASS").map(([key, value]) => ({ dimension: key, verdict: (value as { verdict: string }).verdict, evidence: (value as { evidence: string[] }).evidence })) });
    if (recorded.status === "completed") {
      const baselineEvent = resultStore.recentEvents(500).reverse().find((event) => event.type === "baseline.completed");
      const baselinePayload = baselineEvent?.payload as { metric?: unknown; stdout?: string; stderr?: string; durationMs?: number; command?: string[]; cwd?: string } | undefined;
      const metricName = adapter.config.metric.name;
      const parsedBaseline = baselinePayload?.stdout ? parseMetricOutput(baselinePayload.stdout, metricName) : { metrics: {}, metricsByFold: {} };
      const baselineMetric = typeof baselinePayload?.metric === "number" && Number.isFinite(baselinePayload.metric)
        ? baselinePayload.metric
        : parsedBaseline.metrics[metricName];
      if (typeof baselineMetric === "number" && Number.isFinite(baselineMetric)) {
        const baselineRun = {
          runId: `baseline-${baselineEvent?.createdAt ?? "recorded"}`,
          status: "completed" as const,
          exitCode: 0,
          durationSeconds: (baselinePayload?.durationMs ?? 0) / 1000,
          metrics: { [metricName]: baselineMetric },
          metricsByFold: { [metricName]: baselinePayload?.stdout ? parsedBaseline.metricsByFold[metricName] ?? [] : [] },
          artifacts: {},
          stdout: baselinePayload?.stdout,
          stderr: baselinePayload?.stderr,
          command: baselinePayload?.command,
          cwd: baselinePayload?.cwd,
        };
        const comparison = compareRuns(baselineRun, RunResultSchema.parse(recorded), metricName, adapter.config.metric.direction === "minimize");
        const operator = manifest.searchOperator ?? "ucb_portfolio";
        resultStore.appendEvent("experiment.comparison.completed", { experimentId: id, baselineSource: baselineEvent?.createdAt ?? "baseline", comparison, searchOperator: operator });
        const gates = resultStore.experimentGates(id);
        // Failed and rejected attempts still consumed a hypothesis slot. Do
        // not let a campaign hide them by counting only completed winners.
        const comparisonCount = comparisonFamilySize(resultStore.experiments().map((candidate) => candidate.payload as { datasetVersion?: unknown; outcomeType?: unknown }), manifest.datasetVersion);
        const acceptance = evaluateValidationAcceptance({
          baseline: baselineRun,
          candidate: RunResultSchema.parse(recorded),
          metric: metricName,
          direction: adapter.config.metric.direction,
          minimumDelta: manifest.acceptance.minimumPrimaryDelta,
          maximumRegressionShift: manifest.acceptance.maximumRegressionShift,
          requireReplication: manifest.acceptance.requireReplication,
          leakageAuditPassed: gates.leakageAuditPassed,
          reviewerApproved: gates.reviewerApproved,
          comparisonCount,
        });
        resultStore.appendEvent("experiment.validation.assessed", { experimentId: id, acceptance, comparisonCount, adjustedProbabilityThreshold: acceptance.adjustedProbabilityThreshold, gates: acceptance.gates, normalizedDelta: acceptance.normalizedDelta, worstSubgroupDelta: acceptance.worstSubgroupDelta });
        if (operator) {
          const improvementDelta = comparison.delta === null ? undefined : adapter.config.metric.direction === "minimize" ? -comparison.delta : comparison.delta;
          resultStore.appendEvent("research.search.reward", { experimentId: id, competitionId: adapter.id, datasetRevision: manifest.datasetVersion, operator, reward: searchReward(improvementDelta, recorded.status === "completed", comparison.evidence === "replicated"), valid: recorded.status === "completed", reproducible: comparison.evidence === "replicated", delta: improvementDelta, durationSeconds: recorded.durationSeconds, executor: manifest.resources.executor, gpu: manifest.resources.gpu ?? undefined });
        }
      } else {
        resultStore.appendEvent("experiment.comparison.insufficient_data", { experimentId: id, reason: "No finite baseline metric was available." });
      }
    }
    const terminalRecovery = recorded.status === "completed" ? undefined : recoveryRouteDirective(recorded.failureClass);
    resultStore.saveExperiment({ id, payload: { ...(entry.payload as Record<string, unknown>), status: recorded.status === "completed" ? "completed" : "failed", runId: result.runId, worktreePath: experimentCwd, executionPlan, ...(terminalRecovery ? { recoveryRoute: { ...terminalRecovery, attempts: attempt, runId: result.runId, recordedAt: new Date().toISOString() } } : {}) } });
    resultStore.close();
    console.log(`Experiment ${id}: ${recorded.status}`);
    console.log(`Run: ${result.runId}`);
    console.log(`Metric (${adapter.config.metric.name}): ${recorded.metrics[adapter.config.metric.name] ?? "not parsed"}`);
    console.log(`Artifacts: ${Object.keys(artifactPaths).join(", ")}`);
    if (recorded.exitCode !== 0) process.exitCode = recorded.exitCode;
  });
experiment.command("audit")
  .argument("<experiment>", "experiment identifier")
  .description("Audit an experiment's reproducibility and evidence gates")
  .action(async (id: string) => {
    const store = new ResearchStore(statePath);
    const entry = store.experiments().find((candidate) => candidate.id === id);
    if (!entry) { store.close(); throw new Error(`Experiment ${id} is not registered.`); }
    const payload = entry.payload as Record<string, unknown>;
    const run = store.runs().find((candidate) => candidate.id === payload.runId || candidate.experimentId === id);
    if (!run) { store.close(); throw new Error(`No run recorded for experiment ${id}.`); }
    const gates = store.experimentGates(id);
    const artifactChecksums = Object.fromEntries(store.artifacts(run.id).map((artifact) => [artifact.name, artifact.checksum]));
    const currentCommit = await runProcess(["git", "rev-parse", "HEAD"], root);
    store.close();
    const manifest = ExperimentManifestSchema.parse(payload);
    const runResult = RunResultSchema.parse(run.payload);
    const adapter = activeCompetition();
    const audit = auditExperiment(manifest, runResult, {
      currentCommit: currentCommit.stdout.trim(),
      datasetVersion: adapter.config.datasetRevision,
      splitVersion: manifest.splitVersion,
      leakageAuditPassed: gates.leakageAuditPassed,
      reviewerApproved: gates.reviewerApproved,
      artifactChecksums,
    });
    console.log(`Evidence audit · ${id}\nStatus: ${audit.accepted ? "ACCEPTED" : "NOT ACCEPTED"}\n\n${Object.entries(audit.gates).map(([name, passed]) => `  ${passed ? "✓" : "·"} ${name}`).join("\n")}${audit.reasons.length ? `\n\nReasons:\n${audit.reasons.map((reason) => `- ${reason}`).join("\n")}` : ""}`);
    if (!audit.accepted) process.exitCode = 2;
  });
program.addCommand(experiment);

try {
  if (process.argv.length <= 2) {
    if (!process.stdin.isTTY) {
      await startInteractive(root, statePath);
    } else {
      // The TUI owns the primary Evidra experience; readline remains available for pipes and scripts.
      process.stdout.write("\u001b[?1049h\u001b[H\u001b[2J");
      let restored = false;
      const restoreTerminal = (): void => {
        if (restored) return;
        restored = true;
        process.stdout.write("\u001b[?1049l");
      };
      process.once("exit", restoreTerminal);
      await new Promise<void>((resolve) => {
        const instance = render(React.createElement(App, { root }));
        instance.waitUntilExit().then(() => { restoreTerminal(); resolve(); });
      });
    }
  } else {
    await program.parseAsync();
  }
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
