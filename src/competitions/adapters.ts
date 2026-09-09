import { join } from "node:path";
import type { CompetitionConfig } from "../core/types.js";
import { whestbenchConfig } from "./whestbench.js";

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

const adapters = new Map([[whestbenchAdapter.id, whestbenchAdapter], ["whestbench", whestbenchAdapter]]);

export function getCompetitionAdapter(id = "whestbench"): CompetitionAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`No competition adapter registered for '${id}'. Available: ${[...adapters.keys()].join(", ")}`);
  return adapter;
}

export function registerCompetitionAdapter(adapter: CompetitionAdapter): void {
  adapters.set(adapter.id, adapter);
}
