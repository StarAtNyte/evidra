#!/usr/bin/env node
import { Command } from "commander";
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ResearchStore } from "./core/store.js";
import { materializeResearchDecision } from "./core/research-graph.js";
import { createExperimentManifest, createReplicationManifest, manifestSummary } from "./core/experiment-manifest.js";
import { activePhaseGoal, definePhaseGoals, evaluatePhaseGoalEvidence, phaseGoalsForMode } from "./core/phase-goals.js";
import { ExperimentManifestSchema, PhaseGoalSchema, RunResultSchema } from "./core/types.js";
import { loadCompetitionAdapter } from "./competitions/adapters.js";
import { auditData } from "./core/data-audit.js";
import { createValidationPolicy, writeValidationPolicy } from "./core/validation-policy.js";
import { estimateDistributionBeliefs, type ExternalValidationObservation } from "./core/distribution-beliefs.js";
import { advanceExecutionStage, createExecutionPlan, validateExecutionContract, type ExecutionStage } from "./core/execution-stages.js";
import { retrieveSource, sourceClaims, sourceSearchText, sourceIsFresh } from "./core/sources.js";
import { prepareSubmission, validateSubmissionBundle } from "./core/submissions.js";
import { submitApprovedBundle } from "./core/submission-adapters.js";
import { evaluateSubmissionPolicy } from "./core/submission-policy.js";
import { renderTimeline } from "./core/timeline.js";
import { latestSourcePayloads, researchMemoryContext } from "./core/research-context.js";
import { detectStagnation } from "./core/stagnation.js";
import { recoveryDelay, recoveryPlan } from "./core/recovery.js";
import { campaignElapsedMinutes, pauseCampaign, resumeCampaign } from "./core/campaign.js";
import { runReducedValidation } from "./core/stage-executor.js";
import { renderReport, writeReport, type ReportKind } from "./core/reports.js";
import { runProcess } from "./core/process.js";
import { executeResearchTool } from "./core/tools.js";
import { executorFor, parseMetricOutput } from "./core/executors.js";
import { sha256File } from "./core/evidence.js";
import { captureEnvironment } from "./core/environment.js";
import { ensureWorktree } from "./core/worktree.js";
import { compareRuns } from "./core/statistics.js";
import { evaluateTrajectory, type TrajectoryEvent } from "./core/trajectories.js";
import { extractUnifiedDiff } from "./core/experiment-patches.js";
import { formatResearchDecision, runResearchDirector } from "./agents/research-director.js";
import { runResearchLanes } from "./agents/research-lanes.js";
import { runResearchCritic } from "./agents/research-lanes.js";
import { checkProvider, codexLoginStatus, isProviderUsageLimit, listLocalModels, providerRetryAfterMs, runWithLocalFallback } from "./agents/codex-exec.js";
import { startInteractive } from "./session/interactive.js";
import { render } from "ink";
import React from "react";
import { App } from "./ui/app.js";
import { findWorkspaceRoot } from "./core/workspace.js";
import type { AutonomyLevel } from "./core/permissions.js";

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
  if (typeof value.proposedChange !== "string") return undefined;
  const match = value.proposedChange.match(/(?:^|\s)((?:examples|src|research)\/[A-Za-z0-9_./-]+\.py)\b/);
  return match?.[1];
}

function experimentCommandFor(adapter: ReturnType<typeof activeCompetition>, hypothesisPayload?: unknown): string[] {
  const command = adapter.experimentCommand();
  const estimator = candidateEstimatorPath(hypothesisPayload);
  if (!estimator) return command;
  const index = command.indexOf("--estimator");
  if (index >= 0 && command[index + 1]) command[index + 1] = estimator;
  return command;
}

async function runCampaignExperiment(rootPath: string, experimentId: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const script = process.argv[1];
  if (!script) throw new Error("Unable to locate the Evidra CLI entrypoint for autonomous experiment execution.");
  return runProcess([process.execPath, script, "experiment", "run", experimentId], rootPath, 7 * 24 * 60 * 60_000, (stream, chunk) => {
    (stream === "stderr" ? process.stderr : process.stdout).write(chunk);
  });
}

