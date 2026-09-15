import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessResult } from "./types.js";
import { sha256File } from "./evidence.js";
import type { ResearchStore } from "./store.js";
import { redactSecrets } from "./redaction.js";

export interface BaselineEvidence {
  runId: string;
  command: string[];
  cwd: string;
  exitCode: number;
  durationMs: number;
  metric: number | null;
  /** Complete evaluator metric set, not only the configured primary metric. */
  metrics: Record<string, number>;
  metricsByFold: Record<string, number[]>;
  stdout: string;
  stderr: string;
  artifactPaths: Record<string, string>;
  artifactChecksums: Record<string, string>;
}

/** Persist a baseline as reproducible evidence, including failed-run diagnostics. */
export function recordBaselineEvidence(
  store: ResearchStore,
  root: string,
  result: ProcessResult,
  metric: number | null,
  metrics: Record<string, number> = metric === null ? {} : { primary: metric },
  metricsByFold: Record<string, number[]> = {},
): BaselineEvidence {
  const runId = `baseline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const artifactDir = join(root, ".sota", "artifacts", runId);
  mkdirSync(artifactDir, { recursive: true });
  const artifactContents: Record<string, string> = {
    "stdout.log": redactSecrets(result.stdout),
    "stderr.log": redactSecrets(result.stderr),
    "metrics.json": `${JSON.stringify({ metric, metrics, metricsByFold }, null, 2)}\n`,
    "provenance.json": `${JSON.stringify({ runId, command: result.command, cwd: result.cwd, exitCode: result.exitCode, durationMs: result.durationMs, recordedAt: new Date().toISOString() }, null, 2)}\n`,
  };
  const artifactPaths: Record<string, string> = {};
  const artifactChecksums: Record<string, string> = {};
  for (const [name, content] of Object.entries(artifactContents)) {
    const path = join(artifactDir, name);
    writeFileSync(path, content);
    artifactPaths[name] = path;
    artifactChecksums[name] = sha256File(path);
    store.saveArtifact({ id: `${runId}-${name}`, runId, name, path, checksum: artifactChecksums[name] });
  }
  const evidence: BaselineEvidence = {
    runId,
    command: result.command,
    cwd: result.cwd,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    metric,
    metrics,
    metricsByFold,
    stdout: redactSecrets(result.stdout),
    stderr: redactSecrets(result.stderr),
    artifactPaths,
    artifactChecksums,
  };
  store.appendEvent(result.exitCode === 0 ? "baseline.completed" : "baseline.failed", evidence);
  return evidence;
}
