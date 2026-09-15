import { runProcess, type ProcessControl } from "./process.js";
import { parseLearningCurve } from "./early-stopping.js";
import { redactStructured } from "./redaction.js";
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExperimentManifest, ProcessResult, RunResult } from "./types.js";

export interface ExperimentExecutor {
  readonly kind: "local" | "container" | "modal";
  run(manifest: ExperimentManifest, cwd: string, command: string[], onProcess?: (control: ProcessControl) => void, metricName?: string, environment?: NodeJS.ProcessEnv): Promise<RunResult>;
}

/**
 * Give every experiment the same generic, competition-independent config
 * contract. The file lives in the isolated worktree, never in controller
 * state, and is redacted before a model-supplied patch reaches a worker.
 */
const WORKER_SECRET_KEY = /(TOKEN|KEY|SECRET|PASSWORD|COOKIE|AUTH|CREDENTIAL|PASS|API[_-]?KEY)/i;
const WORKER_ENV_KEYS = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "PWD",
  "LANG", "LANGUAGE", "VIRTUAL_ENV", "CONDA_DEFAULT_ENV", "CONDA_PREFIX",
  "CUDA_HOME", "CUDA_PATH", "CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES",
  "NVIDIA_DRIVER_CAPABILITIES", "LD_LIBRARY_PATH", "OMP_NUM_THREADS", "MKL_NUM_THREADS",
]);

/**
 * Construct the environment visible to model-supplied experiment code.
 * Controller credentials must never be ambient inputs to arbitrary workers.
 * Explicit experiment metadata is added below after this filter.
 */
export function safeWorkerEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const merged = { ...process.env, ...overrides };
  const explicitlyDeclared = new Set(Object.keys(overrides));
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || WORKER_SECRET_KEY.test(key)) continue;
    const validName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
    if (explicitlyDeclared.has(key) && validName || WORKER_ENV_KEYS.has(key) || key.startsWith("LC_") || key.startsWith("PYTHON") || key.startsWith("CONDA_") || key.startsWith("CUDA_") || key.startsWith("NVIDIA_") || key.startsWith("OMP_") || key.startsWith("MKL_")) {
      safe[key] = value;
    }
  }
  return safe;
}

/** Create a worker-only home so subprocesses cannot read controller dotfiles. */
export function prepareWorkerHome(root: string): string {
  const home = join(resolve(root), ".sota", "worker-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

export function prepareExperimentEnvironment(manifest: ExperimentManifest, cwd: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const configPath = `${cwd}/.sota/experiment-config.json`;
  mkdirSync(dirname(configPath), { recursive: true });
  const datasetVersion = manifest.datasetVersion ?? "unknown";
  const splitVersion = manifest.splitVersion ?? "unknown";
  const folds = manifest.evaluation?.folds ?? [0];
  const seeds = manifest.evaluation?.seeds ?? [0];
  const workerHome = prepareWorkerHome(cwd);
  const payload = redactStructured({
    schemaVersion: 1,
    experimentId: manifest.id,
    datasetVersion,
    splitVersion,
    evaluation: {
      folds,
      seeds,
      matrixRequired: manifest.evaluation?.matrixRequired ?? false,
      metrics: manifest.evaluation?.metrics ?? [],
    },
    resources: {
      executor: manifest.resources.executor,
      gpu: manifest.resources.gpu ?? null,
      timeoutMinutes: manifest.resources.timeoutMinutes,
    },
    configPatch: manifest.change?.configPatch ?? {},
  });
  writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return {
    ...safeWorkerEnvironment({ ...overrides, HOME: workerHome }),
    EVIDRA_EXPERIMENT_ID: manifest.id,
    EVIDRA_EXPERIMENT_CONFIG: configPath,
    EVIDRA_DATASET_VERSION: datasetVersion,
    EVIDRA_SPLIT_VERSION: splitVersion,
    EVIDRA_MATRIX_REQUIRED: manifest.evaluation?.matrixRequired ? "1" : "0",
  };
}

export function classifyProcessFailure(result: ProcessResult, remote = false): RunResult["failureClass"] {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (/early stopped by evidra/.test(text)) return "early_stopped";
  if (/out of memory|cuda oom|cuda.*memory/.test(text)) return "cuda_oom";
  if (/nan|inf loss/.test(text)) return "nan_loss";
  if (/timed out|timeout/.test(text)) return "timeout";
  if (/no such file|file not found|missing data/.test(text)) return "data_missing";
  if (/module not found|modul enotfound|cannot import|no module named|dependency/.test(text)) return "dependency";
  if (/no space left on device|disk quota|enospc|out of disk space/.test(text)) return "disk";
  if (/rate limit|429|usage limit/.test(text)) return "rate_limit";
  if (/auth|unauthorized|forbidden/.test(text)) return "auth";
  if (remote && /modal|connection reset|connection refused|failed to connect|temporarily unavailable|gateway timeout|\b502\b|\b503\b|container.*(failed|crashed)|worker.*(failed|crashed)/.test(text)) return "transient_cloud";
  return "unknown";
}

export interface ModalWorkerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  artifacts: Record<string, string>;
}

export interface EvaluationMatrixCell {
  fold: number;
  seed: number;
  metrics: Record<string, number>;
}

/** Parse evaluator scalar conventions without accepting arbitrary prose. */
function finiteMetricValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(%)?$/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return undefined;
  return match[2] ? parsed / 100 : parsed;
}