async function implementCampaignHypothesis(
  rootPath: string,
  experimentId: string,
  hypothesis: unknown,
  manifest: unknown,
  options: { provider: "codex" | "local"; model: string; thinking: string },
): Promise<void> {
  const worktree = await ensureWorktree(rootPath, rootPath, experimentId);
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
    await runWithLocalFallback(task, {
      provider: options.provider,
      model: options.model,
      cwd: worktree,
      reasoningEffort: options.thinking,
      sandbox: "workspace-write",
    }, undefined, (message) => console.log(`Experiment ${experimentId} · ${message}`));
    return;
  }
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
  const patchPath = join(worktree, `.evidra-patch-${experimentId}.diff`);
  writeFileSync(patchPath, `${diff}\n`);
  try {
    const check = await runProcess(["git", "apply", "--check", patchPath], worktree, 60_000);
    if (check.exitCode !== 0) throw new Error(`Local engineer patch failed validation: ${check.stderr || check.stdout}`);
    const applied = await runProcess(["git", "apply", "--whitespace=nowarn", patchPath], worktree, 60_000);
    if (applied.exitCode !== 0) throw new Error(`Local engineer patch could not be applied: ${applied.stderr || applied.stdout}`);
  } finally {
    try { unlinkSync(patchPath); } catch { /* patch cleanup is best effort */ }
  }
}

type ControllerDirective = "run" | "pause" | "stop";

function controllerDirective(): ControllerDirective {
  const path = process.env.EVIDRA_CONTROLLER_CONTROL_FILE;
  if (!path || !existsSync(path)) return "run";
  try {
    const payload = JSON.parse(readFileSync(path, "utf8")) as { action?: string };
    return payload.action === "pause" || payload.action === "stop" ? payload.action : "run";
  } catch {
    return "run";
  }
}

async function waitForControllerDirective(): Promise<"run" | "stop"> {
  while (true) {
    const directive = controllerDirective();
    if (directive === "stop") return "stop";
    if (directive === "run") return "run";
    await new Promise((resolve) => setTimeout(resolve, 5_000));
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
      store.saveSource({ id: source.id, payload: { ...source, claims: sourceClaims(source.text) } });
      store.appendEvent(prior ? "challenge.source.refreshed" : "challenge.source.ingested", { url, title: source.title, claims: sourceClaims(source.text).length, previousSource: prior ? (prior.payload as { id?: string }).id : undefined });
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
  }
  store.close();
});

