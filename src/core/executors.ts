import { boundProcessOutput, processFailureResult, runProcess, type ProcessControl } from "./process.js";
import { parseLearningCurve } from "./early-stopping.js";
import { redactStructured } from "./redaction.js";
import { constants, openSync, closeSync, fstatSync, readSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExperimentExecutorKind, ExperimentManifest, ProcessResult, RunResult } from "./types.js";
import { randomUUID } from "node:crypto";

export interface RemoteExecutionEvent {
  executor: "slurm" | "container" | "modal";
  experimentId: string;
  submissionId: string;
  phase: "submitting" | "submitted" | "terminal";
  at: string;
  jobId?: string;
  allocationName?: string;
  cluster?: string;
  state?: string;
  exitCode?: number;
  runtime?: "docker" | "podman";
  containerId?: string;
  daemonId?: string;
  completionEvidence?: "client-envelope" | "sdk-result";
  protocol?: "modal-call-v1";
  callId?: string;
}
export type RemoteExecutionObserver = (event: RemoteExecutionEvent) => void;

export interface ExperimentExecutor {
  readonly kind: ExperimentExecutorKind;
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
      environment: manifest.resources.environment ?? {},
    },
    configPatch: manifest.change?.configPatch ?? {},
  });
  writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return {
    ...safeWorkerEnvironment({ ...(manifest.resources.environment ?? {}), ...overrides, HOME: workerHome }),
    EVIDRA_EXPERIMENT_ID: manifest.id,
    EVIDRA_EXPERIMENT_CONFIG: configPath,
    EVIDRA_DATASET_VERSION: datasetVersion,
    EVIDRA_SPLIT_VERSION: splitVersion,
    EVIDRA_MATRIX_REQUIRED: manifest.evaluation?.matrixRequired ? "1" : "0",
  };
}

