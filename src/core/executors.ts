import { runProcess, type ProcessControl } from "./process.js";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExperimentManifest, ProcessResult, RunResult } from "./types.js";

export interface ExperimentExecutor {
  readonly kind: "local" | "modal";
  run(manifest: ExperimentManifest, cwd: string, command: string[], onProcess?: (control: ProcessControl) => void, metricName?: string): Promise<RunResult>;
}

function failureClass(result: ProcessResult): RunResult["failureClass"] {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (/out of memory|cuda oom|cuda.*memory/.test(text)) return "cuda_oom";
  if (/nan|inf loss/.test(text)) return "nan_loss";
  if (/timed out|timeout/.test(text)) return "timeout";
  if (/no such file|file not found|missing data/.test(text)) return "data_missing";
  if (/modul enotfound|cannot import|dependency/.test(text)) return "dependency";
  if (/rate limit|429|usage limit/.test(text)) return "rate_limit";
  if (/auth|unauthorized|forbidden/.test(text)) return "auth";
  return "unknown";
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

function toRunResult(manifest: ExperimentManifest, result: ProcessResult, metricName: string): RunResult {
  const parsed = parseMetricOutput(result.stdout, metricName);
  const artifacts: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of manifest.evaluation?.requiredArtifacts ?? []) {
    const path = resolve(result.cwd, name);
    const rel = relative(result.cwd, path);
    if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(path) || !statSync(path).isFile()) {
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
    ...(artifactFailure ? { failureClass: "corrupt_artifact" as const } : result.exitCode === 0 ? {} : { failureClass: failureClass(result) }),
  };
}

export class LocalExecutor implements ExperimentExecutor {
  readonly kind = "local" as const;

  async run(manifest: ExperimentManifest, cwd: string, command: string[], onProcess?: (control: ProcessControl) => void, metricName = "final_layer_mse"): Promise<RunResult> {
    return toRunResult(manifest, await runProcess(command, cwd, manifest.resources.timeoutMinutes * 60_000, undefined, onProcess), metricName);
  }
}

export class ModalExecutor implements ExperimentExecutor {
  readonly kind = "modal" as const;

  constructor(private readonly workspaceRoot?: string) {}

  async run(manifest: ExperimentManifest, cwd: string, command: string[], onProcess?: (control: ProcessControl) => void, metricName = "final_layer_mse"): Promise<RunResult> {
    if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
      throw new Error("Modal is not configured. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET, or choose local execution.");
    }
    const workspaceRoot = resolve(this.workspaceRoot ?? cwd);
    const relativeCwd = relative(workspaceRoot, resolve(cwd));
    if (relativeCwd.startsWith("..") || isAbsolute(relativeCwd)) throw new Error("Modal experiment cwd must stay inside the project workspace.");
    const modalEntrypoint = process.env.EVIDRA_MODAL_ENTRYPOINT ?? "modal_app.py::run";
    const timeoutSeconds = Math.max(60, Math.round(manifest.resources.timeoutMinutes * 60));
    const commandJson = JSON.stringify(command);
    const args = ["run", modalEntrypoint, "--", "--command-json", commandJson, "--cwd", relativeCwd || ".", "--artifacts-json", JSON.stringify(manifest.evaluation?.requiredArtifacts ?? []), "--timeout-seconds", String(timeoutSeconds)];
    const result = await runProcess(args, workspaceRoot, manifest.resources.timeoutMinutes * 60_000, undefined, onProcess, {
      ...process.env,
      EVIDRA_MODAL_WORKSPACE: workspaceRoot,
      ...(manifest.resources.gpu ? { EVIDRA_MODAL_GPU: manifest.resources.gpu } : {}),
      EVIDRA_MODAL_TIMEOUT_SECONDS: String(timeoutSeconds),
    });
    let payload: { exitCode?: number; stdout?: string; stderr?: string; artifacts?: Record<string, string> } | undefined;
    for (const line of result.stdout.trim().split("\n").reverse()) {
      try {
        const candidate = JSON.parse(line) as typeof payload;
        if (candidate && typeof candidate === "object" && (typeof candidate.exitCode === "number" || candidate.artifacts)) { payload = candidate; break; }
      } catch { /* Modal progress output is not the worker result. */ }
    }
    if (!payload) return toRunResult(manifest, { ...result, command, cwd }, metricName);
    for (const [name, encoded] of Object.entries(payload.artifacts ?? {})) {
      const destination = resolve(cwd, name);
      const destinationRelative = relative(cwd, destination);
      if (destinationRelative.startsWith("..") || isAbsolute(destinationRelative)) continue;
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, Buffer.from(encoded, "base64"));
    }
    return toRunResult(manifest, { ...result, command, exitCode: payload.exitCode ?? result.exitCode, stdout: payload.stdout ?? result.stdout, stderr: payload.stderr ?? result.stderr, cwd }, metricName);
  }
}

export function executorFor(kind: ExperimentManifest["resources"]["executor"], workspaceRoot?: string): ExperimentExecutor {
  return kind === "modal" ? new ModalExecutor(workspaceRoot) : new LocalExecutor();
}
