import { validateRunMetrics, type ExperimentExecutor } from "./executors.js";
import type { ExperimentManifest, RunResult } from "./types.js";
import type { ProcessControl } from "./process.js";

/** Run an optional cheap validation command without requiring final-run artifacts. */
export function runReducedValidation(
  executor: ExperimentExecutor,
  manifest: ExperimentManifest,
  cwd: string,
  command: string[],
  metricName: string,
  onProcess?: (control: ProcessControl) => void,
): Promise<RunResult> {
  const reducedManifest: ExperimentManifest = {
    ...manifest,
    evaluation: { ...manifest.evaluation, requiredArtifacts: [] },
  };
  return executor.run(reducedManifest, cwd, command, onProcess, metricName).then((result) =>
    !manifest.outcomeType || manifest.outcomeType === "metric" ? validateRunMetrics(result, [metricName, ...(manifest.evaluation.metrics ?? []).map((objective) => objective.name)]) : result,
  );
}