export function classifyProcessFailure(result: ProcessResult, remote = false): RunResult["failureClass"] {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  // WhestBench emits structured runner errors on stdout and may exit before
  // producing its normal metrics JSON. Preserve the failure semantics so the
  // recovery planner can retry transient scoring-worker/dataset-generation
  // faults, rather than misclassifying them as candidate regressions.
  if (/scoring_runtime_error/.test(text) && /generating (?:the )?dataset|dataset generation/.test(text)) return "transient_cloud";
  if (/early stopped by evidra/.test(text)) return "early_stopped";
  if (/cuda oom|cuda.*memory/.test(text)) return "cuda_oom";
  if (/out of memory|unable to allocate\s+\d+(?:\.\d+)?\.?\s*(?:kib|mib|gib|kb|mb|gb)|memoryerror|cannot allocate memory|can't allocate memory|failed to allocate|allocation failed|not enough memory|std::bad_alloc|oom[- ]kill(?:er)?|memory limit exceeded/.test(text)) return "memory_exhausted";
  if (/nan|inf loss/.test(text)) return "nan_loss";
  if (/timed out|timeout/.test(text)) return "timeout";
  if (/no such file|file not found|missing data/.test(text)) return "data_missing";
  if (/enoent|eacces|permission denied|module not found|modul enotfound|err_module_not_found|cannot find (?:package|module)|cannot import|no module named|dependency|\b(?:command|executable) not found\b|(?:^|\n)\s*(?:sh|bash|zsh):\s*\d+:\s*[^:\n]+:\s*not found\b/.test(text)) return "dependency";
  if (/no space left on device|disk quota|enospc|out of disk space/.test(text)) return "disk";
  if (/rate limit|429|usage limit/.test(text)) return "rate_limit";
  if (/auth|unauthorized|forbidden/.test(text)) return "auth";
  if (/bwrap|loopback|network namespace|sandbox.*(?:denied|failed)|(?:network|namespace).*(?:operation not permitted|permission denied)/.test(text)) return "sandbox";
  if (remote && /modal|slurm|sbatch|squeue|sacct|connection reset|connection refused|failed to connect|temporarily unavailable|gateway timeout|\b502\b|\b503\b|container.*(failed|crashed)|worker.*(failed|crashed)|compute node.*(failed|down)/.test(text)) return "transient_cloud";
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
  let result: ModalWorkerResult | undefined;
  for (const line of output.trim().split("\n")) {
    let candidate: Record<string, unknown>;
    try { candidate = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; /* Modal progress output is not the worker result. */ }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !Object.hasOwn(candidate, "exitCode")) continue;
    // Never fall back to an earlier success after malformed or duplicate
    // completion evidence. The worker emits exactly one terminal envelope.
    if (result || typeof candidate.exitCode !== "number" || !Number.isInteger(candidate.exitCode) || candidate.exitCode < 0 || candidate.exitCode > 255) return undefined;
    const artifacts = candidate.artifacts === undefined ? {} : candidate.artifacts;
    if (typeof candidate.stdout !== "string" || typeof candidate.stderr !== "string" || !artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) return undefined;
    const normalized: Record<string, string> = {};
    for (const [name, encoded] of Object.entries(artifacts)) {
      if (typeof encoded !== "string" || encoded.length > 96 * 1024 * 1024 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined;
      if (Buffer.from(encoded, "base64").toString("base64") !== encoded) return undefined;
      normalized[name] = encoded;
    }
    result = { exitCode: candidate.exitCode, stdout: candidate.stdout, stderr: candidate.stderr, artifacts: normalized };
  }
  return result;
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

export function parseMetricOutput(stdout: string, metricName: string): { metrics: Record<string, number>; metricsByFold: Record<string, number[]>; subgroupDeltas: number[]; conflicts: Array<{ name: string; values: number[] }> } {
  const metrics: Record<string, number> = {};
  const metricsByFold: Record<string, number[]> = {};
  const observed = new Map<string, Set<number>>();
  let subgroupDeltas: number[] = [];
  const setMetric = (name: string, value: number): void => {
    const values = observed.get(name) ?? new Set<number>();
    values.add(value);
    observed.set(name, values);
    metrics[name] = value;
  };
  const addObject = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const object = value as Record<string, unknown>;
    const nested = object.metrics;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      for (const [name, metric] of Object.entries(nested as Record<string, unknown>)) {
        const parsed = finiteMetricValue(metric);
        if (parsed !== undefined) setMetric(name, parsed);
      }
      addObject(nested);
    }
    const primary = object[metricName];
    const parsedPrimary = finiteMetricValue(primary);
    if (parsedPrimary !== undefined) setMetric(metricName, parsedPrimary);
    // Structured evaluators commonly emit a primary metric beside auxiliary
    // objectives at the top level, e.g. {score, latency_ms, safety}. Preserve
    // every finite scalar here; callers decide which names are required by
    // their metric contract, while unknown metadata remains harmlessly
    // available for diagnostics.
    for (const [name, metric] of Object.entries(object)) {
      if (name === "metrics" || name === metricName || name === "metricsByFold" || name === "byFold" || name === "subgroupDeltas" || name === "bySubgroupDelta" || name === "subgroupDelta") continue;
      const parsedMetric = finiteMetricValue(metric);
      if (parsedMetric !== undefined) metrics[name] = parsedMetric;
    }
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
  const lines = stdout.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    try { addObject(JSON.parse(line)); } catch { /* non-JSON log line */ }
    const escapedMetric = metricName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
    const keyed = line.match(new RegExp(`(?:^|\\s)[\\\"']?${escapedMetric}[\\\"']?\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)(%)?`, "i"));
    if (keyed) {
      const value = Number(keyed[1]);
      if (Number.isFinite(value)) setMetric(metricName, keyed[2] ? value / 100 : value);
    }
    // Also retain secondary/custom metrics emitted as ordinary keyed log
    // lines, e.g. `accuracy: 91.2%` and `latency_ms=42`. The label is kept
    // deliberately strict so arbitrary prose is not treated as evidence.
    const genericKeyed = line.match(/^\s*["']?([A-Za-z][A-Za-z0-9_./-]*)["']?\s*[:=]\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(%)?\s*$/);
    if (genericKeyed) {
      const value = Number(genericKeyed[2]);
      if (Number.isFinite(value)) setMetric(genericKeyed[1], genericKeyed[3] ? value / 100 : value);
    }
    // Human-readable tables can put a machine label either beside its value
    // or on the following line. Preserve every labeled scalar so competition
    // adapters can declare the official metric plus independent guardrails.
    for (const match of line.matchAll(/\[([A-Za-z][A-Za-z0-9_./-]*)\]/g)) {
      const name = match[1];
      if (!name) continue;
      const afterLabel = line.slice((match.index ?? 0) + name.length + 2);
      const inline = afterLabel.match(/^\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(%)?/);
      const preceding = inline ? undefined : lines[lineIndex - 1]?.match(/(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(%)?\s*[^\d]*$/);
      const valueText = inline?.[1] ?? preceding?.[1];
      const isPercent = inline?.[2] ?? preceding?.[2];
      if (valueText !== undefined) {
        const value = Number(valueText);
        if (Number.isFinite(value)) setMetric(name, isPercent ? value / 100 : value);
      }
    }
    const columns = line.split("|").map((column) => column.trim());
    if (columns.length >= 5 && /^\d[\d,]*$/.test(columns[0])) {
      const value = Number(columns[columns.length - 1]);
      if (Number.isFinite(value)) setMetric(metricName, value);
    }
  }
  return { metrics, metricsByFold, subgroupDeltas, conflicts: [...observed.entries()].filter(([, values]) => values.size > 1).map(([name, values]) => ({ name, values: [...values] })) };
}

/** Merge an independent evaluator without allowing ambiguous output to rewrite a run. */
export function mergeEvaluatorResult(base: RunResult, evaluator: ProcessResult, metricName: string): RunResult {
  const parsed = parseMetricOutput(evaluator.stdout, metricName);
  const learningCurve = parseLearningCurve(evaluator.stdout, metricName);
  const conflicts = parsed.conflicts.filter((conflict) => conflict.name === metricName && learningCurve.length === 0);
  const metricFailure = evaluator.exitCode === 0 && conflicts.length > 0;
  const evaluatorError = metricFailure
    ? `Conflicting declared evaluator metric outputs: ${conflicts.map((conflict) => `${conflict.name}=[${conflict.values.join(", ")}]`).join("; ")}`
    : evaluator.stderr;
  return {
    ...base,
    status: evaluator.exitCode === 0 && !metricFailure ? "completed" : "failed",
    exitCode: metricFailure ? 65 : evaluator.exitCode,
    metrics: { ...base.metrics, ...parsed.metrics },
    metricsByFold: { ...base.metricsByFold, ...parsed.metricsByFold },
    subgroupDeltas: parsed.subgroupDeltas,
    stdout: `${base.stdout ?? ""}\n[EVALUATOR]\n${evaluator.stdout}`,
    stderr: `${base.stderr ?? ""}\n[EVALUATOR]\n${evaluatorError}`,
    ...(base.metricConflicts?.length || parsed.conflicts.length ? { metricConflicts: [...(base.metricConflicts ?? []), ...parsed.conflicts] } : {}),
    ...(metricFailure ? { failureClass: "invalid_metric" as const } : evaluator.exitCode === 0 ? {} : { failureClass: classifyProcessFailure(evaluator) ?? "unknown" }),
  };
}

function toRunResult(manifest: ExperimentManifest, result: ProcessResult, metricName: string, remote = false): RunResult {
  const parsed = parseMetricOutput(result.stdout, metricName);
  const matrix = parseEvaluationMatrix(result.stdout, metricName);
  const metrics = { ...parsed.metrics };
  const metricsByFold = { ...parsed.metricsByFold };
  const objectiveNames = [...new Set([metricName, ...(manifest.evaluation?.metrics ?? []).map((objective) => objective.name)].filter(Boolean))];
  for (const name of objectiveNames) {
    const matrixValues = matrix.map((cell) => cell.metrics[name]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (metrics[name] === undefined && matrixValues.length) metrics[name] = matrixValues.reduce((sum, value) => sum + value, 0) / matrixValues.length;
    if (metricsByFold[name] === undefined && matrixValues.length) {
      const byFold = new Map<number, number[]>();
      for (const cell of matrix) {
        const value = cell.metrics[name];
        if (typeof value === "number" && Number.isFinite(value)) byFold.set(cell.fold, [...(byFold.get(cell.fold) ?? []), value]);
      }
      metricsByFold[name] = [...byFold.entries()].sort(([left], [right]) => left - right).flatMap(([, values]) => values);
    }
  }
  const learningCurve = parseLearningCurve(result.stdout, metricName);
  const metricConflicts = parsed.conflicts.filter((conflict) => conflict.name === metricName && learningCurve.length === 0);
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
  const metricFailure = result.exitCode === 0 && metricConflicts.length > 0;
  const stderr = artifactFailure
    ? `${result.stderr}\nMissing required artifacts: ${missing.join(", ")}`
    : metricFailure
      ? `${result.stderr}\nConflicting declared metric outputs: ${metricConflicts.map((conflict) => `${conflict.name}=[${conflict.values.join(", ")}]`).join("; ")}`
      : result.stderr;
  return {
    runId: `${manifest.id}-${Date.now()}`,
    status: result.exitCode === 0 && !artifactFailure && !metricFailure ? "completed" : "failed",
    exitCode: artifactFailure || metricFailure ? 65 : result.exitCode,
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
    ...(artifactFailure ? { failureClass: "corrupt_artifact" as const } : metricFailure ? { failureClass: "invalid_metric" as const } : result.exitCode === 0 ? {} : { failureClass: classifyProcessFailure(result, remote) }),
    ...(parsed.conflicts.length ? { metricConflicts: parsed.conflicts } : {}),
  };
}

/** Require every declared metric after the worker and optional evaluator have both run. */
export function validateRunMetrics(result: RunResult, metricNames: string[]): RunResult {
  if (result.status !== "completed") return result;
  const missing = [...new Set(metricNames.filter((name) => typeof result.metrics[name] !== "number" || !Number.isFinite(result.metrics[name])))];
  if (!missing.length) return result;
  return {
    ...result,
    status: "failed",
    exitCode: result.exitCode === 0 ? 65 : result.exitCode,
    failureClass: "invalid_metric",
    stderr: `${result.stderr ?? ""}${result.stderr ? "\n" : ""}Missing finite declared metric${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
  };
}

/** Backward-compatible single-primary validation helper. */
export function validateRunMetric(result: RunResult, metricName: string): RunResult {
  return validateRunMetrics(result, [metricName]);
}

export class LocalExecutor implements ExperimentExecutor {
  readonly kind = "local" as const;

  async run(manifest: ExperimentManifest, cwd: string, command: string[], onProcess?: (control: ProcessControl) => void, metricName = "final_layer_mse", environment?: NodeJS.ProcessEnv): Promise<RunResult> {
    const experimentEnvironment = prepareExperimentEnvironment(manifest, cwd, environment);
    try {
      return toRunResult(manifest, await runProcess(command, cwd, manifest.resources.timeoutMinutes * 60_000, undefined, onProcess, experimentEnvironment, manifest.resources.earlyStopping), metricName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toRunResult(manifest, { command, cwd, exitCode: 127, durationMs: 0, stdout: "", stderr: message }, metricName);
    }
  }
}

export function containerCommand(runtime: "docker" | "podman", image: string, cwd: string, command: string[], environment: Record<string, string> = {}, identity?: { name: string; cidFile: string }): string[] {
  if (!command.length || command.some((part) => typeof part !== "string" || part.includes("\0")) || !command[0].trim() || command[0].startsWith("-")) throw new Error("Container commands require a non-empty executable and valid argv strings.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/.test(image)) throw new Error("Container image must be a plain image reference, not a runtime option or shell expression.");
  const args = [runtime, "run", "--rm", "--init", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512", "--network", "none", "--tmpfs", "/tmp:rw,nosuid,nodev", "--volume", `${cwd}:/workspace:rw`, "--workdir", "/workspace"];
  if (identity) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(identity.name) || !isAbsolute(identity.cidFile)) throw new Error("Container identity requires a plain name and absolute receipt path.");
    args.splice(args.indexOf("--rm"), 1);
    args.push("--name", identity.name, "--cidfile", identity.cidFile);
    args.push("--label", `org.evidra.allocation=${identity.name}`);
  }
  if (typeof process.getuid === "function" && typeof process.getgid === "function") args.push("--user", `${process.getuid()}:${process.getgid()}`);
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n]/.test(value)) throw new Error("Invalid container environment entry.");
    args.push("--env", `${key}=${value}`);
  }
  // Images supply dependencies, not alternate startup code or background work.
  return [...args, "--no-healthcheck", "--entrypoint", command[0], image, ...command.slice(1)];
}

export class ContainerExecutor implements ExperimentExecutor {
  readonly kind = "container" as const;

  constructor(private readonly workspaceRoot?: string, private readonly onRemoteExecution?: RemoteExecutionObserver) {}

  async run(manifest: ExperimentManifest, cwd: string, command: string[], onProcess?: (control: ProcessControl) => void, metricName = "final_layer_mse", environment?: NodeJS.ProcessEnv): Promise<RunResult> {
    prepareExperimentEnvironment(manifest, cwd, environment);
    // Runtime clients need controller-side endpoint/auth configuration. Only
    // explicit --env entries above cross into the worker container.
    const runtimeEnvironment = { ...process.env };
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
    let daemonId: string | undefined;
    if (runtime === "docker") {
      try {
        const info = await runProcess([runtime, "info", "--format", "{{.ID}}"], launchRoot, 10_000, undefined, undefined, runtimeEnvironment);
        if (info.exitCode === 0 && /^[A-Za-z0-9][A-Za-z0-9:-]{15,127}$/.test(info.stdout.trim())) daemonId = info.stdout.trim();
      } catch { /* Refuse launch when the daemon identity cannot be established. */ }
      if (!daemonId) return toRunResult(manifest, { command, cwd, exitCode: 127, durationMs: 0, stdout: "", stderr: "Docker daemon identity is unavailable; container launch refused." }, metricName);
    }
    const receiptRoot = mkdtempSync(join(tmpdir(), "evidra-container-"));
    const submissionId = randomUUID();
    const identity = { name: `evidra-${submissionId}`, cidFile: join(receiptRoot, "container-id") };
    const observe = (phase: RemoteExecutionEvent["phase"], details: Partial<RemoteExecutionEvent> = {}): void => {
      this.onRemoteExecution?.({ ...details, executor: "container", experimentId: manifest.id, submissionId, allocationName: identity.name, runtime, ...(daemonId ? { daemonId } : {}), phase, at: new Date().toISOString() });
    };
    // An interrupted runtime client can leave a daemon-owned worker running.
    try { observe("submitting"); }
    catch (error) { rmSync(receiptRoot, { recursive: true, force: true }); throw error; }
    const started = Date.now();
    try {
      let result: ProcessResult;
      try { result = await runProcess(containerCommand(runtime, image, resolve(cwd), command, {
        EVIDRA_EXPERIMENT_ID: manifest.id,
        EVIDRA_EXPERIMENT_CONFIG: "/workspace/.sota/experiment-config.json",
        EVIDRA_DATASET_VERSION: manifest.datasetVersion ?? "unknown",
        EVIDRA_SPLIT_VERSION: manifest.splitVersion ?? "unknown",
        EVIDRA_MATRIX_REQUIRED: manifest.evaluation?.matrixRequired ? "1" : "0",
      }, identity), launchRoot, manifest.resources.timeoutMinutes * 60_000, undefined, onProcess, runtimeEnvironment, manifest.resources.earlyStopping); }
      catch (error) { result = processFailureResult(command, cwd, error); }
      const receipt = boundedFile(receiptRoot, "container-id").trim();
      const containerId = /^[a-f0-9]{64}$/.test(receipt) ? receipt : undefined;
      let receiptError: unknown;
      if (containerId) {
        try { observe("submitted", { containerId }); }
        catch (error) { receiptError = error instanceof Error ? error : new Error(String(error)); }
      }
      const control = async (argv: string[]): Promise<ProcessResult> => {
        try { return await runProcess(argv, launchRoot, 10_000, undefined, undefined, runtimeEnvironment); }
        catch (error) { return processFailureResult(argv, launchRoot, error); }
      };
      const removed = await control([runtime, "rm", "--force", "--volumes", containerId ?? identity.name]);
      const inspected = await control([runtime, "ps", "--all", "--no-trunc", "--filter", containerId ? `id=${containerId}` : `name=${identity.name}`, "--format", "{{.ID}}"]);
      const daemonAfter = daemonId ? await control([runtime, "info", "--format", "{{.ID}}"]): undefined;
      const confirmed = containerId !== undefined && inspected.exitCode === 0 && !inspected.stdout.trim() && (!daemonId || daemonAfter?.exitCode === 0 && daemonAfter.stdout.trim() === daemonId);
      if (confirmed && !receiptError) observe("terminal", { containerId, state: "REMOVED", exitCode: 0 });
      const stderr = boundProcessOutput([result.stderr,
        confirmed ? `Container ${containerId}: removed and verified absent.` : "",
        removed.exitCode !== 0 ? `Container removal request exited ${removed.exitCode}: ${removed.stderr}` : "",
        !confirmed ? `Container termination is unconfirmed (${runtime}, ${containerId ?? identity.name}); reconcile before replay. ${inspected.stderr}` : "",
        receiptError ? `Container receipt durability failed: ${String(receiptError)}` : "",
      ].filter(Boolean).join("\n"));
      const outcome = toRunResult(manifest, { ...result, command, cwd, durationMs: Date.now() - started, stderr, exitCode: !confirmed && result.exitCode === 0 ? 1 : result.exitCode }, metricName);
      return confirmed && !receiptError ? outcome : { ...outcome, status: "failed", failureClass: "unknown", exitCode: outcome.exitCode === 0 ? 1 : outcome.exitCode };
    } catch (error) {
      return { ...toRunResult(manifest, { command, cwd, exitCode: 126, durationMs: Date.now() - started, stdout: "", stderr: `Container termination is unconfirmed (${identity.name}): ${error instanceof Error ? error.message : String(error)}` }, metricName), failureClass: "unknown" };
    } finally { rmSync(receiptRoot, { recursive: true, force: true }); }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Build a safe Slurm submission argv for a shared-filesystem worktree. */
export function slurmCommand(jobName: string, cwd: string, command: string[], stdoutPath: string, stderrPath: string, timeoutMinutes: number, gpu?: string): string[] {
  if (!command.length || command.some((part) => typeof part !== "string")) throw new Error("Slurm commands must contain a non-empty argv array.");
  const safeJobName = jobName.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80);
  const args = ["sbatch", "--parsable", "--no-requeue", "--job-name", safeJobName || "evidra", "--chdir", resolve(cwd), "--output", resolve(stdoutPath), "--error", resolve(stderrPath), "--time", String(Math.max(1, Math.ceil(timeoutMinutes)))];
  if (gpu) args.push("--gres", `gpu:${gpu}`);
  args.push("--wrap", `exec ${command.map(shellQuote).join(" ")}`);
  return args;
}

function boundedFile(root: string, name: string): string {
  let descriptor: number | undefined;
  try {
    const path = safeArtifactPath(root, name);
    if (!path) return "";
    const before = lstatSync(path);
    if (!before.isFile()) return "";
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const current = fstatSync(descriptor);
    if (!current.isFile() || before.dev !== current.dev || before.ino !== current.ino) return "";
    const limit = 16 * 1024 * 1024;
    const read = (position: number, length: number): Buffer => {
      const bytes = Buffer.alloc(length);
      let used = 0;
      while (used < length) {
        const received = readSync(descriptor!, bytes, used, length - used, position + used);
        if (!received) break;
        used += received;
      }
      return bytes.subarray(0, used);
    };
    if (current.size <= limit) return boundProcessOutput(read(0, current.size).toString("utf8"));
    const half = Math.floor(limit / 2) - 128;
    const head = read(0, half + 3);
    const tail = read(current.size - half - 3, half + 3);
    let headEnd = Math.min(half, head.length);
    let tailStart = Math.min(3, tail.length);
    while (headEnd > 0 && (head[headEnd] & 0xc0) === 0x80) headEnd -= 1;
    while (tailStart < tail.length && (tail[tailStart] & 0xc0) === 0x80) tailStart += 1;
    return boundProcessOutput(head.subarray(0, headEnd).toString("utf8") + "\n...[output truncated by Evidra]...\n" + tail.subarray(tailStart).toString("utf8"));
  } catch { return ""; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** Match the allocation itself; a completed batch step is not job completion. */
export function parseSlurmAccounting(output: string, jobId: string, allocationName?: string): { state: string; exitCode: number; terminal: boolean } {
  const rows = output.split(/\r?\n/).map((line) => line.trim().split("|")).filter((row) => row[0]?.trim() === jobId && (allocationName === undefined || row[3]?.trim() === allocationName));
  if (rows.length !== 1) return { state: "UNKNOWN", exitCode: 1, terminal: false };
  const state = rows[0][1]?.trim().toUpperCase().split(/\s+/)[0] ?? "UNKNOWN";
  const code = rows[0][2]?.trim().match(/^(\d+):(\d+)$/);
  const terminal = ["COMPLETED", "CANCELLED", "TIMEOUT", "FAILED", "OUT_OF_MEMORY", "NODE_FAIL", "PREEMPTED", "BOOT_FAIL", "DEADLINE", "REVOKED"].includes(state);
  if (!terminal || !code) return { state, exitCode: 1, terminal: false };
  const status = Number(code[1]);
  const signal = Number(code[2]);
  const exitCode = state === "TIMEOUT" ? 124 : state === "CANCELLED" ? 130
    : signal > 0 ? 128 + Math.min(127, signal) : status > 0 ? Math.min(255, status) : state === "COMPLETED" ? 0 : 1;
  return { state, exitCode, terminal };
}

export class SlurmExecutor implements ExperimentExecutor {
  readonly kind = "slurm" as const;

  constructor(private readonly workspaceRoot?: string, private readonly onRemoteExecution?: RemoteExecutionObserver) {}

  async run(manifest: ExperimentManifest, cwd: string, command: string[], onProcess?: (control: ProcessControl) => void, metricName = "final_layer_mse", environment?: NodeJS.ProcessEnv): Promise<RunResult> {
    const launchRoot = resolve(this.workspaceRoot ?? cwd);
    const available = await runProcess(["which", "sbatch"], launchRoot, 5_000);
    if (available.exitCode !== 0) return toRunResult(manifest, { command, cwd, exitCode: 127, durationMs: 0, stdout: "", stderr: "No Slurm sbatch runtime was found. Install Slurm client tools or select another executor." }, metricName, true);
    const experimentEnvironment = prepareExperimentEnvironment(manifest, cwd, environment);
    const logRoot = join(resolve(cwd), ".sota", "slurm");
    mkdirSync(logRoot, { recursive: true, mode: 0o700 });
    const suffix = `${manifest.id.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 48)}-${Date.now()}`;
    const stdoutPath = join(logRoot, `${suffix}.out`);
    const stderrPath = join(logRoot, `${suffix}.err`);
    const submissionId = randomUUID();
    const allocationName = `evidra-${submissionId}`;
    const submit = slurmCommand(allocationName, cwd, command, stdoutPath, stderrPath, manifest.resources.timeoutMinutes, manifest.resources.gpu);
    const started = Date.now();
    const observe = (phase: RemoteExecutionEvent["phase"], details: Partial<RemoteExecutionEvent> = {}): void => {
      this.onRemoteExecution?.({ ...details, executor: "slurm", experimentId: manifest.id, submissionId, allocationName, phase, at: new Date().toISOString() });
    };
    // Persist intent before any RPC: controller loss during sbatch may leave
    // an accepted allocation even when no receipt reaches the client.
    observe("submitting");
    let submission: ProcessResult;
    try {
      submission = await runProcess(submit, launchRoot, Math.max(1, Math.min(30_000, manifest.resources.timeoutMinutes * 60_000)), undefined, onProcess, experimentEnvironment);
    } catch (error) {
      return { ...toRunResult(manifest, { command, cwd: launchRoot, exitCode: 127, durationMs: Date.now() - started, stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\nSlurm submission outcome is unconfirmed; reconcile the allocation before relaunching.` }, metricName, true), failureClass: "unknown" };
    }
    if (submission.exitCode !== 0) {
      const ambiguous = submission.exitCode === 124 || submission.exitCode === 130 || /^\d+(?:;|\s|$)/.test(submission.stdout.trim());
      const failed = toRunResult(manifest, { ...submission, command, cwd, stderr: submission.stderr + (ambiguous ? "\nSlurm submission outcome is unconfirmed; reconcile the allocation before relaunching." : "") }, metricName, true);
      return ambiguous ? { ...failed, failureClass: "unknown" } : failed;
    }
    const receipt = submission.stdout.trim().match(/^(\d+)(?:;([A-Za-z0-9][A-Za-z0-9_.-]*))?$/);
    if (!receipt) return { ...toRunResult(manifest, { command, cwd, exitCode: 65, durationMs: Date.now() - started, stdout: submission.stdout, stderr: "Slurm submission receipt is ambiguous; reconcile the remote allocation before relaunching." }, metricName, true), failureClass: "unknown" };
    const jobId = receipt[1];
    const clusterArgs = receipt[2] ? ["--clusters", receipt[2]] : [];
    const remoteCommand = async (argv: string[], timeoutMs: number, exposeControl = false): Promise<ProcessResult> => {
      try { return await runProcess(argv, launchRoot, timeoutMs, undefined, exposeControl ? (control) => { activeControl = control; } : undefined); }
      catch (error) { return processFailureResult(argv, launchRoot, error); }
      finally { if (exposeControl) activeControl = undefined; }
    };
    let cancelled = false;
    let interrupted = false;
    let timedOut = false;
    let monitoringError = "";
    let activeControl: ProcessControl | undefined;
    let cancellation: Promise<ProcessResult> | undefined;
    const cancel = (): Promise<ProcessResult> => {
      cancelled = true;
      // All callers join one in-flight request. Fire-and-forget UI termination
      // must not race the final accounting query or hide scancel failure.
      return cancellation ??= remoteCommand(["scancel", ...clusterArgs, jobId], 10_000);
    };
    try {
      observe("submitted", { jobId, ...(receipt[2] ? { cluster: receipt[2] } : {}) });
      onProcess?.({
        pause: () => activeControl?.pause(),
        resume: () => activeControl?.resume(),
        terminate: () => { interrupted = true; void cancel(); activeControl?.terminate(); },
        get paused() { return activeControl?.paused ?? false; },
      });
    } catch (error) {
      monitoringError = error instanceof Error ? error.message : String(error);
      await cancel();
    }

    const deadline = started + manifest.resources.timeoutMinutes * 60_000;
    while (!cancelled && Date.now() < deadline) {
      const status = await remoteCommand(["squeue", ...clusterArgs, "--noheader", "--jobs", jobId, "--format=%T"], Math.max(1, Math.min(10_000, deadline - Date.now())), true);
      if (status.exitCode !== 0) {
        interrupted ||= status.exitCode === 130;
        timedOut ||= status.exitCode === 124 && Date.now() >= deadline;
        monitoringError = `Slurm queue query failed for job ${jobId}: ${status.stderr || `exit ${status.exitCode}`}`;
        await cancel();
        break;
      }
      if (!status.stdout.trim()) break;
      await new Promise((resolveSleep) => setTimeout(resolveSleep, Math.min(2_000, Math.max(0, deadline - Date.now()))));
    }
    if (!cancelled && Date.now() >= deadline) { timedOut = true; await cancel(); }
    const cancellationResult = cancellation ? await cancellation : undefined;
    const accounting = await remoteCommand(["sacct", ...clusterArgs, "--noheader", "--parsable2", "--allocations", "--duplicates", "--starttime", "1970-01-01", "--jobs", jobId, "--format=JobIDRaw,State%40,ExitCode,JobName%80"], 15_000);
    const remote = parseSlurmAccounting(accounting.stdout, jobId, allocationName);
    const unconfirmed = accounting.exitCode !== 0 || !remote.terminal;
    if (!unconfirmed) {
      try { observe("terminal", { jobId, ...(receipt[2] ? { cluster: receipt[2] } : {}), state: remote.state, exitCode: remote.exitCode }); }
      catch (error) { monitoringError = `Remote accounting could not be persisted: ${error instanceof Error ? error.message : String(error)}`; }
    }
    const output = boundedFile(cwd, relative(cwd, stdoutPath));
    const error = boundedFile(cwd, relative(cwd, stderrPath));
    const exitCode = timedOut ? 124 : interrupted ? 130 : monitoringError || unconfirmed ? 1 : remote.exitCode;
    const stderr = boundProcessOutput([error, submission.stderr, monitoringError, accounting.stderr,
      cancellationResult && cancellationResult.exitCode !== 0 ? `Slurm cancellation request failed for job ${jobId}: ${cancellationResult.stderr || `exit ${cancellationResult.exitCode}`}` : "",
      `Slurm job ${jobId}${receipt[2] ? ` on ${receipt[2]}` : ""}: ${remote.state}`,
      timedOut ? "Timed out." : "",
      interrupted ? "Interrupted by Evidra." : "",
      unconfirmed ? "Remote completion/cancellation is unconfirmed; reconcile this allocation before relaunching." : "",
    ].filter(Boolean).join("\n"));
    const result = toRunResult(manifest, { command, cwd, exitCode, durationMs: Date.now() - started, stdout: output || submission.stdout, stderr }, metricName, true);
    if (unconfirmed || interrupted || monitoringError && !timedOut) return { ...result, failureClass: "unknown" };
    if (timedOut || remote.state === "TIMEOUT") return { ...result, failureClass: "timeout" };
    if (remote.state === "CANCELLED") return { ...result, failureClass: "unknown" };
    if (remote.state === "OUT_OF_MEMORY") return { ...result, failureClass: "memory_exhausted" };
    if (result.failureClass === "transient_cloud" && !["NODE_FAIL", "BOOT_FAIL", "PREEMPTED"].includes(remote.state)) return { ...result, failureClass: "unknown" };
    return result;

  }
}