/** Parse an optional worker-emitted fold/seed matrix from JSON or JSONL. */
export function parseEvaluationMatrix(stdout: string, metricName: string): EvaluationMatrixCell[] {
  const candidates: unknown[] = [];
  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const object = value as Record<string, unknown>;
    const source = object.matrix ?? object.results ?? (object.evaluation && typeof object.evaluation === "object" ? (object.evaluation as Record<string, unknown>).results : undefined);
    if (Array.isArray(source)) candidates.push(...source);
  };
  let wholeDocument = false;
  try {
    collect(JSON.parse(stdout));
    wholeDocument = true;
  } catch { /* inspect JSONL below */ }
  if (!wholeDocument) for (const line of stdout.split("\n")) {
    try { collect(JSON.parse(line)); } catch { /* ordinary worker log */ }
  }
  const cells: EvaluationMatrixCell[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const value = candidate as Record<string, unknown>;
    if (!Number.isInteger(value.fold) || Number(value.fold) < 0 || !Number.isInteger(value.seed)) continue;
    const rawMetrics = value.metrics && typeof value.metrics === "object" && !Array.isArray(value.metrics) ? value.metrics as Record<string, unknown> : value.metric !== undefined ? { [metricName]: value.metric } : {};
    const metrics = Object.fromEntries(Object.entries(rawMetrics).flatMap(([name, metric]) => {
      const parsed = finiteMetricValue(metric);
      return parsed === undefined ? [] : [[name, parsed]];
    })) as Record<string, number>;
    if (Object.keys(metrics).length) cells.push({ fold: Number(value.fold), seed: Number(value.seed), metrics });
  }
  // Canonical ordering makes paired comparisons independent of worker log
  // order while intentionally retaining duplicate cells for the validator.
  return cells.sort((left, right) => left.fold - right.fold || left.seed - right.seed);
}

/** Parse the final JSON emitted by modal_app.py without trusting progress logs. */
export function parseModalWorkerResult(output: string): ModalWorkerResult | undefined {
  for (const line of output.trim().split("\n").reverse()) {
    try {
      const candidate = JSON.parse(line) as Record<string, unknown>;
      if (!candidate || typeof candidate !== "object" || typeof candidate.exitCode !== "number" || !Number.isInteger(candidate.exitCode) || candidate.exitCode < 0 || candidate.exitCode > 255) continue;
      const artifacts = candidate.artifacts ?? {};
      if (typeof candidate.stdout !== "string" || typeof candidate.stderr !== "string" || typeof artifacts !== "object" || Array.isArray(artifacts)) continue;
      const normalized: Record<string, string> = {};
      for (const [name, encoded] of Object.entries(artifacts)) {
        if (typeof encoded !== "string" || encoded.length > 96 * 1024 * 1024 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined;
        normalized[name] = encoded;
      }
      return { exitCode: candidate.exitCode, stdout: candidate.stdout, stderr: candidate.stderr, artifacts: normalized };
    } catch { /* Modal progress output is not the worker result. */ }
  }
  return undefined;
}

function safeArtifactPath(root: string, name: string): string | undefined {
  const rootPath = realpathSync(root);
  const destination = resolve(rootPath, name);
  const destinationRelative = relative(rootPath, destination);
  if (destinationRelative.startsWith("..") || isAbsolute(destinationRelative) || name.length === 0) return undefined;
  // Do not follow an existing symlink when importing a worker artifact.
  try { if (lstatSync(destination).isSymbolicLink()) return undefined; } catch { /* destination does not exist yet */ }
  // A symlinked parent can redirect a not-yet-created artifact outside the
  // experiment worktree, so inspect the nearest existing ancestor as well.
  let ancestor = destination;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return undefined;
    ancestor = parent;
  }
  const ancestorRelative = relative(rootPath, realpathSync(ancestor));
  if (ancestorRelative.startsWith("..") || isAbsolute(ancestorRelative)) return undefined;
  return destination;
}

