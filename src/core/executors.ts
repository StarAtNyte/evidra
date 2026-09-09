import { runProcess } from "./process.js";
import type { ExperimentManifest, ProcessResult, RunResult } from "./types.js";

export interface ExperimentExecutor {
  readonly kind: "local" | "modal";
  run(manifest: ExperimentManifest, cwd: string, command: string[]): Promise<RunResult>;
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

function toRunResult(manifest: ExperimentManifest, result: ProcessResult): RunResult {
  return {
    runId: `${manifest.id}-${Date.now()}`,
    status: result.exitCode === 0 ? "completed" : "failed",
    exitCode: result.exitCode,
    durationSeconds: result.durationMs / 1000,
    metrics: {},
    artifacts: {},
    ...(result.exitCode === 0 ? {} : { failureClass: failureClass(result) }),
  };
}

export class LocalExecutor implements ExperimentExecutor {
  readonly kind = "local" as const;

  async run(manifest: ExperimentManifest, cwd: string, command: string[]): Promise<RunResult> {
    return toRunResult(manifest, await runProcess(command, cwd, manifest.resources.timeoutMinutes * 60_000));
  }
}

export class ModalExecutor implements ExperimentExecutor {
  readonly kind = "modal" as const;

  async run(manifest: ExperimentManifest, cwd: string, command: string[]): Promise<RunResult> {
    if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
      throw new Error("Modal is not configured. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET, or choose local execution.");
    }
    const modalEntrypoint = process.env.EVIDRA_MODAL_ENTRYPOINT ?? "modal_app.py::run";
    return toRunResult(manifest, await runProcess(["modal", "run", modalEntrypoint, "--", ...command], cwd, manifest.resources.timeoutMinutes * 60_000));
  }
}

export function executorFor(kind: ExperimentManifest["resources"]["executor"]): ExperimentExecutor {
  return kind === "modal" ? new ModalExecutor() : new LocalExecutor();
}
