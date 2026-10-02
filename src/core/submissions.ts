import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CompetitionConfig, ExperimentManifest, RunResult } from "./types.js";
import { redactStructured } from "./redaction.js";

export interface SubmissionValidation {
  valid: boolean;
  bundlePath: string;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

/** Recover finite local validation metrics captured in a submission bundle. */
export function submissionValidationScores(bundlePath: string): Record<string, number> {
  const provenancePath = safeBundlePath(bundlePath, "provenance.json");
  if (!provenancePath) return {};
  try {
    const parsed = JSON.parse(readFileSync(provenancePath, "utf8")) as { run?: { metrics?: unknown } };
    const metrics = parsed.run?.metrics;
    if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return {};
    return Object.fromEntries(Object.entries(metrics).filter(([, value]) => typeof value === "number" && Number.isFinite(value)) as Array<[string, number]>);
  } catch { return {}; }
}

function checksum(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

export function safeBundlePath(bundlePath: string, name: string): string | undefined {
  let root: string;
  try { root = realpathSync(bundlePath); } catch { return undefined; }
  const candidate = resolve(root, name);
  const lexical = relative(root, candidate);
  if (!name || isAbsolute(lexical) || lexical.startsWith("..")) return undefined;
  try {
    const stats = lstatSync(candidate);
    if (stats.isSymbolicLink() || !stats.isFile()) return undefined;
  } catch { return undefined; }
  let ancestor = candidate;
  while (true) {
    try {
      const resolvedAncestor = realpathSync(ancestor);
      const resolvedRelative = relative(root, resolvedAncestor);
      return isAbsolute(resolvedRelative) || resolvedRelative.startsWith("..") ? undefined : candidate;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return undefined;
      ancestor = parent;
    }
  }
}

function safeWorkspaceFile(workspaceRoot: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath)) throw new Error(`Submission artifact path must be workspace-relative: ${relativePath}`);
  const root = realpathSync(resolve(workspaceRoot));
  const candidate = resolve(root, relativePath);
  const lexical = relative(root, candidate);
  if (lexical === "" || isAbsolute(lexical) || lexical === ".." || lexical.startsWith(`..${process.platform === "win32" ? "\\\\" : "/"}`)) {
    throw new Error(`Submission artifact path escapes its workspace: ${relativePath}`);
  }
  let current = root;
  for (const part of lexical.split(/[\\/]/)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Submission artifact path contains a symbolic link: ${relativePath}`);
  }
  const real = realpathSync(candidate);
  const resolvedRelative = relative(root, real);
  if (isAbsolute(resolvedRelative) || resolvedRelative === ".." || resolvedRelative.startsWith(`..${process.platform === "win32" ? "\\\\" : "/"}`) || !lstatSync(candidate).isFile()) {
    throw new Error(`Submission artifact path is not a regular workspace file: ${relativePath}`);
  }
  return candidate;
}

export function prepareSubmission(root: string, experimentId: string, manifest: ExperimentManifest, run: RunResult, competition: CompetitionConfig, sourceWorkspace?: string): { id: string; path: string } {
  if (run.status !== "completed" || run.exitCode !== 0) throw new Error(`Cannot prepare a submission from run ${run.runId}: run is not successfully completed.`);
  const id = `sub_${Date.now()}_${experimentId}`;
  const path = join(root, ".sota", "submissions", id);
  mkdirSync(path, { recursive: true });
  const copied: string[] = [];
  const sourceArtifacts: Array<{ path: string; bundlePath: string; sha256: string; sizeBytes: number }> = [];
  for (const [name, artifactPath] of Object.entries(run.artifacts)) {
    if (!existsSync(artifactPath)) continue;
    try { if (lstatSync(artifactPath).isSymbolicLink()) continue; } catch { continue; }
    if (!/submission|prediction/i.test(name)) continue;
    const destination = join(path, basename(artifactPath));
    copyFileSync(artifactPath, destination);
    copied.push(destination);
  }
  const submission = competition.submission ?? { platform: "manual" as const, source: "prediction" as const, artifactPaths: [] };
  if ((submission.artifactPaths?.length ?? 0) > 0) {
    if (!sourceWorkspace) throw new Error("Submission artifact snapshots require the producing experiment workspace.");
    for (const artifactPath of submission.artifactPaths ?? []) {
      const source = safeWorkspaceFile(sourceWorkspace, artifactPath);
      const destinationRelative = `source/${artifactPath.replaceAll("\\", "/")}`;
      const destination = join(path, destinationRelative);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      sourceArtifacts.push({ path: artifactPath, bundlePath: destinationRelative, sha256: checksum(destination), sizeBytes: statSync(destination).size });
    }
  }
  if (!copied.length && submission.source !== "workspace") throw new Error(`Run ${run.runId} has no submission or prediction artifact.`);
  const provenance = redactStructured({ schemaVersion: 1, submissionId: id, experimentId, competition: competition.id, submission, sourceArtifacts, manifest, run: { runId: run.runId, status: run.status, metrics: run.metrics, metricsByFold: run.metricsByFold, artifacts: run.artifacts }, createdAt: new Date().toISOString() });
  writeFileSync(join(path, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  writeFileSync(join(path, "model_card.md"), `# ${id}\n\nCompetition: ${competition.name}\nExperiment: ${experimentId}\nRun: ${run.runId}\n\nThis bundle was generated by Evidra. External submission remains approval-gated.\n`);
  writeFileSync(join(path, "UPLOAD_INSTRUCTIONS.md"), `# Manual upload\n\nValidate this bundle with Evidra before uploading. Do not provide credentials to research agents.\n\nPrediction artifacts copied: ${copied.length}\n`);
  const checksums = ["provenance.json", "model_card.md", "UPLOAD_INSTRUCTIONS.md", ...copied.map((file) => file.split(/[\\/]/).pop() ?? file), ...sourceArtifacts.map((artifact) => artifact.bundlePath)].map((name) => `${checksum(join(path, name))}  ${name}`).join("\n");
  writeFileSync(join(path, "checksums.sha256"), `${checksums}\n`);
  return { id, path };
}

export function validateSubmissionBundle(path: string): SubmissionValidation {
  const checks: SubmissionValidation["checks"] = [];
  const provenancePath = safeBundlePath(path, "provenance.json");
  const checksumPath = safeBundlePath(path, "checksums.sha256");
  checks.push({ name: "provenance", passed: Boolean(provenancePath), detail: provenancePath ? "provenance.json exists" : "provenance.json is missing or unsafe" });
  checks.push({ name: "checksums", passed: Boolean(checksumPath), detail: checksumPath ? "checksums.sha256 exists" : "checksums.sha256 is missing or unsafe" });
  let provenance: { submissionId?: unknown; experimentId?: unknown; submission?: { source?: unknown }; sourceArtifacts?: Array<{ path?: unknown; bundlePath?: unknown; sha256?: unknown; sizeBytes?: unknown }> } | undefined;
  if (provenancePath) {
    try { provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as { submissionId?: unknown; experimentId?: unknown }; }
    catch { /* reported as a failed provenance check below */ }
  }
  checks.push({ name: "provenance-schema", passed: typeof provenance?.submissionId === "string" && typeof provenance?.experimentId === "string", detail: typeof provenance?.submissionId === "string" && typeof provenance?.experimentId === "string" ? "submission and experiment identifiers exist" : "provenance.json is invalid or incomplete" });
  let predictionArtifact = false;
  if (checksumPath) {
    for (const line of readFileSync(checksumPath, "utf8").split("\n").map((value) => value.trim()).filter(Boolean)) {
      const separator = line.indexOf("  ");
      if (separator <= 0) { checks.push({ name: "checksum:format", passed: false, detail: "expected '<sha256>  <filename>'" }); continue; }
      const expected = line.slice(0, separator);
      const name = line.slice(separator + 2);
      const file = safeBundlePath(path, name);
      const passed = Boolean(file && existsSync(file) && checksum(file) === expected);
      if (file && /submission|prediction/i.test(name) && existsSync(file)) predictionArtifact = true;
      checks.push({ name: `checksum:${name}`, passed, detail: passed ? "matches" : "missing or changed" });
    }
  }
  const workspaceSource = provenance?.submission?.source === "workspace";
  checks.push({ name: "prediction-artifact", passed: predictionArtifact || workspaceSource, detail: predictionArtifact ? "submission or prediction artifact is present" : workspaceSource ? "workspace-source adapter will submit from the configured working directory" : "no submission or prediction artifact is present" });
  for (const [index, artifact] of (provenance?.sourceArtifacts ?? []).entries()) {
    const file = typeof artifact.bundlePath === "string" ? safeBundlePath(path, artifact.bundlePath) : undefined;
    const valid = Boolean(file && typeof artifact.sha256 === "string" && checksum(file) === artifact.sha256 && typeof artifact.sizeBytes === "number" && statSync(file).size === artifact.sizeBytes);
    checks.push({ name: `source-artifact:${index}`, passed: valid, detail: valid ? `${String(artifact.path)} snapshot matches its declared SHA-256 and size` : "source artifact snapshot is missing or changed" });
  }
  if (workspaceSource && provenance?.submission && "artifactPaths" in provenance.submission) {
    const required = (provenance.submission as { artifactPaths?: unknown }).artifactPaths;
    const declared = Array.isArray(required) ? required.filter((item): item is string => typeof item === "string") : [];
    const snapshotted = new Set((provenance.sourceArtifacts ?? []).map((artifact) => artifact.path).filter((item): item is string => typeof item === "string"));
    checks.push({ name: "source-artifact-coverage", passed: declared.every((item) => snapshotted.has(item)), detail: declared.every((item) => snapshotted.has(item)) ? `${declared.length} declared source artifact(s) are snapshotted` : "one or more declared source artifacts are not snapshotted" });
  }
  return { valid: checks.every((check) => check.passed), bundlePath: path, checks };
}
