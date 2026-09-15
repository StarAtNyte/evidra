import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, relative } from "node:path";
import { CompetitionConfigSchema, type CompetitionConfig } from "../core/types.js";
import { whestbenchConfig } from "./whestbench.js";

export const localResearchConfig: CompetitionConfig = {
  id: "local-research",
  name: "Local Research Workspace",
  taskType: "general_empirical_research",
  datasetRevision: "workspace",
  metric: { name: "custom", direction: "maximize" },
  secondaryMetrics: [],
  evaluator: { command: ["true"], estimatorPath: "" },
  researchSources: [],
  evaluatorTimeoutMinutes: 15,
  workspacePath: ".",
  baselineCommand: ["true"],
  experimentCommand: ["true"],
};

/**
 * The canonical Karpathy autoresearch checkout is intentionally small and
 * stable: prepare.py materializes the data and train.py is the editable
 * worker/evaluator. Keep this as a convenience adapter only; a project-local
 * competition.json still takes precedence and can override every field.
 */
export const autoresearchConfig: CompetitionConfig = {
  id: "autoresearch",
  name: "Karpathy Autoresearch",
  taskType: "llm_training",
  datasetRevision: "autoresearch-workspace",
  metric: { name: "val_bpb", direction: "minimize" },
  secondaryMetrics: [],
  evaluator: { command: ["uv", "run", "train.py"], estimatorPath: "train.py" },
  researchSources: [],
  evaluatorTimeoutMinutes: 240,
  workspacePath: ".",
  baselineCommand: ["uv", "run", "train.py"],
  experimentCommand: ["uv", "run", "train.py"],
  validation: { primarySplit: "pinned-validation-shard", folds: [0], seeds: [0], secondarySplits: [] },
};

export interface CompetitionAdapter {
  readonly id: string;
  readonly config: CompetitionConfig;
  workspacePath(projectRoot: string): string;
  baselineCommand(): string[];
  experimentCommand(): string[];
}

const whestbenchAdapter: CompetitionAdapter = {
  id: whestbenchConfig.id,
  config: whestbenchConfig,
  workspacePath: (projectRoot) => join(projectRoot, "competitions", "whestbench", "starterkit"),
  baselineCommand: () => ["uv", "run", "python", "estimator.py", "--baseline", "mean_propagation"],
  experimentCommand: () => ["uv", "run", "python", "estimator.py"],
};

const autoresearchAdapter: CompetitionAdapter = {
  id: autoresearchConfig.id,
  config: autoresearchConfig,
  workspacePath: (projectRoot) => projectRoot,
  baselineCommand: () => [...(autoresearchConfig.baselineCommand ?? autoresearchConfig.evaluator.command)],
  experimentCommand: () => [...(autoresearchConfig.experimentCommand ?? autoresearchConfig.evaluator.command)],
};

const localResearchAdapter = manifestAdapter(localResearchConfig, process.cwd());

function manifestAdapter(config: CompetitionConfig, projectRoot: string): CompetitionAdapter {
  const workspace = config.workspacePath ?? join("competitions", config.id);
  const workspacePath = resolve(projectRoot, workspace);
  const projectRelative = relative(projectRoot, workspacePath);
  if (projectRelative.startsWith("..") || isAbsolute(projectRelative)) {
    throw new Error(`Competition workspacePath must stay inside the project: ${workspace}`);
  }
  return {
    id: config.id,
    config,
    workspacePath: () => workspacePath,
    baselineCommand: () => [...(config.baselineCommand ?? config.evaluator.command)],
    experimentCommand: () => [...(config.experimentCommand ?? config.evaluator.command)],
  };
}

const adapters = new Map([
  [whestbenchAdapter.id, whestbenchAdapter],
  ["whestbench", whestbenchAdapter],
  [autoresearchAdapter.id, autoresearchAdapter],
  [localResearchAdapter.id, localResearchAdapter],
]);

function looksLikeAutoresearchWorkspace(projectRoot: string): boolean {
  return existsSync(join(projectRoot, "train.py")) && existsSync(join(projectRoot, "prepare.py"));
}

export function getCompetitionAdapter(id = "local-research"): CompetitionAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`No competition adapter registered for '${id}'. Available: ${[...adapters.keys()].join(", ")}`);
  return adapter;
}

/** Load a competition manifest created by `evidra init` or supplied by a project.
 * The manifest is the extension boundary: new competitions do not require a
 * source-code adapter when they provide validated commands and paths.
 */
export function loadCompetitionAdapter(projectRoot: string, id = "local-research"): CompetitionAdapter {
  const registered = adapters.get(id);
  if (id === "local-research") return manifestAdapter(localResearchConfig, projectRoot);
  const candidates = [
    join(projectRoot, "competition.json"),
    join(projectRoot, "competitions", id, "competition.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { throw new Error(`Invalid competition manifest ${path}: ${error instanceof Error ? error.message : String(error)}`); }
    const parsed = CompetitionConfigSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid competition manifest ${path}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
    return manifestAdapter(parsed.data, projectRoot);
  }
  if (id === autoresearchAdapter.id && looksLikeAutoresearchWorkspace(projectRoot)) return autoresearchAdapter;
  return registered ?? getCompetitionAdapter(id);
}

export function registerCompetitionAdapter(adapter: CompetitionAdapter): void {
  adapters.set(adapter.id, adapter);
}
