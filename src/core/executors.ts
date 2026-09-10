import { runProcess, type ProcessControl } from "./process.js";
import { existsSync, lstatSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExperimentManifest, ProcessResult, RunResult } from "./types.js";

export interface ExperimentExecutor {
  readonly kind: "local" | "container" | "modal";
  run(manifest: ExperimentManifest, cwd: string, command: string[], onProcess?: (control: ProcessControl) => void, metricName?: string): Promise<RunResult>;
}

function failureClass(result: ProcessResult, remote = false): RunResult["failureClass"] {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (/out of memory|cuda oom|cuda.*memory/.test(text)) return "cuda_oom";
  if (/nan|inf loss/.test(text)) return "nan_loss";
  if (/timed out|timeout/.test(text)) return "timeout";
  if (/no such file|file not found|missing data/.test(text)) return "data_missing";
  if (/modul enotfound|cannot import|dependency/.test(text)) return "dependency";
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
  const destination = resolve(root, name);
  const destinationRelative = relative(root, destination);
  if (destinationRelative.startsWith("..") || isAbsolute(destinationRelative) || name.length === 0) return undefined;
  // Do not follow an existing symlink when importing a worker artifact.
  try { if (lstatSync(destination).isSymbolicLink()) return undefined; } catch { /* destination does not exist yet */ }
  return destination;
}

export function parseMetricOutput(stdout: string, metricName: string): { metrics: Record<string, number>; metricsByFold: Record<string, number[]> } {
  const metrics: Record<string, number> = {};
  const metricsByFold: Record<string, number[]> = {};
  const addObject = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const object = value as Record<string, unknown>;
    const nested = object.metrics;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) addObject(nested);
    const primary = object[metricName];
    if (typeof primary === "number" && Number.isFinite(primary)) metrics[metricName] = primary;
    const byFold = object.metricsByFold ?? object.byFold;
    if (byFold && typeof byFold === "object" && !Array.isArray(byFold)) {
      const series = (byFold as Record<string, unknown>)[metricName];
      if (Array.isArray(series)) metricsByFold[metricName] = series.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
    }
  };
  try { addObject(JSON.parse(stdout)); } catch { /* output may be a log stream */ }
  for (const line of stdout.split("\n")) {
    try { addObject(JSON.parse(line)); } catch { /* non-JSON log line */ }
    const keyed = line.match(new RegExp(`(?:^|\\s)${metricName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`, "i"));
    if (keyed) {
      const value = Number(keyed[1]);
      if (Number.isFinite(value)) metrics[metricName] = value;
    }
    const columns = line.split("|").map((column) => column.trim());
    if (columns.length >= 5 && /^\d[\d,]*$/.test(columns[0])) {
      const value = Number(columns[columns.length - 1]);
      if (Number.isFinite(value)) metrics[metricName] = value;
    }
  }
  return { metrics, metricsByFold };
}

function toRunResult(manifest: ExperimentManifest, result: ProcessResult, metricName: string, remote = false): RunResult {
  const parsed = parseMetricOutput(result.stdout, metricName);
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
    metrics: parsed.metrics,
    metricsByFold: parsed.metricsByFold,
    artifacts,
    stdout: result.stdout,
    stderr,
    command: result.command,
    cwd: result.cwd,
    ...(artifactFailure ? { failureClass: "corrupt_artifact" as const } : result.exitCode === 0 ? {} : { failureClass: failureClass(result, remote) }),
  };
}

export class LocalExecutor implements ExperimentExecutor {
  readonly kind = "local" as const;

  async run(manifest: ExperimentManifest, cwd: string, command: string[], onProcess?: (control: ProcessControl) => void, metricName = "final_layer_mse"): Promise<RunResult> {
    return toRunResult(manifest, await runProcess(command, cwd, manifest.resources.timeoutMinutes * 60_000, undefined, onProcess), metricName);
  }
}

export function containerCommand(runtime: "docker" | "podman", image: string, cwd: string, command: string[]): string[] {
  const args = [runtime, "run", "--rm", "--init", "--network", "none", "--volume", `${cwd}:/workspace:rw`, "--workdir", "/workspace"];
  if (typeof process.getuid === "function" && typeof process.getgid === "function") args.push("--user", `${process.getuid()}:${process.getgid()}`);
  return [...args, image, ...command];
}

export class ContainerExecutor implements ExperimentExecutor {
  readonly kind = "container" as const;

  constructor(private readonly workspaceRoot?: string) {}

  async run(manifest: ExperimentManifest, cwd: string, command: string[], onProcess?: (control: ProcessControl) => void, metricName = "final_layer_mse"): Promise<RunResult> {
    const requestedRuntime = process.env.EVIDRA_CONTAINER_RUNTIME;
    const candidates: Array<"docker" | "podman"> = requestedRuntime === "podman" ? ["podman"] : requestedRuntime === "docker" ? ["docker"] : ["docker", "podman"];
    const launchRoot = resolve(this.workspaceRoot ?? cwd);
    let runtime: "docker" | "podman" | undefined;
    for (const candidate of candidates) {
      const available = await runProcess(["which", candidate], launchRoot, 5_000);
      if (available.exitCode === 0) { runtime = candidate; break; }
    }
    const image = manifest.resources.image ?? process.env.EVIDRA_CONTAINER_IMAGE ?? "python:3.11-slim";
    if (!runtime) {
      return toRunResult(manifest, { command, cwd, exitCode: 127, durationMs: 0, stdout: "", stderr: "No Docker or Podman runtime was found. Install one or select the local executor." }, metricName);
    }
    const result = await runProcess(containerCommand(runtime, image, resolve(cwd), command), launchRoot, manifest.resources.timeoutMinutes * 60_000, undefined, onProcess);
    return toRunResult(manifest, { ...result, command, cwd }, metricName);
  }
}

export class ModalExecutor implements ExperimentExecutor {
  readonly kind = "modal" as const;

  constructor(private readonly workspaceRoot?: string) {}

  async run(manifest: ExperimentManifest, cwd: string, command: string[], onProcess?: (control: ProcessControl) => void, metricName = "final_layer_mse"): Promise<RunResult> {
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
    });
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
