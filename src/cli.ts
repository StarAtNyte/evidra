#!/usr/bin/env node
import { Command } from "commander";
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ResearchStore } from "./core/store.js";
import { materializeResearchDecision } from "./core/research-graph.js";
import { createExperimentManifest, manifestSummary } from "./core/experiment-manifest.js";
import { activePhaseGoal, definePhaseGoals } from "./core/phase-goals.js";
import { ExperimentManifestSchema, PhaseGoalSchema, RunResultSchema } from "./core/types.js";
import { loadCompetitionAdapter } from "./competitions/adapters.js";
import { auditData } from "./core/data-audit.js";
import { createValidationPolicy, writeValidationPolicy } from "./core/validation-policy.js";
import { retrieveSource, sourceClaims, sourceSearchText } from "./core/sources.js";
import { prepareSubmission, validateSubmissionBundle } from "./core/submissions.js";
import { submitApprovedBundle } from "./core/submission-adapters.js";
import { renderReport, writeReport, type ReportKind } from "./core/reports.js";
import { runProcess } from "./core/process.js";
import { executeResearchTool } from "./core/tools.js";
import { executorFor, parseMetricOutput } from "./core/executors.js";
import { sha256File } from "./core/evidence.js";
import { captureEnvironment } from "./core/environment.js";
import { ensureWorktree } from "./core/worktree.js";
import { formatResearchDecision, runResearchDirector } from "./agents/research-director.js";
import { runResearchLanes } from "./agents/research-lanes.js";
import { runResearchCritic } from "./agents/research-lanes.js";
import { checkProvider, codexLoginStatus, isProviderUsageLimit, listLocalModels, providerRetryAfterMs } from "./agents/codex-exec.js";
import { startInteractive } from "./session/interactive.js";
import { render } from "ink";
import React from "react";
import { App } from "./ui/app.js";
import { findWorkspaceRoot } from "./core/workspace.js";

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

const researchToolExecutor = (competition: ReturnType<typeof activeCompetition>) => (call: Parameters<typeof executeResearchTool>[0]) => executeResearchTool(call, {
  root,
  storePath: statePath,
  autonomy: "safe",
  competition: competition.config,
  onProgress: (message) => console.log(`· ${message}`),
});

function durationMinutes(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|minutes?|h|hours?|d|days?)?$/i);
  if (!match) throw new Error(`Invalid duration '${value}'. Use 90m, 4h, or 2d.`);
  const multiplier = (match[2] ?? "m").toLowerCase().startsWith("h") ? 60 : (match[2] ?? "m").toLowerCase().startsWith("d") ? 1440 : 1;
  return Math.max(1, Math.round(Number(match[1]) * multiplier));
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