export class ModalExecutor implements ExperimentExecutor {
  readonly kind = "modal" as const;

  constructor(private readonly workspaceRoot?: string, private readonly onRemoteExecution?: RemoteExecutionObserver) {}

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
    const submissionId = randomUUID();
    const args = ["modal", "run", modalEntrypoint, "--command-json", commandJson, "--cwd", ".", "--artifacts-json", JSON.stringify(manifest.evaluation?.requiredArtifacts ?? []), "--timeout-seconds", String(timeoutSeconds), "--submission-id", submissionId];
    const observe = (phase: RemoteExecutionEvent["phase"], details: Partial<RemoteExecutionEvent> = {}): void => {
      this.onRemoteExecution?.({ ...details, executor: "modal", protocol: "modal-call-v1", experimentId: manifest.id, submissionId, allocationName: `evidra-${submissionId}`, phase, at: new Date().toISOString() });
    };
    // Persist before launch: losing the client cannot prove the remote worker
    // stopped, even when the local process exits or never returns a receipt.
    observe("submitting");
    let callId: string | undefined;
    let pendingLine = "";
    let oversizedLine = false;
    const receive = (stream: "stdout" | "stderr", chunk: string): void => {
      if (stream !== "stdout") return;
      const parts = chunk.split("\n");
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (!oversizedLine) {
          if (pendingLine.length + part.length > 4096) { pendingLine = ""; oversizedLine = true; }
          else pendingLine += part;
        }
        if (index === parts.length - 1) continue;
        if (!oversizedLine && pendingLine.startsWith("[evidra-call] ")) {
          const receipt = JSON.parse(pendingLine.slice("[evidra-call] ".length)) as { submissionId?: unknown; callId?: unknown };
          if (receipt.submissionId !== submissionId || typeof receipt.callId !== "string" || !/^fc-[A-Za-z0-9]{1,128}$/.test(receipt.callId) || callId) throw new Error("Modal call receipt is malformed, mismatched, or duplicated.");
          observe("submitted", { callId: receipt.callId });
          callId = receipt.callId;
        }
        pendingLine = "";
        oversizedLine = false;
      }
    };
    let result: ProcessResult;
    try {
      result = await runProcess(args, launchRoot, manifest.resources.timeoutMinutes * 60_000, receive, onProcess, {
        ...process.env,
        EVIDRA_MODAL_WORKSPACE: experimentWorkspace,
        ...(manifest.resources.gpu ? { EVIDRA_MODAL_GPU: manifest.resources.gpu } : {}),
        EVIDRA_MODAL_TIMEOUT_SECONDS: String(timeoutSeconds),
        EVIDRA_EXPERIMENT_ID: manifest.id,
      }, manifest.resources.earlyStopping);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { command: args, cwd: launchRoot, exitCode: 127, durationMs: 0, stdout: "", stderr: message };
    }
    const payload = parseModalWorkerResult(result.stdout);
    // A printed envelope cannot override the controller's timeout/interruption
    // or prove remote completion when the runtime client failed.
    if (result.exitCode !== 0 || !payload || !callId) {
      return { ...toRunResult(manifest, { ...result, command, cwd, exitCode: result.exitCode === 0 ? 65 : result.exitCode, stdout: "", stderr: boundProcessOutput([result.stderr, "Modal worker completion is unconfirmed; reconcile before replay."].filter(Boolean).join("\n")) }, metricName, true), stdout: result.stdout, artifacts: {}, failureClass: "unknown" };
    }
    observe("terminal", { callId, completionEvidence: "client-envelope", state: "COMPLETED", exitCode: payload.exitCode });
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

export function executorFor(kind: ExperimentManifest["resources"]["executor"], workspaceRoot?: string, onRemoteExecution?: RemoteExecutionObserver): ExperimentExecutor {
  if (kind === "modal") return new ModalExecutor(workspaceRoot, onRemoteExecution);
  if (kind === "container") return new ContainerExecutor(workspaceRoot, onRemoteExecution);
  if (kind === "slurm") return new SlurmExecutor(workspaceRoot, onRemoteExecution);
  return new LocalExecutor();
}
