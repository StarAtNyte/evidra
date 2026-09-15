import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseMetricOutput, safeWorkerEnvironment } from "./executors.js";
import { processFailureResult, runProcess, splitCommandLine } from "./process.js";
import { sha256File } from "./evidence.js";
import type { ProcessResult } from "./types.js";

export interface AirsTaskLifecycleOptions {
  repository: string;
  taskPath: string;
  preparePath: string;
  evaluatePreparePath: string;
  evaluatePath: string;
  globalSharedDataDir: string;
  agentCommand?: string[];
  agentRunner?: (context: { workspace: string; agentDataDir: string; agentLogDir: string; taskPath: string; timeoutMs: number; onProgress?: (message: string) => void }) => Promise<ProcessResult>;
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
  resumed: boolean;
  initialArtifactBytes: number;
  finalArtifactBytes: number;
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

function usableSubmission(path: string): boolean {
  return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
}

/** Fingerprint prepared data without reading potentially multi-gigabyte files. */
function directoryRevision(root: string): string {
  const entries: string[] = [];
  const visit = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path, relativePath);
      else if (entry.isFile()) {
        const stats = statSync(path);
        entries.push(`${relativePath}:${stats.size}:${stats.mtimeMs}`);
      }
    }
  };
  visit(root, "");
  return `sha256:${createHash("sha256").update(entries.join("\n")).digest("hex")}`;
}

function readAgentCheckpoint(path: string, contract: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { contract?: unknown; agentCompleted?: unknown };
    return value.contract === contract && value.agentCompleted === true;
  } catch {
    return false;
  }
}

/**
 * Execute the official AIRS task lifecycle around a caller-supplied agent.
 * The agent receives only its data/log mounts and explicit task metadata; the
 * controller credentials and home directory are never inherited.
 */
