#!/usr/bin/env node
import { Command } from "commander";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
import { renderReport, writeReport, type ReportKind } from "./core/reports.js";
import { runProcess } from "./core/process.js";
import { ensureWorktree } from "./core/worktree.js";
import { formatResearchDecision, runResearchDirector } from "./agents/research-director.js";
import { startInteractive } from "./session/interactive.js";
import { render } from "ink";
import React from "react";
import { App } from "./ui/app.js";

const root = process.cwd();
const statePath = join(root, ".sota", "database.sqlite");
const program = new Command();
const activeCompetition = () => {
  const store = new ResearchStore(statePath);
  const project = store.project();
  store.close();
  return loadCompetitionAdapter(root, project?.competitionId ?? "local-research");
};

function durationMinutes(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|minutes?|h|hours?|d|days?)?$/i);
  if (!match) throw new Error(`Invalid duration '${value}'. Use 90m, 4h, or 2d.`);
  const multiplier = (match[2] ?? "m").toLowerCase().startsWith("h") ? 60 : (match[2] ?? "m").toLowerCase().startsWith("d") ? 1440 : 1;
  return Math.max(1, Math.round(Number(match[1]) * multiplier));
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

const submission = new Command("submission").description("Prepare and validate safe submission bundles");
submission.command("status").action(() => {
  const directory = join(root, ".sota", "submissions");
  const bundles = existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
  console.log(bundles.length ? bundles.join("\n") : "No submission bundles prepared.");
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
  console.log(`Prepared ${bundle.id}\n${bundle.path}\nExternal submission remains approval-gated.`);
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
  console.log(active ? `${active.name}\nCompetition: ${active.competitionId}\nEvents: ${store.eventCount()}` : "No Evidra project initialized.");
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
  const result = await runProcess(adapter.baselineCommand(), adapter.workspacePath(root));
  console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
});
program.addCommand(challenge);

const research = new Command("research").description("Ask the embedded research agent for the next research decision");
research
  .option("--goal <goal>", "ultimate research goal", "Improve the current workspace or research problem with robust, reproducible evidence")
  .option("--budget <duration>", "autonomous budget, e.g. 90m or 4h")
  .option("--stop <condition>", "campaign stopping condition", "stop when the research director has sufficient evidence for the stated goal")
  .action(async (options: { goal: string; budget?: string; stop: string }) => {
    const adapter = activeCompetition();
    const objective = `${options.goal}. Stop condition: ${options.stop}`;
    const budget = options.budget ? durationMinutes(options.budget) : undefined;
    const started = Date.now();
    let cycle = 0;
    do {
      cycle += 1;
      const store = new ResearchStore(statePath);
      if (!store.project()) store.createProject({ id: `evidra-${adapter.id}`, name: adapter.config.name, competitionId: adapter.id, config: adapter.config });
      if (!store.phaseGoals().length) for (const goal of definePhaseGoals(objective, "challenge")) store.savePhaseGoal({ id: goal.id, phase: goal.phase, status: goal.status, payload: goal });
      const phaseGoal = activePhaseGoal(store.phaseGoals().map((entry) => PhaseGoalSchema.parse(entry.payload)));
      const recentEvents = store.recentEvents(20);
      const researchSources = store.sources().slice(0, 12).map((entry) => entry.payload);
      console.log(`Research ${cycle}/∞ · inspecting workspace and baseline...`);
      const gitStatus = await runProcess(["git", "status", "--short"], root);
      const files = await runProcess(["rg", "--files", "-g", "!.sota/**", "-g", "!node_modules/**"], root, 60_000);
      const baseline = await runProcess(adapter.baselineCommand(), adapter.workspacePath(root), 15 * 60_000);
      const observation = { gitStatus: gitStatus.stdout.trim().split("\n").filter(Boolean).slice(0, 40), repositoryFiles: files.stdout.trim().split("\n").filter(Boolean).slice(0, 120), baseline: { exitCode: baseline.exitCode, durationMs: baseline.durationMs, stdout: baseline.stdout.slice(-4000), stderr: baseline.stderr.slice(-4000) } };
      store.appendEvent("research.observation", observation);
      store.saveClaim({ id: `claim_observation_${Date.now()}`, payload: { statement: "Repository inspection and canonical baseline execution completed before the research decision.", scope: "current-workspace", confidence: 1, sourceType: "observation", sourceId: `observation_${Date.now()}`, status: "active", observation } });
      store.close();
      const projectStore = new ResearchStore(statePath);
      const activeProject = projectStore.project();
      projectStore.close();
      const decision = await runResearchDirector(objective, { project: activeProject, competition: adapter.config, constraints: { no_submission: true, no_file_edits: true }, recentEvents, researchSources, observation, ultimateGoal: options.goal, phaseGoal: phaseGoal ?? null }, { provider: "codex", model: "default", reasoningEffort: "high", fallbackLocalModel: "qwen3.6:27b", cwd: root });
      const decisionStore = new ResearchStore(statePath);
      materializeResearchDecision(decisionStore, decision);
      decisionStore.close();
      console.log(formatResearchDecision(decision));
      if (!budget || decision.decision === "stop" || decision.goalStatus === "blocked" || (Date.now() - started) / 60_000 >= budget) break;
    } while (true);
  });
