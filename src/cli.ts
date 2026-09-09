#!/usr/bin/env node
import { Command } from "commander";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ResearchStore } from "./core/store.js";
import { materializeResearchDecision } from "./core/research-graph.js";
import { createExperimentManifest, manifestSummary } from "./core/experiment-manifest.js";
import { activePhaseGoal, definePhaseGoals } from "./core/phase-goals.js";
import { PhaseGoalSchema } from "./core/types.js";
import { whestbenchConfig } from "./competitions/whestbench.js";
import { getCompetitionAdapter } from "./competitions/adapters.js";
import { auditData } from "./core/data-audit.js";
import { createValidationPolicy, writeValidationPolicy } from "./core/validation-policy.js";
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
  return getCompetitionAdapter(project?.competitionId ?? "whestbench");
};

program.name("evidra").description("Research-focused autonomous experimentation workbench").version("0.1.0");

program.command("init")
  .argument("<competition>", "competition adapter to initialize")
  .action((competition: string) => {
    const adapter = getCompetitionAdapter(competition);
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
    console.log("No Evidra project initialized. Run: evidra init whestbench");
  } else {
    console.log(`Project       ${project.name}`);
    console.log(`Competition   ${project.competitionId}`);
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
challenge.command("list").action(() => console.log(`* ${whestbenchConfig.id} — ${whestbenchConfig.name}`));
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
research.command("propose")
  .argument("[objective]", "research objective", "Inspect the current WhestBench baseline and propose three falsifiable estimator hypotheses.")
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
  .description("Run the WhestBench starter-kit baseline locally")
  .option("--name <name>", "starter-kit baseline", "mean_propagation")
  .action(async (options: { name: string }) => {
    const adapter = activeCompetition();
    const command = adapter.baselineCommand();
    const nameIndex = command.length - 1;
    if (options.name !== "mean_propagation") command[nameIndex] = options.name;
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
    const manifest = createExperimentManifest({ id, hypothesisId: hypothesis, gitCommit: commit.stdout.trim(), datasetVersion: whestbenchConfig.datasetRevision }, whestbenchConfig);
    store.saveExperiment({ id, payload: { ...manifest, status: "proposed" } });
    store.close();
    console.log(`Immutable experiment manifest created\n${manifestSummary(manifest)}`);
  });
experiment.command("run")
  .argument("<id>", "experiment identifier")
  .option("--baseline <name>", "starter-kit baseline to evaluate", "mean_propagation")
  .action(async (id: string, options: { baseline: string }) => {
    const experimentDir = join(root, "competitions", "whestbench", "experiments", id);
    mkdirSync(experimentDir, { recursive: true });
    const starterkitDir = join(root, "competitions", "whestbench", "starterkit");
    const worktreePath = await ensureWorktree(starterkitDir, root, id);
    const store = new ResearchStore(statePath);
    const experiment = {
      id,
      hypothesisId: "baseline-reproduction",
      parentCommit: "starterkit",
      worktreePath,
      command: ["uv", "run", "python", "estimator.py", "--baseline", options.baseline],
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
