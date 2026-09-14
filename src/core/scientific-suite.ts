import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { evaluateScientificTaskRun, runScientificTask, ScientificTaskSchema, type ScientificTask, type ScientificTaskEvaluation, type ScientificTaskRun, type ScientificTaskRunOptions } from "./scientific-tasks.js";

export interface ScientificSuiteTaskResult {
  taskId: string;
  run: ScientificTaskRun;
  evaluation: ScientificTaskEvaluation;
}

export interface ScientificSuiteReport {
  schemaVersion: 1;
  suite: "evidra-scientific-suite";
  taskCount: number;
  validTasks: number;
  validityRate: number;
  meanStageScore: number;
  meanProcessQuality: number;
  tasks: ScientificSuiteTaskResult[];
}

export interface ScientificSuiteOptions {
  previous?: Record<string, ScientificTaskRun>;
  onProgress?: (message: string) => void;
  onProcess?: ScientificTaskRunOptions["onProcess"];
  isCancelled?: ScientificTaskRunOptions["isCancelled"];
  onTaskComplete?: (result: ScientificSuiteTaskResult) => void | Promise<void>;
  /** Maximum independent tasks to run concurrently. Shared workspaces remain serialized. */
  maxParallel?: number;
}

function taskWorkspacePaths(tasks: ScientificTask[], root: string): string[] {
  return tasks.flatMap((task) => task.stages.map((stage) => resolve(root, stage.cwd)));
}

function workspacesOverlap(left: string, right: string): boolean {
  const relation = relative(left, right);
  return relation === "" || (!isAbsolute(relation) && !relation.startsWith(".."));
}

function suiteConcurrency(tasks: ScientificTask[], root: string, requested: number): number {
  const paths = taskWorkspacePaths(tasks, root);
  // A task contract may mutate files outside its cwd through its command. The
  // only safe parallel contract is therefore one whose declared stage roots
  // are pairwise disjoint and explicit; the normal `.` workspace stays serial.
  if (paths.some((path) => path === resolve(root, "."))) return 1;
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (workspacesOverlap(paths[left]!, paths[right]!) || workspacesOverlap(paths[right]!, paths[left]!)) return 1;
    }
  }
  return Math.max(1, Math.min(tasks.length, Math.floor(requested) || 1));
}

/** Write a completed task checkpoint so readers see either the old or new report, never a partial JSON file. */
export function writeScientificTaskCheckpoint(path: string, result: ScientificSuiteTaskResult): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(temporary, path);
}

/**
 * Execute a task-balanced collection of stepwise contracts. Tasks are kept
 * independent in the report, so one failure cannot be hidden by an aggregate
 * score and each task can resume from its own verified snapshots.
 */
export async function runScientificTaskSuite(values: unknown[], root: string, options: ScientificSuiteOptions = {}): Promise<ScientificSuiteReport> {
  const tasks = values.map((value) => ScientificTaskSchema.parse(value));
  const results: Array<ScientificSuiteTaskResult | undefined> = Array.from({ length: tasks.length });
  const concurrency = suiteConcurrency(tasks, root, options.maxParallel ?? 1);
  if (concurrency === 1 && (options.maxParallel ?? 1) > 1) options.onProgress?.("Scientific suite · shared or overlapping workspace detected; serializing tasks");
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      const task = tasks[index];
      if (!task) return;
      if (options.isCancelled?.()) return;
      options.onProgress?.(`Scientific suite · ${task.id} · starting`);
      const run = await runScientificTask(task, root, { previous: options.previous?.[task.id], onProgress: options.onProgress, onProcess: options.onProcess, isCancelled: options.isCancelled });
      const result = { taskId: task.id, run, evaluation: evaluateScientificTaskRun(task, run) };
      results[index] = result;
      await options.onTaskComplete?.(result);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const completedResults = results.filter((result): result is ScientificSuiteTaskResult => Boolean(result));
  const validTasks = completedResults.filter((item) => item.evaluation.valid).length;
  const mean = (values: number[]): number => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return {
    schemaVersion: 1,
    suite: "evidra-scientific-suite",
    taskCount: tasks.length,
    validTasks,
    validityRate: tasks.length ? validTasks / tasks.length : 0,
    meanStageScore: mean(completedResults.map((item) => item.evaluation.stageScore)),
    meanProcessQuality: mean(completedResults.map((item) => item.evaluation.processQuality)),
    tasks: completedResults,
  };
}

/** Load one task contract per JSON file in a directory, in stable order. */
export function loadScientificTaskDirectory(directory: string): Array<{ path: string; task: ScientificTask }> {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry: { isFile: () => boolean; name: string }) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .sort((left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name))
    .map((entry: { name: string }) => {
      const path = join(directory, entry.name);
      return { path, task: ScientificTaskSchema.parse(JSON.parse(readFileSync(path, "utf8"))) };
    });
}