export function parseMetricOutput(stdout: string, metricName: string): { metrics: Record<string, number>; metricsByFold: Record<string, number[]>; subgroupDeltas: number[] } {
  const metrics: Record<string, number> = {};
  const metricsByFold: Record<string, number[]> = {};
  let subgroupDeltas: number[] = [];
  const addObject = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const object = value as Record<string, unknown>;
    const nested = object.metrics;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      for (const [name, metric] of Object.entries(nested as Record<string, unknown>)) {
        const parsed = finiteMetricValue(metric);
        if (parsed !== undefined) metrics[name] = parsed;
      }
      addObject(nested);
    }
    const primary = object[metricName];
    const parsedPrimary = finiteMetricValue(primary);
    if (parsedPrimary !== undefined) metrics[metricName] = parsedPrimary;
    const byFold = object.metricsByFold ?? object.byFold;
    if (byFold && typeof byFold === "object" && !Array.isArray(byFold)) {
      for (const [name, series] of Object.entries(byFold as Record<string, unknown>)) {
        if (Array.isArray(series)) {
          const finite = series.map(finiteMetricValue).filter((item): item is number => item !== undefined);
          if (finite.length) metricsByFold[name] = finite;
        }
      }
    }
    const subgroup = object.subgroupDeltas ?? object.bySubgroupDelta ?? object.subgroupDelta;
    if (Array.isArray(subgroup)) subgroupDeltas = subgroup.map(finiteMetricValue).filter((item): item is number => item !== undefined);
  };
  try { addObject(JSON.parse(stdout)); } catch { /* output may be a log stream */ }
  for (const line of stdout.split("\n")) {
    try { addObject(JSON.parse(line)); } catch { /* non-JSON log line */ }
    const escapedMetric = metricName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
    const keyed = line.match(new RegExp(`(?:^|\\s)[\\\"']?${escapedMetric}[\\\"']?\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)(%)?`, "i"));
    if (keyed) {
      const value = Number(keyed[1]);
      if (Number.isFinite(value)) metrics[metricName] = keyed[2] ? value / 100 : value;
    }
    // Also retain secondary/custom metrics emitted as ordinary keyed log
    // lines, e.g. `accuracy: 91.2%` and `latency_ms=42`. The label is kept
    // deliberately strict so arbitrary prose is not treated as evidence.
    const genericKeyed = line.match(/^\s*["']?([A-Za-z][A-Za-z0-9_./-]*)["']?\s*[:=]\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(%)?\s*$/);
    if (genericKeyed) {
      const value = Number(genericKeyed[2]);
      if (Number.isFinite(value)) metrics[genericKeyed[1]] = genericKeyed[3] ? value / 100 : value;
    }
    // Human-readable evaluator tables often render a stable machine label in
    // brackets, e.g. `Raw MSE [final_layer_mse] 2.22e-04`. Keep this parser
    // generic so competition adapters do not need to know the table's prose.
    const bracketed = line.match(new RegExp(`\\[${escapedMetric}\\]\\s+(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)(%)?`, "i"));
    if (bracketed) {
      const value = Number(bracketed[1]);
      if (Number.isFinite(value)) metrics[metricName] = bracketed[2] ? value / 100 : value;
    }
    const columns = line.split("|").map((column) => column.trim());
    if (columns.length >= 5 && /^\d[\d,]*$/.test(columns[0])) {
      const value = Number(columns[columns.length - 1]);
      if (Number.isFinite(value)) metrics[metricName] = value;
    }
  }
  return { metrics, metricsByFold, subgroupDeltas };
}

function toRunResult(manifest: ExperimentManifest, result: ProcessResult, metricName: string, remote = false): RunResult {
  const parsed = parseMetricOutput(result.stdout, metricName);
  const matrix = parseEvaluationMatrix(result.stdout, metricName);
  const metrics = { ...parsed.metrics };
  const matrixValues = matrix.map((cell) => cell.metrics[metricName]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (metrics[metricName] === undefined && matrixValues.length) metrics[metricName] = matrixValues.reduce((sum, value) => sum + value, 0) / matrixValues.length;
  const metricsByFold = { ...parsed.metricsByFold };
  if (metricsByFold[metricName] === undefined && matrixValues.length) {
    const byFold = new Map<number, number[]>();
    for (const cell of matrix) {
      const value = cell.metrics[metricName];
      if (typeof value === "number" && Number.isFinite(value)) byFold.set(cell.fold, [...(byFold.get(cell.fold) ?? []), value]);
    }
    metricsByFold[metricName] = [...byFold.entries()].sort(([left], [right]) => left - right).flatMap(([, values]) => values);
  }
  const learningCurve = parseLearningCurve(result.stdout, metricName);
  const artifacts: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of manifest.evaluation?.requiredArtifacts ?? []) {
    const path = safeArtifactPath(result.cwd, name);
    const rel = path ? relative(result.cwd, path) : "..";
    if (!path || rel.startsWith("..") || isAbsolute(rel) || !existsSync(path) || !statSync(path).isFile()) {
      missing.push(name);
    } else {
      artifacts[name] = path;
    }
  }
  const artifactFailure = result.exitCode === 0 && missing.length > 0;
  const stderr = artifactFailure ? `${result.stderr}\nMissing required artifacts: ${missing.join(", ")}` : result.stderr;
  return {
    runId: `${manifest.id}-${Date.now()}`,
    status: result.exitCode === 0 && !artifactFailure ? "completed" : "failed",
    exitCode: artifactFailure ? 65 : result.exitCode,
    durationSeconds: result.durationMs / 1000,
    metrics,
    metricsByFold,
    learningCurve,
    subgroupDeltas: parsed.subgroupDeltas,
    ...(matrix.length ? { matrix } : {}),
    artifacts,
    stdout: result.stdout,
    stderr,
    command: result.command,
    cwd: result.cwd,
    ...(artifactFailure ? { failureClass: "corrupt_artifact" as const } : result.exitCode === 0 ? {} : { failureClass: classifyProcessFailure(result, remote) }),
  };
}

/** Require the declared primary metric after the worker and optional evaluator have both run. */
export function validateRunMetric(result: RunResult, metricName: string): RunResult {
  if (result.status !== "completed") return result;
  const metric = result.metrics[metricName];
  if (typeof metric === "number" && Number.isFinite(metric)) return result;
  return {
    ...result,
    status: "failed",
    exitCode: result.exitCode === 0 ? 65 : result.exitCode,
    failureClass: "invalid_metric",
    stderr: `${result.stderr ?? ""}${result.stderr ? "\n" : ""}Missing finite declared metric: ${metricName}`,
  };
}

export class LocalExecutor implements ExperimentExecutor {
  readonly kind = "local" as const;

  async run(manifest: ExperimentManifest, cwd: string, command: string[], onProcess?: (control: ProcessControl) => void, metricName = "final_layer_mse", environment?: NodeJS.ProcessEnv): Promise<RunResult> {
    const experimentEnvironment = prepareExperimentEnvironment(manifest, cwd, environment);
    return toRunResult(manifest, await runProcess(command, cwd, manifest.resources.timeoutMinutes * 60_000, undefined, onProcess, experimentEnvironment, manifest.resources.earlyStopping), metricName);
  }
}

export function containerCommand(runtime: "docker" | "podman", image: string, cwd: string, command: string[], environment: Record<string, string> = {}): string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/.test(image)) throw new Error("Container image must be a plain image reference, not a runtime option or shell expression.");
  const args = [runtime, "run", "--rm", "--init", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512", "--network", "none", "--tmpfs", "/tmp:rw,nosuid,nodev", "--volume", `${cwd}:/workspace:rw`, "--workdir", "/workspace"];
  if (typeof process.getuid === "function" && typeof process.getgid === "function") args.push("--user", `${process.getuid()}:${process.getgid()}`);
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n]/.test(value)) throw new Error("Invalid container environment entry.");
    args.push("--env", `${key}=${value}`);
  }
  return [...args, image, ...command];
}