research.command("propose")
  .argument("[objective]", "research objective", "Inspect the current workspace and propose three falsifiable, evidence-driven hypotheses.")
  .action(async (objective: string) => {
    const store = new ResearchStore(statePath);
    const project = store.project();
    if (!store.phaseGoals().length) {
      for (const goal of definePhaseGoals(objective, "challenge")) store.savePhaseGoal({ id: goal.id, phase: goal.phase, status: goal.status, payload: goal });
    }
    const phaseGoal = activePhaseGoal(store.phaseGoals().map((entry) => PhaseGoalSchema.parse(entry.payload)));
    console.log("Research 1/3 · inspecting repository...");
    const gitStatus = await runProcess(["git", "status", "--short"], root);
    const files = await runProcess(["rg", "--files", "-g", "!.sota/**", "-g", "!node_modules/**"], root, 60_000);
    console.log("Research 2/3 · running canonical baseline...");
    const adapter = activeCompetition();
    const baseline = await runProcess(adapter.baselineCommand(), adapter.workspacePath(root));
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
    }, { provider: "codex", model: "default", reasoningEffort: "medium", fallbackLocalModel: "qwen3.6:27b", cwd: root });
    const decisionStore = new ResearchStore(statePath);
    materializeResearchDecision(decisionStore, decision);
    if (phaseGoal) {
      const now = new Date().toISOString();
      decisionStore.savePhaseGoal({ id: phaseGoal.id, phase: phaseGoal.phase, status: decision.goalStatus === "met" ? "met" : "active", payload: { ...phaseGoal, status: decision.goalStatus === "met" ? "met" : "active", attempts: phaseGoal.attempts + 1, updatedAt: now } });
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
    const result = await runProcess(command, adapter.workspacePath(root));
    console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  });

const experiment = new Command("experiment").description("Manage research experiments");
experiment.command("propose")
  .argument("[hypothesis]", "hypothesis identifier; defaults to the newest hypothesis")
  .action(async (hypothesisId?: string) => {
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
    const manifest = createExperimentManifest({ id, hypothesisId: hypothesis, gitCommit: commit.stdout.trim(), datasetVersion: adapter.config.datasetRevision }, adapter.config);
    store.saveExperiment({ id, payload: { ...manifest, status: "proposed" } });
    store.close();
    console.log(`Immutable experiment manifest created\n${manifestSummary(manifest)}`);
  });
experiment.command("run")
  .argument("<id>", "experiment identifier")
  .option("--baseline <name>", "starter-kit baseline to evaluate", "mean_propagation")
  .action(async (id: string, options: { baseline: string }) => {
    const adapter = activeCompetition();
    const experimentDir = join(adapter.workspacePath(root), "experiments", id);
    mkdirSync(experimentDir, { recursive: true });
    const worktreePath = await ensureWorktree(adapter.workspacePath(root), root, id);
    const store = new ResearchStore(statePath);
    const experiment = {
      id,
      hypothesisId: "baseline-reproduction",
      parentCommit: "starterkit",
      worktreePath,
      command: [...adapter.experimentCommand()],
      status: "running" as const,
      createdAt: new Date().toISOString(),
    };
    store.saveExperiment({ id, payload: experiment });
    store.close();

    const result = await runProcess(experiment.command, worktreePath);
    const reportPath = join(experimentDir, "result.json");
    writeFileSync(reportPath, `${JSON.stringify({ ...result, experiment }, null, 2)}\n`);
    console.log(`Experiment ${id}: ${result.exitCode === 0 ? "completed" : "failed"}`);
    console.log(`Report: ${reportPath}`);
    console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
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
