import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ProcessResult } from "./types.js";
import { sha256File } from "./evidence.js";
import type { ResearchStore } from "./store.js";
import { redactCommand, redactSecrets } from "./redaction.js";

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
  metrics: Record<string, number> = {},
  metricsByFold: Record<string, number[]> = {},
): BaselineEvidence {
  const runId = `baseline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const artifactDir = join(root, ".sota", "artifacts", runId);
  mkdirSync(artifactDir, { recursive: true });
  const artifactContents: Record<string, string> = {
    "stdout.log": redactSecrets(result.stdout),
    "stderr.log": redactSecrets(result.stderr),
    "metrics.json": `${JSON.stringify({ metric, metrics, metricsByFold }, null, 2)}\n`,
    "provenance.json": `${JSON.stringify({ runId, command: redactCommand(result.command), cwd: result.cwd, exitCode: result.exitCode, durationMs: result.durationMs, recordedAt: new Date().toISOString() }, null, 2)}\n`,
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
    command: redactCommand(result.command),
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
  // Baselines are first-class durable evidence, not only an event payload.
  // This gives director hypotheses a stable provenance source to cite.
  store.saveSource({
    id: runId,
    payload: {
      id: runId,
      title: "Evidra canonical baseline",
      url: `https://evidra.local/baseline/${runId}`,
      retrievedAt: new Date().toISOString(),
      contentHash: runId,
      evidenceClass: "implementation",
      claims: [metric === null ? "Baseline completed without a finite primary metric." : `Baseline primary metric: ${metric}`],
    },
  });
  store.appendEvent(result.exitCode === 0 ? "baseline.completed" : "baseline.failed", evidence);
  return evidence;
}

/** Re-anchor an earlier successful baseline into a new campaign only if its stored artifacts still match. */
export function recordBaselineReuse(
  store: ResearchStore,
  root: string,
  prior: Partial<BaselineEvidence>,
  campaignStartedAt: string,
): boolean {
  if (prior.exitCode !== 0 || typeof prior.runId !== "string" || !prior.runId.trim()
    || typeof prior.metric !== "number" || !Number.isFinite(prior.metric)) return false;
  const paths = prior.artifactPaths;
  const checksums = prior.artifactChecksums;
  if (!paths || !checksums || !Object.keys(checksums).length) return false;
  const artifactRoot = resolve(root, ".sota", "artifacts");
  let canonicalRoot: string;
  try { canonicalRoot = realpathSync(artifactRoot); } catch { return false; }
  for (const [name, checksum] of Object.entries(checksums)) {
    const path = paths[name];
    if (typeof path !== "string" || typeof checksum !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(checksum)) return false;
    const resolvedPath = resolve(path);
    const pathFromRoot = relative(artifactRoot, resolvedPath);
    if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) return false;
    try {
      if (lstatSync(resolvedPath).isSymbolicLink() || !lstatSync(resolvedPath).isFile()) return false;
      const canonicalPath = realpathSync(resolvedPath);
      const canonicalRelative = relative(canonicalRoot, canonicalPath);
      if (!canonicalRelative || canonicalRelative.startsWith("..") || isAbsolute(canonicalRelative) || sha256File(canonicalPath) !== checksum) return false;
    } catch { return false; }
  }
  store.appendEvent("baseline.reused", {
    sourceRunId: prior.runId,
    campaignStartedAt,
    command: prior.command ?? [],
    cwd: prior.cwd ?? root,
    exitCode: 0,
    durationMs: prior.durationMs ?? 0,
    metric: prior.metric,
    metrics: prior.metrics ?? {},
    metricsByFold: prior.metricsByFold ?? {},
    artifactPaths: paths,
    artifactChecksums: checksums,
    verifiedAt: new Date().toISOString(),
  });
  return true;
}