export async function runAirsTaskLifecycle(options: AirsTaskLifecycleOptions): Promise<AirsTaskLifecycleResult> {
  if (!options.agentCommand?.length && !options.agentRunner) throw new Error("AIRS agent command or embedded agent runner must be supplied.");
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
  const submissionPath = join(agentLogDir, "submission.csv");
  const planPath = join(lifecycleRoot, "PLAN.md");
  const checkpointPath = join(lifecycleRoot, ".evidra-airs-agent.json");
  const contractBase = { repository, taskPath, preparePath, evaluatePreparePath, evaluatePath, prepareHash: sha256File(preparePath), evaluatePrepareHash: sha256File(evaluatePreparePath), evaluateHash: sha256File(evaluatePath), globalSharedDataDir, metric: options.metric, model: options.model ?? "", seed: options.seed ?? "", effort: options.effort ?? "medium" };
  const resumed = existsSync(join(lifecycleRoot, ".git")) || existsSync(submissionPath) || existsSync(planPath);
  const initialArtifactBytes = existsSync(submissionPath) && statSync(submissionPath).isFile() ? statSync(submissionPath).size : 0;
  const lifecycleState = (): Pick<AirsTaskLifecycleResult, "resumed" | "initialArtifactBytes" | "finalArtifactBytes"> => ({
    resumed,
    initialArtifactBytes,
    finalArtifactBytes: existsSync(submissionPath) && statSync(submissionPath).isFile() ? statSync(submissionPath).size : 0,
  });
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
  if (prepare.exitCode !== 0) return { valid: false, ...lifecycleState(), metrics: {}, workspace: lifecycleRoot, agentDataDir, agentLogDir, stages, failureStage: "prepare" };
  const contract = JSON.stringify({ ...contractBase, preparedDataRevision: directoryRevision(agentDataDir) });
  // Codex file-change tools require a repository root even when the task is
  // otherwise a disposable scratch workspace. This repository is ephemeral;
  // it is never connected to the user's checkout or used as submission proof.
  if (!existsSync(join(lifecycleRoot, ".git"))) {
    const gitInit = await runProcess(["git", "init", "--quiet"], lifecycleRoot, 10_000, undefined, undefined, environment);
    if (gitInit.exitCode !== 0) {
      stages.push({ stage: "agent", result: { ...gitInit, stderr: `${gitInit.stderr}\nCould not initialize the disposable AIRS agent repository.`.trim() } });
      return { valid: false, ...lifecycleState(), metrics: {}, workspace: lifecycleRoot, agentDataDir, agentLogDir, stages, failureStage: "agent" };
    }
  }
  // Seed the two files most agents must update, then commit the seed. Codex's
  // file-change tool is more reliable when it updates tracked paths in a repo
  // with a HEAD; an empty seed is never accepted as a finished submission.
  // Never overwrite a partial run when a caller resumes the same workspace.
  // The controller's artifact gate, not the seed, decides whether the files
  // are complete.
  if (!existsSync(submissionPath)) writeFileSync(submissionPath, "", { mode: 0o600 });
  if (!existsSync(planPath)) writeFileSync(planPath, "# AIRS task plan\n\nAgent must replace this placeholder before completion.\n", { mode: 0o600 });
  const seedCommit = await runProcess(["git", "add", "--", "log/submission.csv", "PLAN.md"], lifecycleRoot, 10_000, undefined, undefined, environment);
  if (seedCommit.exitCode === 0) {
    await runProcess(["git", "-c", "user.name=Evidra", "-c", "user.email=evidra@localhost", "commit", "--quiet", "-m", "seed AIRS agent workspace"], lifecycleRoot, 10_000, undefined, undefined, environment);
  }
  let agent: ProcessResult;
  if (readAgentCheckpoint(checkpointPath, contract) && usableSubmission(submissionPath)) {
    options.onProgress?.("AIRS · restored completed agent artifact");
    agent = { command: ["<restored-agent-artifact>"], cwd: lifecycleRoot, exitCode: 0, durationMs: 0, stdout: "Restored a completed agent artifact from the workspace checkpoint.", stderr: "" };
    stages.push({ stage: "agent", result: agent });
  } else if (options.agentRunner) {
    options.onProgress?.("AIRS · agent");
    try { agent = await options.agentRunner({ workspace: lifecycleRoot, agentDataDir, agentLogDir, taskPath, timeoutMs: options.timeoutMs, onProgress: options.onProgress }); }
    catch (error) { agent = processFailureResult(["<embedded-agent>"], lifecycleRoot, error); }
    stages.push({ stage: "agent", result: agent });
  } else {
    agent = await runStage("agent", options.agentCommand!, lifecycleRoot);
  }
  if (agent.exitCode !== 0) return { valid: false, ...lifecycleState(), metrics: {}, workspace: lifecycleRoot, agentDataDir, agentLogDir, stages, failureStage: "agent" };
  if (!usableSubmission(submissionPath)) {
    const failure: ProcessResult = {
      ...agent,
      exitCode: 66,
      stderr: `${agent.stderr}\nAgent completed without creating the required submission artifact: ${submissionPath}`.trim(),
    };
    stages[stages.length - 1] = { stage: "agent", result: failure };
    return { valid: false, ...lifecycleState(), metrics: {}, workspace: lifecycleRoot, agentDataDir, agentLogDir, stages, failureStage: "agent" };
  }
  writeFileSync(checkpointPath, `${JSON.stringify({ schemaVersion: 1, contract, agentCompleted: true, artifactBytes: statSync(submissionPath).size, completedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  const evaluatePrepare = await runStage("evaluate_prepare", [python, evaluatePreparePath, "--global-shared-data-dir", globalSharedDataDir, "--agent-data-mount-dir", agentDataDir, "--agent-log-dir", agentLogDir], repository);
  if (evaluatePrepare.exitCode !== 0) return { valid: false, ...lifecycleState(), metrics: {}, workspace: lifecycleRoot, agentDataDir, agentLogDir, stages, failureStage: "evaluate_prepare" };
  // AIRS evaluators conventionally resolve ./data/test_with_labels from the
  // agent workspace, while the preparation stage mounts that directory as
  // <workspace>/data. Keep evaluator cwd aligned with the official layout.
  const evaluate = await runStage("evaluate", [python, evaluatePath, "--submission-file", submissionPath], lifecycleRoot);
  const metrics = parseMetricOutput(evaluate.stdout, options.metric).metrics;
  const metric = metrics[options.metric];
  return {
    valid: evaluate.exitCode === 0 && Number.isFinite(metric),
    ...lifecycleState(),
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