program.command("doctor").description("Check local providers, runtimes, and execution backends").action(async () => {
  const checks: string[] = [`workspace     ${root}`, `node          ${process.versions.node}`];
  for (const command of ["git", "uv", "codex", "ollama", "modal"]) {
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
  console.log(`Project       ${project?.name ?? "not initialized"}`);
  console.log(`Events        ${store.eventCount()}`);
  console.log(`Hypotheses    ${counts.hypotheses}`);
  console.log(`Claims        ${counts.claims}`);
  console.log(`Decisions     ${counts.decisions}`);
  console.log(`Experiments   ${counts.experiments}`);
  console.log(`Runs          ${counts.runs}`);
  console.log(`Artifacts     ${counts.artifacts}`);
  console.log(`Trajectories  ${counts.trajectories}`);
  store.close();
});

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
sources.command("add").argument("<url>").action(async (url: string) => {
  const retrieved = await retrieveSource(url);
  const claims = sourceClaims(retrieved.text);
  const store = new ResearchStore(statePath);
  store.saveSource({ id: retrieved.id, payload: { ...retrieved, claims } });
  for (const [index, statement] of claims.entries()) store.saveClaim({ id: `${retrieved.id}_claim_${index + 1}`, payload: { id: `${retrieved.id}_claim_${index + 1}`, statement, scope: retrieved.url, confidence: 0.35, sourceType: "literature", sourceId: retrieved.id, status: "active" } });
  store.appendEvent("research.source.retrieved", { id: retrieved.id, url: retrieved.url, contentHash: retrieved.contentHash, claimCount: claims.length });
  store.close();
  console.log(`${retrieved.id}\n${retrieved.title}\n${retrieved.url}\nclaims: ${claims.length}\nhash: ${retrieved.contentHash}`);
});
program.addCommand(sources);

const memory = new Command("memory").description("Search durable research claims, hypotheses, and sources");
memory.command("search").argument("<query>").action((query: string) => {
  const store = new ResearchStore(statePath);
  const matches = store.searchMemory(query, 20);
  console.log(matches.length ? matches.map((match) => `${match.kind} ${match.id} · ${JSON.stringify(match.payload)}`).join("\n") : "No matching research memory.");
  store.close();
});
program.addCommand(memory);

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
challenge.command("audit").action(() => {
  const adapter = activeCompetition();
  const report = auditData(adapter.workspacePath(root));
  const store = new ResearchStore(statePath);
  store.appendEvent("data.audit.completed", report);
  store.close();
  console.log(JSON.stringify(report, null, 2));
});
challenge.command("policy").action(() => {
  const adapter = activeCompetition();
  const policy = createValidationPolicy(adapter.config);
  mkdirSync(join(root, ".sota"), { recursive: true });
  const path = join(root, ".sota", "validation-policy.json");
  console.log(`Validation policy: ${path}\nChecksum: ${writeValidationPolicy(path, policy)}\n${JSON.stringify(policy, null, 2)}`);
});
challenge.command("baseline").description("Run the canonical baseline").action(async () => {
  const adapter = activeCompetition();
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
  .option("--limit-policy <policy>", "on provider usage limit: wait, fallback, or stop", "wait")
  .option("--executor <executor>", "experiment execution target: local or modal", "local")
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
  .option("--limit-policy <policy>", "on provider usage limit: wait, fallback, or stop", "wait")
  .option("--executor <executor>", "experiment execution target: local or modal", "local")
  .option("--resume", "resume the latest durable non-completed research campaign")
  .option("--skip-baseline", "reuse the latest recorded baseline observation")
  .action(async (options: { mode: string; goal: string; budget: string; stop: string; provider: string; model: string; thinking: string; lanes: string; autonomy: string; limitPolicy: string; executor: string; resume?: boolean; skipBaseline?: boolean }) => {
    if (options.provider !== "codex" && options.provider !== "local") throw new Error("Provider must be 'codex' or 'local'.");
    if (!["wait", "fallback", "stop"].includes(options.limitPolicy)) throw new Error("Limit policy must be 'wait', 'fallback', or 'stop'.");
    if (options.mode !== "research" && options.mode !== "challenge") throw new Error("Mode must be 'research' or 'challenge'.");
    if (!["safe", "fast", "yolo"].includes(options.autonomy)) throw new Error("Autonomy must be 'safe', 'fast', or 'yolo'.");
    if (options.executor !== "local" && options.executor !== "modal") throw new Error("Executor must be 'local' or 'modal'.");
    const mode = options.mode as "research" | "challenge";
    const autonomy = options.autonomy as AutonomyLevel;
    const adapter = activeCompetition();
    await ingestCompetitionSources(adapter);
    const budget = durationMinutes(options.budget);
    const selectedModel = options.provider === "local" && options.model === "default" ? "qwen3.6:27b" : options.model;
    const laneLimit = Math.max(1, Math.min(6, Number.parseInt(options.lanes, 10) || 1));
    await checkProvider({ provider: options.provider, model: selectedModel, cwd: root });
    const releaseLease = acquireCliControllerLease(mode);
    const started = Date.now();
    const savedStore = new ResearchStore(statePath);
    const savedCampaign = savedStore.campaign() as { goal?: string; budgetMinutes?: number; stopCondition?: string; startedAt?: string; status?: "setup" | "running" | "paused" | "completed"; pausedAt?: string; pausedDurationMinutes?: number } | undefined;
    savedStore.close();
    const campaign: { goal: string; budgetMinutes: number; stopCondition: string; startedAt: string; status: "running" | "paused" | "completed"; pausedAt?: string; pausedDurationMinutes?: number } = options.resume && savedCampaign && savedCampaign.status !== "completed"
      ? { ...resumeCampaign({ goal: savedCampaign.goal ?? options.goal, budgetMinutes: savedCampaign.budgetMinutes ?? budget, stopCondition: savedCampaign.stopCondition ?? options.stop, startedAt: savedCampaign.startedAt ?? new Date(started).toISOString(), status: savedCampaign.status === "paused" ? "paused" : "running", pausedAt: savedCampaign.pausedAt, pausedDurationMinutes: savedCampaign.pausedDurationMinutes }), status: "running" }
      : { goal: options.goal, budgetMinutes: budget, stopCondition: options.stop, startedAt: new Date(started).toISOString(), status: "running" };
    if (options.resume) console.log(savedCampaign && savedCampaign.status !== "completed" ? `Resuming durable research campaign from ${savedCampaign.startedAt ?? "saved state"}.` : "No resumable campaign found; starting a new research campaign.");
    const objective = `${campaign.goal}. Stop condition: ${campaign.stopCondition}`;
    let cycle = 0;
    do {
      const directive = await waitForControllerDirective();
      if (directive === "stop") {
        campaign.status = "paused";
        const stoppedStore = new ResearchStore(statePath);
        stoppedStore.saveCampaign(campaign);
        stoppedStore.appendEvent("research.controller.stop", { cycle, reason: "remote controller stop request" });
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
      const phaseGoal = activePhaseGoal(phaseGoalsForMode(store.phaseGoals().map((entry) => PhaseGoalSchema.parse(entry.payload)), mode));
      const recentEvents = store.recentEvents(20);
      const researchSources = latestSourcePayloads(store.sources(), 12);
      const researchMemory = researchMemoryContext(store, 30);
      console.log(`${mode === "challenge" ? "Challenge" : "Research"} ${cycle} · inspecting workspace${mode === "challenge" ? " and baseline" : ""} (budget ${campaign.budgetMinutes}m)...`);
      const gitStatus = await runProcess(["git", "status", "--short"], root);
      const files = await runProcess(["rg", "--files", "-g", "!.sota/**", "-g", "!node_modules/**"], root, 60_000);
      const priorBaseline = mode === "challenge" ? store.recentEvents(100).reverse().find((event) => event.type === "baseline.completed") : undefined;
      let baseline: { exitCode: number; durationMs: number; stdout: string; stderr: string } | undefined;
      if (mode === "challenge" && options.skipBaseline && priorBaseline) {
        const payload = priorBaseline.payload as { exitCode?: number; durationMs?: number; stdout?: string; stderr?: string };
        baseline = { exitCode: payload.exitCode ?? 0, durationMs: payload.durationMs ?? 0, stdout: payload.stdout ?? "", stderr: payload.stderr ?? "" };
        console.log("Research · reusing the latest recorded baseline observation (--skip-baseline).");
      } else if (mode === "challenge") {
        if (options.skipBaseline) throw new Error("--skip-baseline requested, but no baseline.completed event exists. Run evidra baseline first.");
        baseline = await runProcess(adapter.baselineCommand(), adapter.workspacePath(root), adapter.config.evaluatorTimeoutMinutes * 60_000);
      }
      if (mode === "challenge" && baseline && !(options.skipBaseline && priorBaseline)) {
        const metric = parseMetricOutput(baseline.stdout, adapter.config.metric.name).metrics[adapter.config.metric.name] ?? null;
        store.appendEvent(baseline.exitCode === 0 ? "baseline.completed" : "baseline.failed", { command: adapter.baselineCommand(), cwd: adapter.workspacePath(root), exitCode: baseline.exitCode, durationMs: baseline.durationMs, metric, stdout: baseline.stdout, stderr: baseline.stderr });
      }
      const observation = { gitStatus: gitStatus.stdout.trim().split("\n").filter(Boolean).slice(0, 40), repositoryFiles: files.stdout.trim().split("\n").filter(Boolean).slice(0, 120), ...(baseline ? { baseline: { exitCode: baseline.exitCode, durationMs: baseline.durationMs, stdout: baseline.stdout.slice(-4000), stderr: baseline.stderr.slice(-4000) } } : {}) };
      store.appendEvent("research.observation", observation);
      store.saveClaim({ id: `claim_observation_${Date.now()}`, payload: { statement: "Repository inspection and canonical baseline execution completed before the research decision.", scope: "current-workspace", confidence: 1, sourceType: "observation", sourceId: `observation_${Date.now()}`, status: "active", observation } });
      store.close();
      const projectStore = new ResearchStore(statePath);
      const activeProject = projectStore.project();
      projectStore.close();
      let decision: Awaited<ReturnType<typeof runResearchDirector>>;
      let criticReview: Awaited<ReturnType<typeof runResearchCritic>> | undefined;
      let laneReports: Awaited<ReturnType<typeof runResearchLanes>> = [];
      while (true) {
        try {
          console.log("Research · independent lanes are investigating the evidence...");
          laneReports = await runResearchLanes(objective, {
            project: activeProject,
            competition: adapter.config,
            observation,
            recentEvents,
            researchSources,
            ultimateGoal: options.goal,
            phaseGoal: phaseGoal ?? null,
            researchMemory,
          }, {
            provider: options.provider,
            model: selectedModel,
            fallbackLocalModel: options.limitPolicy === "fallback" ? (process.env.EVIDRA_FALLBACK_MODEL ?? "auto") : undefined,
            limitPolicy: options.limitPolicy as "wait" | "fallback" | "stop",
            reasoningEffort: options.thinking,
            cwd: root,
            storePath: statePath,
            maxParallel: laneLimit,
            autonomy,
          });
          console.log("Research · director is cross-pollinating lane findings...");
          decision = await runResearchDirector(objective, { project: activeProject, competition: adapter.config, constraints: { no_submission: true, no_file_edits: true }, recentEvents, researchSources, observation, ultimateGoal: campaign.goal, phaseGoal: phaseGoal ?? null, laneReports, researchMemory }, { provider: options.provider, model: selectedModel, reasoningEffort: options.thinking, limitPolicy: options.limitPolicy as "wait" | "fallback" | "stop", fallbackLocalModel: options.limitPolicy === "fallback" && options.provider === "codex" ? (process.env.EVIDRA_FALLBACK_MODEL ?? "auto") : undefined, cwd: root, executeTool: researchToolExecutor(adapter, autonomy) });
          criticReview = await runResearchCritic(objective, decision, laneReports, {
            provider: options.provider,
            model: selectedModel,
            fallbackLocalModel: options.limitPolicy === "fallback" ? (process.env.EVIDRA_FALLBACK_MODEL ?? "auto") : undefined,
            limitPolicy: options.limitPolicy as "wait" | "fallback" | "stop",
            reasoningEffort: options.thinking,
            cwd: root,
            storePath: statePath,
            maxParallel: 1,
            autonomy,
          });
          break;
        } catch (error) {
          if (options.limitPolicy !== "wait" || !isProviderUsageLimit(error)) throw error;
          const delay = providerRetryAfterMs(error);
          const remainingMs = budget * 60_000 - (Date.now() - started);
          if (remainingMs <= 0) throw new Error("Research budget expired while waiting for the provider usage limit to reset.");
          const waitMs = Math.min(delay, remainingMs);
          console.log(`Provider usage limit reached; waiting ${Math.ceil(waitMs / 60_000)} minute(s) before retrying. Campaign state is durable.`);
          await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        }
      }
      let decisionStore = new ResearchStore(statePath);
      const criticBlocks = criticReview !== undefined && criticReview.verdict !== "proceed";
      if (criticBlocks) {
        decisionStore.appendEvent("research.critic.gate", { verdict: criticReview?.verdict, confidence: criticReview?.confidence, objections: criticReview?.objections, requiredChecks: criticReview?.requiredChecks });
        if (decision.goalStatus !== "blocked") {
          decision = {
            ...decision,
            goalStatus: "active",
            decision: ["stop", "run", "replicate"].includes(decision.decision) ? "inspect" : decision.decision,
            nextAction: `${decision.nextAction} Critic verdict is ${criticReview?.verdict}; resolve its objections before execution or stopping.`,
          };
        }
      }
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
      if (!criticBlocks && decision.decision === "run" && decision.selectedHypothesis) {
        const selectedIndex = decision.hypotheses.findIndex((hypothesis) => hypothesis.title === decision.selectedHypothesis);
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
              gitCommit: commit.stdout.trim(),
              datasetVersion: adapter.config.datasetRevision,
              executor: options.executor as "local" | "modal",
              configPatch: { estimatorPath: candidateEstimatorPath(selectedHypothesis) ?? adapter.config.evaluator.estimatorPath },
            }, adapter.config);
            decisionStore.saveExperiment({ id: experimentId, payload: { ...manifest, status: "proposed", executionPlan: createExecutionPlan(manifest) } });
            decisionStore.appendEvent("experiment.autonomous.scheduled", { experimentId, hypothesisId: selectedHypothesisId, decision: decision.decision, executor: options.executor });
            console.log(`Autonomous experiment scheduled: ${experimentId}\n${manifestSummary(manifest)}`);
            decisionStore.close();
            let run: { exitCode: number; stdout: string; stderr: string };
            try {
              await implementCampaignHypothesis(root, experimentId, selectedHypothesis, manifest, { provider: options.provider as "codex" | "local", model: selectedModel, thinking: options.thinking });
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
            const completionStore = new ResearchStore(statePath);
            completionStore.appendEvent(run.exitCode === 0 ? "experiment.autonomous.completed" : "experiment.autonomous.failed", { experimentId, exitCode: run.exitCode, stdout: run.stdout.slice(-4000), stderr: run.stderr.slice(-4000) });
            const comparisonEvent = completionStore.recentEvents(500).reverse().find((event) => event.type === "experiment.comparison.completed" && (event.payload as { experimentId?: unknown }).experimentId === experimentId);
            const comparison = comparisonEvent?.payload as { comparison?: { direction?: string } } | undefined;
            const parent = completionStore.experiments().find((entry) => entry.id === experimentId);
            const parentManifest = parent ? ExperimentManifestSchema.safeParse(parent.payload) : undefined;
            if (run.exitCode === 0 && comparison?.comparison?.direction === "improved" && parentManifest?.success && parentManifest.data.acceptance.requireReplication) {
              const replication = createReplicationManifest(parentManifest.data, adapter.config);
              completionStore.saveExperiment({ id: replication.id, payload: { ...replication, status: "proposed", replicationOf: experimentId, automatic: true, executionPlan: createExecutionPlan(replication) } });
              completionStore.appendEvent("replication.manifest.created", { parentId: experimentId, replicationId: replication.id, automatic: true });
              console.log(`Independent replication scheduled: ${replication.id}\n${manifestSummary(replication)}`);
              completionStore.close();
              const replicationRun = await runCampaignExperiment(root, replication.id);
              const replicationStore = new ResearchStore(statePath);
              replicationStore.appendEvent(replicationRun.exitCode === 0 ? "experiment.autonomous.replication.completed" : "experiment.autonomous.replication.failed", { parentId: experimentId, replicationId: replication.id, exitCode: replicationRun.exitCode, stdout: replicationRun.stdout.slice(-4000), stderr: replicationRun.stderr.slice(-4000) });
              replicationStore.close();
            } else {
              completionStore.close();
            }
            decisionStore = new ResearchStore(statePath);
          }
        }
      }
      const trajectoryStamp = `research-${Date.now()}`;
      const researchTrajectoryEvents: TrajectoryEvent[] = [
        { id: `${trajectoryStamp}-observation`, kind: "process", payload: { status: "completed", observationKeys: Object.keys(observation) } },
        ...laneReports.filter((lane) => lane.status === "failed").map((lane, index) => ({ id: `${trajectoryStamp}-lane-${index}`, kind: "process" as const, payload: { status: "failed", error: lane.error ?? `${lane.role} failed` } })),
        { id: `${trajectoryStamp}-evaluator`, kind: "evaluator", payload: { evidenceConsistent: Boolean(criticReview && criticReview.verdict !== "reject"), criticVerdict: criticReview?.verdict ?? "missing" } },
        { id: `${trajectoryStamp}-terminal`, kind: "terminal", payload: { status: "completed", goalStatus: decision.goalStatus, goalAttained: decision.goalStatus === "met" || decision.decision === "stop" } },
      ];
      const researchQuality = evaluateTrajectory(researchTrajectoryEvents);
      decisionStore.saveTrajectory({ id: `trajectory_research_${Date.now()}`, payload: { objective, observation, laneReports, criticReview, decision }, quality: researchQuality });
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
    const baseline = await runProcess(adapter.baselineCommand(), adapter.workspacePath(root), adapter.config.evaluatorTimeoutMinutes * 60_000);
    const observation = {
      gitStatus: gitStatus.stdout.trim().split("\n").filter(Boolean).slice(0, 40),
      repositoryFiles: files.stdout.trim().split("\n").filter(Boolean).slice(0, 120),
      baseline: { exitCode: baseline.exitCode, durationMs: baseline.durationMs, stdout: baseline.stdout.slice(-4000), stderr: baseline.stderr.slice(-4000) },
    };
    const metric = parseMetricOutput(baseline.stdout, adapter.config.metric.name).metrics[adapter.config.metric.name] ?? null;
    store.appendEvent(baseline.exitCode === 0 ? "baseline.completed" : "baseline.failed", { command: adapter.baselineCommand(), cwd: adapter.workspacePath(root), exitCode: baseline.exitCode, durationMs: baseline.durationMs, metric, stdout: baseline.stdout, stderr: baseline.stderr });
    store.appendEvent("research.observation", observation);
    store.saveClaim({ id: `claim_observation_${Date.now()}`, payload: { statement: "Repository inspection and canonical baseline execution completed before the research decision.", scope: "current-workspace", confidence: 1, sourceType: "observation", sourceId: `observation_${Date.now()}`, status: "active", observation } });
    const recentEvents = store.recentEvents(20);
    const researchMemory = researchMemoryContext(store, 30);
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
    const command = adapter.baselineCommand();
    if (options.name !== "mean_propagation" && adapter.id === "arc-whestbench-2026") {
      command.push("--baseline", options.name);
    }
    const result = await runProcess(command, adapter.workspacePath(root), adapter.config.evaluatorTimeoutMinutes * 60_000);
    const store = new ResearchStore(statePath);
    store.appendEvent("baseline.completed", { command, cwd: adapter.workspacePath(root), exitCode: result.exitCode, durationMs: result.durationMs, stdout: result.stdout, stderr: result.stderr });
    store.close();
    console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  });

const experiment = new Command("experiment").description("Manage research experiments");
experiment.command("propose")
  .argument("[hypothesis]", "hypothesis identifier; defaults to the newest hypothesis")
  .option("--executor <executor>", "experiment executor: local or modal", "local")
  .action(async (hypothesisId: string | undefined, options: { executor: string }) => {
    if (options.executor !== "local" && options.executor !== "modal") throw new Error("Executor must be 'local' or 'modal'.");
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
    const manifest = createExperimentManifest({ id, hypothesisId: hypothesis, gitCommit: commit.stdout.trim(), datasetVersion: adapter.config.datasetRevision, executor: options.executor, configPatch: { estimatorPath: candidateEstimatorPath(store.hypotheses().find((entry) => entry.id === hypothesis)?.payload) ?? adapter.config.evaluator.estimatorPath } }, adapter.config);
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
  .action(async (id: string) => {
    const adapter = activeCompetition();
    const store = new ResearchStore(statePath);
    const entry = store.experiments().find((candidate) => candidate.id === id);
    if (!entry) { store.close(); throw new Error(`Experiment ${id} is not registered. Run: evidra experiment propose`); }
    const manifest = ExperimentManifestSchema.parse(entry.payload);
    let executionPlan: ExecutionStage[] = Array.isArray((entry.payload as { executionPlan?: unknown }).executionPlan)
      ? (entry.payload as { executionPlan: ExecutionStage[] }).executionPlan
      : createExecutionPlan(manifest);
    const hypothesis = store.hypotheses().find((candidate) => candidate.id === manifest.hypothesisId);
    store.saveExperiment({ id, payload: { ...(entry.payload as Record<string, unknown>), status: "running" } });
    store.close();
    const worktreePath = await ensureWorktree(root, root, id);
    const experimentCwd = join(worktreePath, relative(root, adapter.workspacePath(root)));
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
    executionPlan = advanceExecutionStage(executionPlan, "smoke", "skipped");
    const stageStore = new ResearchStore(statePath);
    stageStore.appendEvent("experiment.stage.smoke.skipped", { experimentId: id, reason: "manifest has no configured smoke command" });
    stageStore.close();
    const reducedCommand = adapter.config.execution?.reducedValidationCommand;
    if (reducedCommand) {
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
      const reduced = await runReducedValidation(executor, manifest, experimentCwd, reducedCommand, adapter.config.metric.name);
      executionPlan = advanceExecutionStage(executionPlan, "reduced_validation", reduced.status === "completed" ? "completed" : "failed");
      const reducedStore = new ResearchStore(statePath);
      reducedStore.appendEvent(reduced.status === "completed" ? "experiment.stage.reduced_validation.completed" : "experiment.stage.reduced_validation.failed", { experimentId: id, runId: reduced.runId, metric: reduced.metrics[adapter.config.metric.name] ?? null, exitCode: reduced.exitCode, command: reducedCommand });
      if (reduced.status !== "completed") reducedStore.saveExperiment({ id, payload: { ...(entry.payload as Record<string, unknown>), status: "failed", executionPlan } });
      reducedStore.close();
      if (reduced.status !== "completed") throw new Error(`Reduced validation failed (${reduced.exitCode}): ${reduced.stderr || reduced.stdout}`);
    } else {
      executionPlan = advanceExecutionStage(executionPlan, "reduced_validation", "skipped");
      const skippedStore = new ResearchStore(statePath);
      skippedStore.appendEvent("experiment.stage.reduced_validation.skipped", { experimentId: id, reason: "manifest has no generic reduced-data contract" });
      skippedStore.close();
    }
    let result = await executor.run(manifest, experimentCwd, command, undefined, adapter.config.metric.name);
    let attempt = 1;
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
      result = await executor.run(manifest, experimentCwd, command, undefined, adapter.config.metric.name);
    }
    const evaluatorCommand = isCandidateEvaluation ? command : adapter.config.evaluator.command;
    const sameCommand = evaluatorCommand.length === command.length && evaluatorCommand.every((part, index) => part === command[index]);
    let evaluator: { stdout: string; stderr: string; exitCode: number } | undefined;
    if (result.status === "completed" && !sameCommand) {
      const evaluated = await runProcess(evaluatorCommand, experimentCwd, manifest.resources.timeoutMinutes * 60_000);
      evaluator = { stdout: evaluated.stdout, stderr: evaluated.stderr, exitCode: evaluated.exitCode };
      const parsed = parseMetricOutput(evaluated.stdout, adapter.config.metric.name);
      result = { ...result, status: evaluated.exitCode === 0 ? "completed" : "failed", exitCode: evaluated.exitCode, metrics: { ...result.metrics, ...parsed.metrics }, metricsByFold: { ...result.metricsByFold, ...parsed.metricsByFold }, stdout: `${result.stdout ?? ""}\n[EVALUATOR]\n${evaluated.stdout}`, stderr: `${result.stderr ?? ""}\n[EVALUATOR]\n${evaluated.stderr}`, ...(evaluated.exitCode === 0 ? {} : { failureClass: "unknown" as const }) };
    }
    executionPlan = advanceExecutionStage(executionPlan, "full_validation", result.status === "completed" ? "completed" : "failed");
    const fullStageStore = new ResearchStore(statePath);
    fullStageStore.appendEvent(result.status === "completed" ? "experiment.stage.full_validation.completed" : "experiment.stage.full_validation.failed", { experimentId: id, runId: result.runId, metric: result.metrics[adapter.config.metric.name] ?? null, exitCode: result.exitCode, attempts: attempt });
    fullStageStore.close();
    const artifactDir = join(root, ".sota", "artifacts", result.runId);
    mkdirSync(artifactDir, { recursive: true });
    const artifactPaths: Record<string, string> = {};
    const environment = await captureEnvironment(root, result.cwd ?? experimentCwd, result.command ?? command, manifest.resources.executor, manifest.resources.gpu);
    for (const [name, content] of Object.entries({ "stdout.log": result.stdout ?? "", "stderr.log": result.stderr ?? "", "metrics.json": `${JSON.stringify(result.metrics, null, 2)}\n`, "environment.json": `${JSON.stringify(environment, null, 2)}\n`, ...(evaluator ? { "evaluator.stdout.log": evaluator.stdout, "evaluator.stderr.log": evaluator.stderr } : {}) })) {
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
      { id: `${result.runId}-terminal`, kind: "terminal", payload: { status: recorded.status, goalAttained: recorded.status === "completed" && recorded.metrics[adapter.config.metric.name] !== undefined } },
    ];
    const experimentQuality = evaluateTrajectory(experimentTrajectoryEvents);
    resultStore.saveTrajectory({ id: `trajectory_${result.runId}`, runId: result.runId, experimentId: id, payload: { manifest, hypothesis: hypothesis?.payload ?? null, events: experimentTrajectoryEvents }, quality: experimentQuality });
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
        resultStore.appendEvent("experiment.comparison.completed", { experimentId: id, baselineSource: baselineEvent?.createdAt ?? "baseline", comparison });
      } else {
        resultStore.appendEvent("experiment.comparison.insufficient_data", { experimentId: id, reason: "No finite baseline metric was available." });
      }
    }
    resultStore.saveExperiment({ id, payload: { ...(entry.payload as Record<string, unknown>), status: recorded.status === "completed" ? "completed" : "failed", runId: result.runId, worktreePath: experimentCwd, executionPlan } });
    resultStore.close();
    console.log(`Experiment ${id}: ${recorded.status}`);
    console.log(`Run: ${result.runId}`);
    console.log(`Metric (${adapter.config.metric.name}): ${recorded.metrics[adapter.config.metric.name] ?? "not parsed"}`);
    console.log(`Artifacts: ${Object.keys(artifactPaths).join(", ")}`);
    if (recorded.exitCode !== 0) process.exitCode = recorded.exitCode;
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