export class ContainerExecutor implements ExperimentExecutor {
  readonly kind = "container" as const;

  constructor(private readonly workspaceRoot?: string) {}

  async run(manifest: ExperimentManifest, cwd: string, command: string[], onProcess?: (control: ProcessControl) => void, metricName = "final_layer_mse", environment?: NodeJS.ProcessEnv): Promise<RunResult> {
    const experimentEnvironment = prepareExperimentEnvironment(manifest, cwd, environment);
    const requestedRuntime = process.env.EVIDRA_CONTAINER_RUNTIME;
    const candidates: Array<"docker" | "podman"> = requestedRuntime === "podman" ? ["podman"] : requestedRuntime === "docker" ? ["docker"] : requestedRuntime ? [] : ["docker", "podman"];
    const launchRoot = resolve(this.workspaceRoot ?? cwd);
    let runtime: "docker" | "podman" | undefined;
    for (const candidate of candidates) {
      try {
        const available = await runProcess(["which", candidate], launchRoot, 5_000);
        if (available.exitCode === 0) { runtime = candidate; break; }
      } catch { /* continue to the next supported runtime */ }
    }
    const image = manifest.resources.image ?? process.env.EVIDRA_CONTAINER_IMAGE ?? "python:3.11-slim";
    if (!runtime) {
      return toRunResult(manifest, { command, cwd, exitCode: 127, durationMs: 0, stdout: "", stderr: "No Docker or Podman runtime was found. Install one or select the local executor." }, metricName);
    }
    try {
      const result = await runProcess(containerCommand(runtime, image, resolve(cwd), command, {
        EVIDRA_EXPERIMENT_ID: manifest.id,
        EVIDRA_EXPERIMENT_CONFIG: "/workspace/.sota/experiment-config.json",
        EVIDRA_DATASET_VERSION: manifest.datasetVersion ?? "unknown",
        EVIDRA_SPLIT_VERSION: manifest.splitVersion ?? "unknown",
        EVIDRA_MATRIX_REQUIRED: manifest.evaluation?.matrixRequired ? "1" : "0",
      }), launchRoot, manifest.resources.timeoutMinutes * 60_000, undefined, onProcess, experimentEnvironment, manifest.resources.earlyStopping);
      return toRunResult(manifest, { ...result, command, cwd }, metricName);
    } catch (error) {
      return toRunResult(manifest, { command, cwd, exitCode: 126, durationMs: 0, stdout: "", stderr: error instanceof Error ? error.message : String(error) }, metricName);
    }
  }
}

