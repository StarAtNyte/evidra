import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export type AirsBenchFamily = "rad" | "mlgym" | "all";

export interface AirsBenchTask {
  id: string;
  family: "rad" | "mlgym";
  path: string;
  metadataPath: string;
  descriptionPath: string;
  preparePath: string;
  evaluatePath: string;
  evaluatePreparePath: string;
  valid: boolean;
  missingFiles: string[];
  metric?: string;
  direction?: "maximize" | "minimize";
  dataset?: string;
  researchProblem?: string;
  category?: string;
  estimatedWorstScore?: number;
  optimalScore?: number;
  sotaScore?: number;
  sotaPaperUrl?: string;
}

export interface AirsBenchDiscovery {
  schemaVersion: 1;
  repository: string;
  family: AirsBenchFamily;
  tasks: AirsBenchTask[];
  validTasks: number;
  invalidTasks: number;
}

function scalar(text: string, key: string): string | undefined {
  const match = text.match(new RegExp(`^\\s{0,4}${key}:\\s*(.*?)\\s*$`, "m"));
  if (!match) return undefined;
  const value = match[1].trim().replace(/^['"]|['"]$/g, "");
  return value && value !== "null" ? value : undefined;
}

function numberScalar(text: string, key: string): number | undefined {
  const value = scalar(text, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nestedNumberScalar(text: string, key: string): number | undefined {
  const value = nestedScalar(text, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nestedScalar(text: string, key: string): string | undefined {
  const match = text.match(new RegExp(`^\\s{2,}${key}:\\s*(.*?)\\s*$`, "m"));
  if (!match) return undefined;
  const value = match[1].trim().replace(/^['"]|['"]$/g, "");
  return value && value !== "null" ? value : undefined;
}

function requiredFiles(taskPath: string): Record<string, string> {
  return {
    metadataPath: join(taskPath, "metadata.yaml"),
    descriptionPath: join(taskPath, "project_description.md"),
    preparePath: join(taskPath, "prepare.py"),
    evaluatePath: join(taskPath, "evaluate.py"),
    evaluatePreparePath: join(taskPath, "evaluate_prepare.py"),
  };
}

function mlgymFiles(taskPath: string): Record<string, string> {
  const taskConfig = join(taskPath, "configs", "tasks", `${taskPath.split("/").at(-1)}.yaml`);
  return {
    metadataPath: taskConfig,
    descriptionPath: taskConfig,
    preparePath: join(taskPath, "data"),
    evaluatePath: join(taskPath, "data", "evaluate.py"),
    evaluatePreparePath: join(taskPath, "data"),
  };
}

function metricFromTaskId(id: string): string | undefined {
  const match = id.match(/(MeanAbsoluteError|SpearmanCorrelation|ExactMatch|RougeL|MAE|Mae|Accuracy|MASE|MRR|PassAt\d+)$/);
  return match?.[1];
}

/**
 * Discover AIRS-Bench task contracts without importing its Python runtime.
 * This deliberately reads only the public task specification files; execution
 * remains delegated to a declared benchmark arm and cannot silently mutate the
 * downloaded benchmark checkout.
 */
export function discoverAirsBenchTasks(repositoryRoot: string, family: AirsBenchFamily = "all"): AirsBenchDiscovery {
  const repository = resolve(repositoryRoot);
  const tasksRoot = join(repository, "airsbench", "tasks");
  if (!existsSync(tasksRoot) || !statSync(tasksRoot).isDirectory()) throw new Error(`AIRS-Bench tasks directory not found: ${tasksRoot}`);
  const families = family === "all" ? ["rad", "mlgym"] as const : [family] as const;
  const tasks: AirsBenchTask[] = [];
  for (const selectedFamily of families) {
    const familyRoot = join(tasksRoot, selectedFamily);
    if (!existsSync(familyRoot) || !statSync(familyRoot).isDirectory()) continue;
    for (const id of readdirSync(familyRoot).sort()) {
      const taskPath = join(familyRoot, id);
      if (!statSync(taskPath).isDirectory()) continue;
      const files = selectedFamily === "rad" ? requiredFiles(taskPath) : mlgymFiles(taskPath);
      const relativeFiles = {
        metadataPath: relative(repository, files.metadataPath),
        descriptionPath: relative(repository, files.descriptionPath),
        preparePath: relative(repository, files.preparePath),
        evaluatePath: relative(repository, files.evaluatePath),
        evaluatePreparePath: relative(repository, files.evaluatePreparePath),
      };
      const missingFiles = Object.entries(files).filter(([, path]) => !existsSync(path)).map(([name]) => name);
      const metadata = existsSync(files.metadataPath) ? readFileSync(files.metadataPath, "utf8") : "";
      const metric = nestedScalar(metadata, "metric") ?? metricFromTaskId(id);
      const lowerIsBetter = scalar(metadata, "metric_lower_is_better") === "true" || metric === "MASE" || metric === "MAE" || metric === "Mae" || metric === "MeanAbsoluteError";
      const direction = metric ? (lowerIsBetter ? "minimize" : "maximize") : undefined;
      tasks.push({
        id,
        family: selectedFamily,
        path: relative(repository, taskPath),
        ...relativeFiles,
        valid: missingFiles.length === 0 && Boolean(metric),
        missingFiles,
        ...(metric ? { metric } : {}),
        ...(direction ? { direction } : {}),
        ...(nestedScalar(metadata, "dataset") ? { dataset: nestedScalar(metadata, "dataset") } : {}),
        ...(nestedScalar(metadata, "research_problem") ? { researchProblem: nestedScalar(metadata, "research_problem") } : {}),
        ...(nestedScalar(metadata, "category") ? { category: nestedScalar(metadata, "category") } : {}),
        ...(numberScalar(metadata, "estimated_worst_score") !== undefined ? { estimatedWorstScore: numberScalar(metadata, "estimated_worst_score") } : {}),
        ...(numberScalar(metadata, "optimal_score") !== undefined ? { optimalScore: numberScalar(metadata, "optimal_score") } : {}),
        ...(nestedNumberScalar(metadata, "sota_score") !== undefined ? { sotaScore: nestedNumberScalar(metadata, "sota_score") } : {}),
        ...(nestedScalar(metadata, "sota_paper_url") ? { sotaPaperUrl: nestedScalar(metadata, "sota_paper_url") } : {}),
      });
    }
  }
  return {
    schemaVersion: 1,
    repository,
    family,
    tasks,
    validTasks: tasks.filter((task) => task.valid).length,
    invalidTasks: tasks.filter((task) => !task.valid).length,
  };
}
