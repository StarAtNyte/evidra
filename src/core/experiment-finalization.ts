export interface AutonomousExecutionResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

/** Mark a non-zero autonomous run terminal so failed work cannot remain stranded as running. */
export function failedAutonomousExperimentPayload(
  payload: Record<string, unknown>,
  result: AutonomousExecutionResult,
  recordedAt = new Date().toISOString(),
): Record<string, unknown> | undefined {
  if (result.exitCode === 0) return undefined;
  const status = payload.status;
  if (status !== "proposed" && status !== "running") return undefined;
  return {
    ...payload,
    status: "failed",
    failure: {
      exitCode: result.exitCode,
      stdout: (result.stdout ?? "").slice(-4_000),
      stderr: (result.stderr ?? "").slice(-4_000),
      recordedAt,
      retryable: true,
    },
  };
}