export class ModalExecutor implements ExperimentExecutor {
  readonly kind = "modal" as const;

  constructor(private readonly workspaceRoot?: string) {}

  async run(manifest: ExperimentManifest, cwd: string, command: string[], onProcess?: (control: ProcessControl) => void, metricName = "final_layer_mse", environment?: NodeJS.ProcessEnv): Promise<RunResult> {
    const experimentEnvironment = { ...prepareExperimentEnvironment(manifest, cwd), ...environment };
    // Modal CLI profiles (created by `modal token set`) are valid credentials
    // too; do not require secrets to be duplicated into Evidra's environment.
    const launchRoot = resolve(this.workspaceRoot ?? cwd);
    const experimentWorkspace = resolve(cwd);
    const modalEntrypoint = process.env.EVIDRA_MODAL_ENTRYPOINT ?? "modal_app.py::run";
    const timeoutSeconds = Math.max(60, Math.round(manifest.resources.timeoutMinutes * 60));
    const commandJson = JSON.stringify(command);
    // The worker image must contain the isolated worktree. Mounting the repo
    // root would omit `.sota/worktrees` and silently execute the wrong source.
    const args = ["modal", "run", modalEntrypoint, "--command-json", commandJson, "--cwd", ".", "--artifacts-json", JSON.stringify(manifest.evaluation?.requiredArtifacts ?? []), "--timeout-seconds", String(timeoutSeconds)];
    const result = await runProcess(args, launchRoot, manifest.resources.timeoutMinutes * 60_000, undefined, onProcess, {
      ...process.env,
      EVIDRA_MODAL_WORKSPACE: experimentWorkspace,
      ...(manifest.resources.gpu ? { EVIDRA_MODAL_GPU: manifest.resources.gpu } : {}),
      EVIDRA_MODAL_TIMEOUT_SECONDS: String(timeoutSeconds),
      EVIDRA_EXPERIMENT_ID: manifest.id,
    }, manifest.resources.earlyStopping);
    const payload = parseModalWorkerResult(result.stdout);
    if (!payload) return toRunResult(manifest, { ...result, command, cwd }, metricName, true);
    const allowedArtifacts = new Set(manifest.evaluation?.requiredArtifacts ?? []);
    for (const [name, encoded] of Object.entries(payload.artifacts ?? {})) {
      if (!allowedArtifacts.has(name)) continue;
      const destination = safeArtifactPath(cwd, name);
      if (!destination) continue;
      mkdirSync(dirname(destination), { recursive: true });
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.length > 64 * 1024 * 1024) continue;
      writeFileSync(destination, decoded);
    }
    return toRunResult(manifest, { ...result, command, exitCode: payload.exitCode, stdout: payload.stdout, stderr: payload.stderr, cwd }, metricName, true);
  }
}

export function executorFor(kind: ExperimentManifest["resources"]["executor"], workspaceRoot?: string): ExperimentExecutor {
  if (kind === "modal") return new ModalExecutor(workspaceRoot);
  if (kind === "container") return new ContainerExecutor(workspaceRoot);
  return new LocalExecutor();
}
