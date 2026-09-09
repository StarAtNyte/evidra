import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ResearchStore } from "../core/store.js";
import { runProcess } from "../core/process.js";
import { PiResearchAgent } from "../agents/pi.js";
import { loadCompetitionAdapter } from "../competitions/adapters.js";
import { ensureWorktree } from "../core/worktree.js";

const HELP = `
Research commands:
  /help                         Show this command list
  /status                       Show project state
  /inspect                      Show competition configuration
  /baseline [name]              Run a starter-kit baseline
  /experiment run <id>          Run an experiment
  /research propose [objective] Ask the research director
  /exit                         Leave Evidra

Anything without a leading / is sent to the research director.
`;

export async function startInteractive(root: string, statePath: string): Promise<void> {
  const activeAdapter = (): ReturnType<typeof loadCompetitionAdapter> => {
    const store = new ResearchStore(statePath);
    const project = store.project();
    store.close();
    return loadCompetitionAdapter(root, project?.competitionId ?? "local-research");
  };
  const rl = createInterface({ input, output, prompt: "evidra> " });
  console.log("Evidra Research Director");
  console.log("Type /help for commands. Ask a research question directly or use /exit to quit.\n");
  rl.prompt();

  try {
    for await (const line of rl) {
      const request = line.trim();
      if (!request) {
        rl.prompt();
        continue;
      }
      try {
        if (request === "/exit" || request === "/quit") break;
        if (request === "/help") {
          console.log(HELP);
        } else if (request === "/status") {
          const store = new ResearchStore(statePath);
          const project = store.project();
          console.log(project ? `Project: ${project.name}\nCompetition: ${project.competitionId}\nEvents: ${store.eventCount()}` : "No project initialized.");
          store.close();
        } else if (request === "/inspect") {
          console.log(JSON.stringify(activeAdapter().config, null, 2));
        } else if (request.startsWith("/baseline")) {
          const adapter = activeAdapter();
          const result = await runProcess(adapter.baselineCommand(), adapter.workspacePath(root));
          console.log(result.stdout);
          if (result.stderr) console.error(result.stderr);
        } else if (request.startsWith("/research propose")) {
          const objective = request.slice("/research propose".length).trim() || "Inspect the current workspace and propose three falsifiable, evidence-driven hypotheses.";
          const store = new ResearchStore(statePath);
          const project = store.project();
          store.close();
          const result = await new PiResearchAgent().run({ role: "research director", objective, context: { project, workspace: activeAdapter().config } });
          console.log(result.output);
        } else if (request.startsWith("/experiment run")) {
          const id = request.split(/\s+/)[2];
          if (!id) throw new Error("Usage: /experiment run <id>");
          const adapter = activeAdapter();
          const worktree = await ensureWorktree(adapter.workspacePath(root), root, id);
          const store = new ResearchStore(statePath);
          store.appendEvent("experiment.started", { id, worktree });
          store.close();
          const result = await runProcess(adapter.experimentCommand(), worktree);
          console.log(`Experiment ${id}: ${result.exitCode === 0 ? "completed" : "failed"}`);
          console.log(result.stdout);
          if (result.stderr) console.error(result.stderr);
        } else {
          const result = await new PiResearchAgent().run({
            role: "research director",
            objective: request,
            context: { workspace: activeAdapter().config },
          });
          console.log(result.output);
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
      rl.prompt();
    }
  } finally {
    rl.close();
    console.log("Goodbye.");
  }
}
