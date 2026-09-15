import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseMetricOutput, safeWorkerEnvironment } from "./executors.js";
import { processFailureResult, runProcess, splitCommandLine } from "./process.js";
import type { ProcessResult } from "./types.js";

export interface AirsTaskLifecycleOptions {
  repository: string;
  taskPath: string;
  preparePath: string;
  evaluatePreparePath: string;
  evaluatePath: string;
  globalSharedDataDir: string;
  agentCommand: string[];
  python?: string;
  workspace: string;
  timeoutMs: number;
  metric: string;
  model?: string;
  seed?: string | number;
  effort?: string;
  onProgress?: (message: string) => void;
}

export interface AirsTaskLifecycleResult {
  valid: boolean;
  metric?: number;
  metrics: Record<string, number>;
  workspace: string;
  agentDataDir: string;
  agentLogDir: string;
  stages: Array<{ stage: "prepare" | "agent" | "evaluate_prepare" | "evaluate"; result: ProcessResult }>;
  failureStage?: "prepare" | "agent" | "evaluate_prepare" | "evaluate";
}

function containedPath(root: string, candidate: string, label: string): string {
  const rootPath = realpathSync(resolve(root));
  const path = resolve(rootPath, candidate);
  const checked = existsSync(path) ? realpathSync(path) : path;
  const escaped = relative(rootPath, checked);
  if (escaped.startsWith("..") || isAbsolute(escaped)) throw new Error(`${label} escapes its allowed root: ${candidate}`);
  return checked;
}

function scriptPath(repository: string, value: string, label: string): string {
  const path = containedPath(repository, value, label);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  return path;
}

/**
 * Execute the official AIRS task lifecycle around a caller-supplied agent.
 * The agent receives only its data/log mounts and explicit task metadata; the
 * controller credentials and home directory are never inherited.
 */
export async function runAirsTaskLifecycle(options: AirsTaskLifecycleOptions): Promise<AirsTaskLifecycleResult> {
  if (!options.agentCommand.length) throw new Error("AIRS agent command must not be empty.");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("AIRS lifecycle timeout must be positive.");
  const repository = realpathSync(resolve(options.repository));
  const taskPath = scriptPath(repository, options.taskPath, "AIRS task path");
  const preparePath = scriptPath(repository, options.preparePath, "AIRS prepare script");
  const evaluatePreparePath = scriptPath(repository, options.evaluatePreparePath, "AIRS evaluate-prepare script");
  const evaluatePath = scriptPath(repository, options.evaluatePath, "AIRS evaluator");
  const globalSharedDataDir = realpathSync(resolve(options.globalSharedDataDir));
  if (!existsSync(globalSharedDataDir)) throw new Error(`AIRS global shared data directory does not exist: ${globalSharedDataDir}`);
  mkdirSync(resolve(options.workspace), { recursive: true, mode: 0o700 });
  const lifecycleRoot = containedPath(options.workspace, ".", "AIRS lifecycle workspace");
  const agentDataDir = join(lifecycleRoot, "data");
  const agentLogDir = join(lifecycleRoot, "log");
  mkdirSync(agentDataDir, { recursive: true, mode: 0o700 });
  mkdirSync(agentLogDir, { recursive: true, mode: 0o700 });
  const python = options.python ?? "python3";
  const environment = safeWorkerEnvironment({
    HOME: join(lifecycleRoot, "home"),
    EVIDRA_AIRS_REPOSITORY: repository,
    EVIDRA_AIRS_TASK_PATH: taskPath,
    EVIDRA_AIRS_AGENT_DATA_DIR: agentDataDir,
    EVIDRA_AIRS_AGENT_LOG_DIR: agentLogDir,
    EVIDRA_AIRS_MODEL: options.model ?? "",
    EVIDRA_AIRS_SEED: options.seed === undefined ? "" : String(options.seed),
    EVIDRA_AIRS_REASONING_EFFORT: options.effort ?? "medium",
  });
  const stages: AirsTaskLifecycleResult["stages"] = [];
  const runStage = async (stage: AirsTaskLifecycleResult["stages"][number]["stage"], command: string[], cwd: string): Promise<ProcessResult> => {
    options.onProgress?.(`AIRS · ${stage}`);
    let result: ProcessResult;
    try { result = await runProcess(command, cwd, options.timeoutMs, undefined, undefined, environment); }
    catch (error) { result = processFailureResult(command, cwd, error); }
    stages.push({ stage, result });
    return result;
  };
  const prepare = await runStage("prepare", [python, preparePath, "--global-shared-data-dir", globalSharedDataDir, "--agent-data-mount-dir", agentDataDir, "--agent-log-dir", agentLogDir], repository);
  if (prepare.exitCode !== 0) return { valid: false, metrics: {}, workspace: lifecycleRoot, agentDataDir, agentLogDir, stages, failureStage: "prepare" };
  const agent = await runStage("agent", options.agentCommand, lifecycleRoot);
  if (agent.exitCode !== 0) return { valid: false, metrics: {}, workspace: lifecycleRoot, agentDataDir, agentLogDir, stages, failureStage: "agent" };
  const evaluatePrepare = await runStage("evaluate_prepare", [python, evaluatePreparePath, "--global-shared-data-dir", globalSharedDataDir, "--agent-data-mount-dir", agentDataDir, "--agent-log-dir", agentLogDir], repository);
  if (evaluatePrepare.exitCode !== 0) return { valid: false, metrics: {}, workspace: lifecycleRoot, agentDataDir, agentLogDir, stages, failureStage: "evaluate_prepare" };
  // AIRS evaluators conventionally resolve ./data/test_with_labels from the
  // agent workspace, while the preparation stage mounts that directory as
  // <workspace>/data. Keep evaluator cwd aligned with the official layout.
  const evaluate = await runStage("evaluate", [python, evaluatePath, "--submission-file", join(agentLogDir, "submission.csv")], lifecycleRoot);
  const metrics = parseMetricOutput(evaluate.stdout, options.metric).metrics;
  const metric = metrics[options.metric];
  return {
    valid: evaluate.exitCode === 0 && Number.isFinite(metric),
    ...(Number.isFinite(metric) ? { metric } : {}),
    metrics,
    workspace: lifecycleRoot,
    agentDataDir,
    agentLogDir,
    stages,
    ...(evaluate.exitCode !== 0 || !Number.isFinite(metric) ? { failureStage: "evaluate" } : {}),
  };
}

/** Parse a user-facing adapter command without invoking a shell. */
export function parseAirsAgentCommand(value: string): string[] {
  const command = splitCommandLine(value);
  if (!command.length) throw new Error("AIRS agent command must not be empty.");
  return command;
}
