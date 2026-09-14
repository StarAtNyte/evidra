import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
}

/**
 * Execute a task-balanced collection of stepwise contracts. Tasks are kept
 * independent in the report, so one failure cannot be hidden by an aggregate
 * score and each task can resume from its own verified snapshots.
 */
export async function runScientificTaskSuite(values: unknown[], root: string, options: ScientificSuiteOptions = {}): Promise<ScientificSuiteReport> {
  const tasks = values.map((value) => ScientificTaskSchema.parse(value));
  const results: ScientificSuiteTaskResult[] = [];
  for (const task of tasks) {
    if (options.isCancelled?.()) break;
    options.onProgress?.(`Scientific suite · ${task.id} · starting`);
    const run = await runScientificTask(task, root, { previous: options.previous?.[task.id], onProgress: options.onProgress, onProcess: options.onProcess, isCancelled: options.isCancelled });
    const result = { taskId: task.id, run, evaluation: evaluateScientificTaskRun(task, run) };
    results.push(result);
    await options.onTaskComplete?.(result);
  }
  const validTasks = results.filter((item) => item.evaluation.valid).length;
  const mean = (values: number[]): number => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return {
    schemaVersion: 1,
    suite: "evidra-scientific-suite",
    taskCount: tasks.length,
    validTasks,
    validityRate: tasks.length ? validTasks / tasks.length : 0,
    meanStageScore: mean(results.map((item) => item.evaluation.stageScore)),
    meanProcessQuality: mean(results.map((item) => item.evaluation.processQuality)),
    tasks: results,
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
