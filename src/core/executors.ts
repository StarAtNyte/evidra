import { runProcess, type ProcessControl } from "./process.js";
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

function parseMetricOutput(stdout: string, metricName: string): { metrics: Record<string, number>; metricsByFold: Record<string, number[]> } {
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
  return {
    runId: `${manifest.id}-${Date.now()}`,
    status: result.exitCode === 0 ? "completed" : "failed",
    exitCode: result.exitCode,
    durationSeconds: result.durationMs / 1000,
    metrics: parsed.metrics,
    metricsByFold: parsed.metricsByFold,
    artifacts: {},
    stdout: result.stdout,
    stderr: result.stderr,
    command: result.command,
    cwd: result.cwd,
    ...(result.exitCode === 0 ? {} : { failureClass: failureClass(result) }),
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

  async run(manifest: ExperimentManifest, cwd: string, command: string[], onProcess?: (control: ProcessControl) => void, metricName = "final_layer_mse"): Promise<RunResult> {
    if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
      throw new Error("Modal is not configured. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET, or choose local execution.");
    }
    const modalEntrypoint = process.env.EVIDRA_MODAL_ENTRYPOINT ?? "modal_app.py::run";
    return toRunResult(manifest, await runProcess(["modal", "run", modalEntrypoint, "--", ...command], cwd, manifest.resources.timeoutMinutes * 60_000, undefined, onProcess), metricName);
  }
}

export function executorFor(kind: ExperimentManifest["resources"]["executor"]): ExperimentExecutor {
  return kind === "modal" ? new ModalExecutor() : new LocalExecutor();
}
