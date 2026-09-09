#!/usr/bin/env node
import { Command } from "commander";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ResearchStore } from "./core/store.js";
import { whestbenchConfig } from "./competitions/whestbench.js";
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

program.name("evidra").description("Research-focused autonomous experimentation workbench").version("0.1.0");

program.command("init")
  .argument("<competition>", "competition adapter to initialize")
  .action((competition: string) => {
    if (competition !== "whestbench") throw new Error(`Unknown competition: ${competition}`);
    const projectDir = join(root, "competitions", "whestbench");
    mkdirSync(join(projectDir, "experiments"), { recursive: true });
    mkdirSync(join(projectDir, "reports"), { recursive: true });
    mkdirSync(join(projectDir, "submissions"), { recursive: true });
    mkdirSync(join(root, ".sota"), { recursive: true });
    const configPath = join(projectDir, "competition.json");
    if (!existsSync(configPath)) writeFileSync(configPath, `${JSON.stringify(whestbenchConfig, null, 2)}\n`);
    const store = new ResearchStore(statePath);
    if (!store.project()) {
      store.createProject({ id: "evidra-whestbench", name: whestbenchConfig.name, competitionId: whestbenchConfig.id, config: whestbenchConfig });
    }
    store.close();
    console.log(`Initialized Evidra project for ${whestbenchConfig.name}`);
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

const research = new Command("research").description("Ask the embedded research agent for the next research decision");
research.command("propose")
  .argument("[objective]", "research objective", "Inspect the current WhestBench baseline and propose three falsifiable estimator hypotheses.")
  .action(async (objective: string) => {
    const store = new ResearchStore(statePath);
    const project = store.project();
    const recentEvents = store.recentEvents(20);
    store.close();
    const decision = await runResearchDirector(objective, {
      project,
      competition: whestbenchConfig,
      constraints: { no_submission: true, no_file_edits: true },
      recentEvents,
    }, { provider: "codex", model: "default", reasoningEffort: "medium", fallbackLocalModel: "qwen3.6:27b", cwd: root });
    const decisionStore = new ResearchStore(statePath);
    decisionStore.saveDecision(decision);
    decisionStore.close();
    console.log(formatResearchDecision(decision));
  });
program.addCommand(research);

program.command("baseline")
  .description("Run the WhestBench starter-kit baseline locally")
  .option("--name <name>", "starter-kit baseline", "mean_propagation")
  .action(async (options: { name: string }) => {
    const cwd = join(root, "competitions", "whestbench", "starterkit");
    const result = await runProcess(["uv", "run", "python", "estimator.py", "--baseline", options.name], cwd);
    console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  });

const experiment = new Command("experiment").description("Manage research experiments");
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
      await new Promise<void>((resolve) => {
        const instance = render(React.createElement(App, { root }));
        instance.waitUntilExit().then(resolve);
      });
    }
  } else {
    await program.parseAsync();
  }
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