async function ingestCompetitionSources(adapter: ReturnType<typeof activeCompetition>): Promise<void> {
  if (!adapter.config.researchSources?.length) return;
  const store = new ResearchStore(statePath);
  const known = new Set(store.sources().map((entry) => (entry.payload as { url?: string }).url).filter(Boolean));
  for (const url of adapter.config.researchSources) {
    if (known.has(url)) continue;
    try {
      const source = await retrieveSource(url);
      store.saveSource({ id: source.id, payload: { ...source, claims: sourceClaims(source.text) } });
      store.appendEvent("challenge.source.ingested", { url, title: source.title, claims: sourceClaims(source.text).length });
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
  checks.push(`modal auth    ${process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET ? "configured" : "not configured"}`);
  console.log(checks.join("\n"));
});

const controller = new Command("controller").description("Inspect or control a headless Modal Evidra controller");
function controllerEntrypoint(): string {
  return process.env.EVIDRA_MODAL_CONTROLLER_ENTRYPOINT ?? "modal_controller.py::run";
}
async function invokeModalController(action: "status" | "pause" | "resume" | "stop"): Promise<void> {
  const result = await runProcess(["modal", "run", controllerEntrypoint(), "--", "--action", action], root, 120_000);
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
submission.command("submit").argument("<bundle>").option("--message <message>", "submission message", "Evidra research submission").action(async (bundle: string, options: { message: string }) => {
  const store = new ResearchStore(statePath);
  const entry = store.submissions().find((candidate) => candidate.id === bundle);
  if (!entry) { store.close(); throw new Error(`Submission bundle ${bundle} is not registered.`); }
  if (entry.status !== "approved") { store.close(); throw new Error(`Submission ${bundle} is '${entry.status}'. Run submission approve first.`); }
  const adapter = activeCompetition();
  try {
    const attempt = await submitApprovedBundle(root, entry.path, adapter.config, options.message);
    store.updateSubmissionStatus(bundle, "submitted", { ...(typeof entry.payload === "object" && entry.payload ? entry.payload : {}), receipt: attempt.receipt });
    store.appendEvent("submission.external.submitted", { id: bundle, platform: attempt.receipt.platform, predictionFile: attempt.receipt.predictionFile, submittedAt: attempt.receipt.submittedAt });
    console.log(`Submitted ${bundle} via ${attempt.receipt.platform}\n${attempt.receipt.stdout.trim()}`);
  } finally { store.close(); }
});
submission.command("record").argument("<bundle>").requiredOption("--public-score <score>", "score returned by the competition platform").option("--platform <name>", "platform or evaluation source", "manual").action((bundle: string, options: { publicScore: string; platform: string }) => {
  const score = Number(options.publicScore);
  if (!Number.isFinite(score)) throw new Error("Public score must be a finite number.");
  const store = new ResearchStore(statePath);
  const entry = store.submissions().find((candidate) => candidate.id === bundle);
  if (!entry) { store.close(); throw new Error(`Submission bundle ${bundle} is not registered.`); }
  const validation = validateSubmissionBundle(entry.path);
  if (!validation.valid) { store.close(); throw new Error(`Submission bundle is not valid; score was not recorded.`); }
  const recordedAt = new Date().toISOString();
  store.updateSubmissionStatus(bundle, "scored", { ...(typeof entry.payload === "object" && entry.payload ? entry.payload : {}), publicScore: score, platform: options.platform, recordedAt });
  store.saveClaim({ id: `claim_external_score_${bundle}_${Date.now()}`, payload: { statement: `External ${options.platform} score for ${bundle}: ${score}`, scope: entry.experimentId, confidence: 1, sourceType: "external_score", sourceId: bundle, status: "active", score, platform: options.platform, recordedAt } });
  store.appendEvent("submission.score.recorded", { id: bundle, score, platform: options.platform, recordedAt });
  store.close();
  console.log(`Recorded ${options.platform} score ${score} for ${bundle}.`);
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
  console.log(`Challenge: ${adapter.config.name}\nInitialized: ${active?.competitionId === adapter.id ? "yes" : "no"}`);
  store.close();
});
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
program.addCommand(challenge);

const research = new Command("research").description("Ask the embedded research agent for the next research decision");
research
  .option("--goal <goal>", "ultimate research goal", "Improve the current workspace or research problem with robust, reproducible evidence")
  .option("--budget <duration>", "autonomous budget, e.g. 90m or 4h", "60m")
  .option("--stop <condition>", "campaign stopping condition", "stop when the research director has sufficient evidence for the stated goal")
  .option("--provider <provider>", "agent provider: codex or local", "codex")
  .option("--model <model>", "provider model; use default for Codex", "default")
  .option("--thinking <effort>", "reasoning effort", "high")
  .option("--lanes <count>", "maximum independent research lanes", "3")
  .option("--limit-policy <policy>", "on provider usage limit: wait, fallback, or stop", "wait")
  .action(async (options: { goal: string; budget: string; stop: string; provider: string; model: string; thinking: string; lanes: string; limitPolicy: string }) => {
    if (options.provider !== "codex" && options.provider !== "local") throw new Error("Provider must be 'codex' or 'local'.");
    if (!["wait", "fallback", "stop"].includes(options.limitPolicy)) throw new Error("Limit policy must be 'wait', 'fallback', or 'stop'.");
    const adapter = activeCompetition();
    await ingestCompetitionSources(adapter);
    const objective = `${options.goal}. Stop condition: ${options.stop}`;
    const budget = durationMinutes(options.budget);
    const selectedModel = options.provider === "local" && options.model === "default" ? "qwen3.6:27b" : options.model;
    const laneLimit = Math.max(1, Math.min(6, Number.parseInt(options.lanes, 10) || 1));
    await checkProvider({ provider: options.provider, model: selectedModel, cwd: root });
    const started = Date.now();
    const campaign: { goal: string; budgetMinutes: number; stopCondition: string; startedAt: string; status: "running" | "paused" | "completed" } = { goal: options.goal, budgetMinutes: budget, stopCondition: options.stop, startedAt: new Date(started).toISOString(), status: "running" };
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
      const store = new ResearchStore(statePath);
      if (!store.project()) store.createProject({ id: `evidra-${adapter.id}`, name: adapter.config.name, competitionId: adapter.id, config: adapter.config });
      store.saveCampaign(campaign);
      if (!store.phaseGoals().length) for (const goal of definePhaseGoals(objective, "research")) store.savePhaseGoal({ id: goal.id, phase: goal.phase, status: goal.status, payload: goal });
      const phaseGoal = activePhaseGoal(store.phaseGoals().map((entry) => PhaseGoalSchema.parse(entry.payload)));
      const recentEvents = store.recentEvents(20);
      const researchSources = store.sources().slice(0, 12).map((entry) => entry.payload);
      console.log(`Research ${cycle} · inspecting workspace and baseline (budget ${budget}m)...`);
      const gitStatus = await runProcess(["git", "status", "--short"], root);
      const files = await runProcess(["rg", "--files", "-g", "!.sota/**", "-g", "!node_modules/**"], root, 60_000);
      const baseline = await runProcess(adapter.baselineCommand(), adapter.workspacePath(root), adapter.config.evaluatorTimeoutMinutes * 60_000);
      const observation = { gitStatus: gitStatus.stdout.trim().split("\n").filter(Boolean).slice(0, 40), repositoryFiles: files.stdout.trim().split("\n").filter(Boolean).slice(0, 120), baseline: { exitCode: baseline.exitCode, durationMs: baseline.durationMs, stdout: baseline.stdout.slice(-4000), stderr: baseline.stderr.slice(-4000) } };
      store.appendEvent("research.observation", observation);
      store.saveClaim({ id: `claim_observation_${Date.now()}`, payload: { statement: "Repository inspection and canonical baseline execution completed before the research decision.", scope: "current-workspace", confidence: 1, sourceType: "observation", sourceId: `observation_${Date.now()}`, status: "active", observation } });
      store.close();
      const projectStore = new ResearchStore(statePath);
      const activeProject = projectStore.project();
      projectStore.close();
      let decision: Awaited<ReturnType<typeof runResearchDirector>>;
      let criticReview: Awaited<ReturnType<typeof runResearchCritic>> | undefined;
      while (true) {
        try {
          console.log("Research · independent lanes are investigating the evidence...");
          const laneReports = await runResearchLanes(objective, {
            project: activeProject,
            competition: adapter.config,
            observation,
            recentEvents,
            researchSources,
            ultimateGoal: options.goal,
            phaseGoal: phaseGoal ?? null,
          }, {
            provider: options.provider,
            model: selectedModel,
            fallbackLocalModel: options.limitPolicy === "fallback" ? (process.env.EVIDRA_FALLBACK_MODEL ?? "auto") : undefined,
            limitPolicy: options.limitPolicy as "wait" | "fallback" | "stop",
            reasoningEffort: options.thinking,
            cwd: root,
            storePath: statePath,
            maxParallel: laneLimit,
            autonomy: "fast",
          });
          console.log("Research · director is cross-pollinating lane findings...");
          decision = await runResearchDirector(objective, { project: activeProject, competition: adapter.config, constraints: { no_submission: true, no_file_edits: true }, recentEvents, researchSources, observation, ultimateGoal: options.goal, phaseGoal: phaseGoal ?? null, laneReports }, { provider: options.provider, model: selectedModel, reasoningEffort: options.thinking, limitPolicy: options.limitPolicy as "wait" | "fallback" | "stop", fallbackLocalModel: options.limitPolicy === "fallback" && options.provider === "codex" ? (process.env.EVIDRA_FALLBACK_MODEL ?? "auto") : undefined, cwd: root, executeTool: researchToolExecutor(adapter) });
          criticReview = await runResearchCritic(objective, decision, laneReports, {
            provider: options.provider,
            model: selectedModel,
            fallbackLocalModel: options.limitPolicy === "fallback" ? (process.env.EVIDRA_FALLBACK_MODEL ?? "auto") : undefined,
            limitPolicy: options.limitPolicy as "wait" | "fallback" | "stop",
            reasoningEffort: options.thinking,
            cwd: root,
            storePath: statePath,
            maxParallel: 1,
            autonomy: "fast",
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
      const decisionStore = new ResearchStore(statePath);
      materializeResearchDecision(decisionStore, decision);
      if (phaseGoal) {
        const now = new Date().toISOString();
        const goals = decisionStore.phaseGoals().map((entry) => PhaseGoalSchema.parse(entry.payload));
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
      const elapsedMinutes = (Date.now() - started) / 60_000;
      const terminal = decision.decision === "stop" || decision.goalStatus === "blocked" || elapsedMinutes >= budget;
      if (terminal) {
        campaign.status = decision.goalStatus === "blocked" ? "paused" : "completed";
        decisionStore.saveCampaign(campaign);
      }
      decisionStore.close();
      console.log(formatResearchDecision(decision));
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
    const phaseGoal = activePhaseGoal(store.phaseGoals().map((entry) => PhaseGoalSchema.parse(entry.payload)));
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
    store.appendEvent("research.observation", observation);
    store.saveClaim({ id: `claim_observation_${Date.now()}`, payload: { statement: "Repository inspection and canonical baseline execution completed before the research decision.", scope: "current-workspace", confidence: 1, sourceType: "observation", sourceId: `observation_${Date.now()}`, status: "active", observation } });
    const recentEvents = store.recentEvents(20);
    store.close();
    console.log("Research 3/3 · analyzing observed evidence...");
    const decision = await runResearchDirector(objective, {
      project,
      competition: adapter.config,
      constraints: { no_submission: true, no_file_edits: true },
      recentEvents,
      observation,
      ultimateGoal: objective,
      phaseGoal: phaseGoal ?? null,
    }, { provider: "codex", model: "default", reasoningEffort: "medium", fallbackLocalModel: "qwen3.6:27b", cwd: root, executeTool: researchToolExecutor(adapter) });
    const decisionStore = new ResearchStore(statePath);
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
    const manifest = createExperimentManifest({ id, hypothesisId: hypothesis, gitCommit: commit.stdout.trim(), datasetVersion: adapter.config.datasetRevision, executor: options.executor }, adapter.config);
    store.saveExperiment({ id, payload: { ...manifest, status: "proposed" } });
    store.close();
    console.log(`Immutable experiment manifest created\n${manifestSummary(manifest)}`);
  });
experiment.command("run")
  .argument("<id>", "experiment identifier")
  .action(async (id: string) => {
    const adapter = activeCompetition();
    const store = new ResearchStore(statePath);
    const entry = store.experiments().find((candidate) => candidate.id === id);
    if (!entry) { store.close(); throw new Error(`Experiment ${id} is not registered. Run: evidra experiment propose`); }
    const manifest = ExperimentManifestSchema.parse(entry.payload);
    store.saveExperiment({ id, payload: { ...(entry.payload as Record<string, unknown>), status: "running" } });
    store.close();
    const worktreePath = await ensureWorktree(root, root, id);
    const experimentCwd = join(worktreePath, relative(root, adapter.workspacePath(root)));
    const command = adapter.experimentCommand();
    const executor = executorFor(manifest.resources.executor, root);
    let result = await executor.run(manifest, experimentCwd, command, undefined, adapter.config.metric.name);
    const sameCommand = adapter.config.evaluator.command.length === command.length && adapter.config.evaluator.command.every((part, index) => part === command[index]);
    let evaluator: { stdout: string; stderr: string; exitCode: number } | undefined;
    if (result.status === "completed" && !sameCommand) {
      const evaluated = await runProcess(adapter.config.evaluator.command, experimentCwd, manifest.resources.timeoutMinutes * 60_000);
      evaluator = { stdout: evaluated.stdout, stderr: evaluated.stderr, exitCode: evaluated.exitCode };
      const parsed = parseMetricOutput(evaluated.stdout, adapter.config.metric.name);
      result = { ...result, status: evaluated.exitCode === 0 ? "completed" : "failed", exitCode: evaluated.exitCode, metrics: { ...result.metrics, ...parsed.metrics }, metricsByFold: { ...result.metricsByFold, ...parsed.metricsByFold }, stdout: `${result.stdout ?? ""}\n[EVALUATOR]\n${evaluated.stdout}`, stderr: `${result.stderr ?? ""}\n[EVALUATOR]\n${evaluated.stderr}`, ...(evaluated.exitCode === 0 ? {} : { failureClass: "unknown" as const }) };
    }
    const artifactDir = join(root, ".sota", "artifacts", result.runId);
    mkdirSync(artifactDir, { recursive: true });
    const artifactPaths: Record<string, string> = {};
    const environment = await captureEnvironment(root, result.cwd ?? experimentCwd, result.command ?? command, manifest.resources.executor, manifest.resources.gpu);
    for (const [name, content] of Object.entries({ "stdout.log": result.stdout ?? "", "stderr.log": result.stderr ?? "", "metrics.json": `${JSON.stringify(result.metrics, null, 2)}\n`, "environment.json": `${JSON.stringify(environment, null, 2)}\n`, ...(evaluator ? { "evaluator.stdout.log": evaluator.stdout, "evaluator.stderr.log": evaluator.stderr } : {}) })) {
      const path = join(artifactDir, name);
      writeFileSync(path, content);
      artifactPaths[name] = path;
    }
    const recorded = { ...result, artifacts: { ...result.artifacts, ...artifactPaths } };
    const resultStore = new ResearchStore(statePath);
    resultStore.saveRun({ id: result.runId, experimentId: id, status: recorded.status, payload: recorded });
    for (const [name, path] of Object.entries(artifactPaths)) resultStore.saveArtifact({ id: `${result.runId}-${name}`, runId: result.runId, name, path, checksum: sha256File(path) });
    resultStore.saveExperiment({ id, payload: { ...(entry.payload as Record<string, unknown>), status: recorded.status === "completed" ? "completed" : "failed", runId: result.runId, worktreePath: experimentCwd } });
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
