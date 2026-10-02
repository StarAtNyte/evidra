import { createHash } from "node:crypto";
import { createReadStream, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { responseSubmissionId } from "./submission-adapters.js";

type ScoreSubmission = { id: string; experimentId: string; status: string; payload: unknown; path?: string; bundleValid?: boolean };
type ScoreEvent = { type: string; payload: unknown };

const MAX_PROVENANCE_BYTES = 128 * 1024;

export interface ExternalArtifactReference {
  path: string;
  sha256: string;
  sizeBytes: number;
}

/** Hash a regular workspace artifact without loading it into memory or following it outside the workspace. */
export async function hashExternalArtifact(workspaceRoot: string, artifactPath: string): Promise<ExternalArtifactReference> {
  const root = realpathSync(workspaceRoot);
  const candidate = resolve(root, artifactPath);
  const lexicalPath = relative(root, candidate);
  if (!lexicalPath || lexicalPath === ".." || lexicalPath.startsWith(`..${sep}`) || isAbsolute(lexicalPath)) {
    throw new Error("External artifact must resolve to a file inside the workspace.");
  }
  const absolute = realpathSync(candidate);
  const relativePath = relative(root, absolute);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("External artifact must resolve to a file inside the workspace.");
  }
  const metadata = statSync(absolute);
  if (!metadata.isFile()) throw new Error("External artifact must be a regular file.");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(absolute)) digest.update(chunk);
  return { path: relativePath.split(sep).join("/"), sha256: digest.digest("hex"), sizeBytes: metadata.size };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function shortText(value: unknown, max = 160): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

/** Read only bounded, allow-listed provenance fields; never forward arbitrary bundle content to a model. */
function bundleProvenance(path: string | undefined): Record<string, unknown> | undefined {
  if (!path) return undefined;
  try {
    const provenancePath = join(path, "provenance.json");
    const size = statSync(provenancePath).size;
    if (size <= 0 || size > MAX_PROVENANCE_BYTES) return undefined;
    const raw = readFileSync(provenancePath);
    const provenance = record(JSON.parse(raw.toString("utf8")));
    const manifest = record(provenance?.manifest);
    const run = record(provenance?.run);
    if (!manifest && !run) return undefined;
    const evaluation = record(manifest?.evaluation);
    const metrics = Array.isArray(evaluation?.metrics)
      ? evaluation.metrics.slice(0, 32).flatMap((item) => {
        const metric = record(item);
        const name = shortText(metric?.name, 100);
        const direction = metric?.direction;
        return name ? [{ name, ...(direction === "minimize" || direction === "maximize" ? { direction } : {}) }] : [];
      })
      : undefined;
    const runMetrics = record(run?.metrics);
    const safeMetrics: Record<string, number | string | boolean> = {};
    if (runMetrics) {
      for (const [key, value] of Object.entries(runMetrics).slice(0, 64)) {
        if (!/^[\w.-]{1,100}$/.test(key)) continue;
        if (typeof value === "number" && Number.isFinite(value)) safeMetrics[key] = value;
        else if (typeof value === "string") safeMetrics[key] = value.slice(0, 120);
        else if (typeof value === "boolean") safeMetrics[key] = value;
      }
    }
    return {
      provenanceSha256: createHash("sha256").update(raw).digest("hex"),
      ...(shortText(manifest?.id) ? { manifestId: shortText(manifest?.id) } : {}),
      ...(shortText(manifest?.gitCommit, 80) ? { codeRevision: shortText(manifest?.gitCommit, 80) } : {}),
      ...(shortText(manifest?.datasetVersion, 120) ? { datasetVersion: shortText(manifest?.datasetVersion, 120) } : {}),
      ...(shortText(manifest?.splitVersion, 180) ? { splitVersion: shortText(manifest?.splitVersion, 180) } : {}),
      ...(metrics?.length ? { declaredMetrics: metrics } : {}),
      ...(shortText(run?.runId, 180) ? { evaluatedRunId: shortText(run?.runId, 180) } : {}),
      ...(shortText(run?.status, 40) ? { evaluatedRunStatus: shortText(run?.status, 40) } : {}),
      ...(Object.keys(safeMetrics).length ? { evaluatedMetrics: safeMetrics } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Build compact, provenance-linked feedback for agents from heterogeneous external score events. */
export function externalScoreEvidenceContext(submissions: ScoreSubmission[], events: ScoreEvent[], limit = 8): string[] {
  const latestById = new Map<string, { type: string; payload: Record<string, unknown> }>();
  for (const event of events) {
    const payload = record(event.payload);
    if (!payload || typeof payload.score !== "number" || !Number.isFinite(payload.score)) continue;
    const id = shortText(payload.id) ?? shortText(payload.externalId);
    if (id) latestById.set(id, { type: event.type, payload });
  }
  const rows = [...latestById.entries()].slice(-Math.max(1, Math.min(32, Math.floor(limit))));
  return rows.map(([externalId, event]) => {
    const submission = submissions.find((candidate) => candidate.id === externalId);
    const submissionPayload = record(submission?.payload);
    const receipt = record(submissionPayload?.receipt);
    const providerId = shortText(receipt?.submissionId) ?? (typeof receipt?.stdout === "string" ? responseSubmissionId(receipt.stdout) : undefined);
    const validation = record(submissionPayload?.validationScores);
    const artifactRecord = record(event.payload.artifact);
    const artifactPath = shortText(artifactRecord?.path, 300);
    const artifactSha256 = typeof artifactRecord?.sha256 === "string" && /^[a-f\d]{64}$/i.test(artifactRecord.sha256) ? artifactRecord.sha256.toLowerCase() : undefined;
    const artifactSize = typeof artifactRecord?.sizeBytes === "number" && Number.isSafeInteger(artifactRecord.sizeBytes) && artifactRecord.sizeBytes >= 0 ? artifactRecord.sizeBytes : undefined;
    const sourceUrl = shortText(event.payload.sourceUrl, 1_000);
    const validationScores = validation
      ? Object.fromEntries(Object.entries(validation).filter(([, value]) => typeof value === "number" && Number.isFinite(value)))
      : undefined;
    const provenance = bundleProvenance(submission?.path);
    return JSON.stringify({
      event: event.type,
      externalId,
      platform: shortText(event.payload.platform, 80) ?? shortText(submissionPayload?.platform, 80),
      evidenceLevel: submission?.bundleValid === true
        ? "registered_valid_bundle"
        : sourceUrl ? "source_linked_external_observation" : "operator_reported_external_observation",
      ...(event.type === "submission.score.observed" && event.payload.observationSource === "adapter_response"
        ? { scoreObservation: "platform_adapter_response" }
        : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      score: event.payload.score,
      ...(typeof event.payload.rank === "number" && Number.isFinite(event.payload.rank) ? { rank: event.payload.rank } : {}),
      ...(shortText(event.payload.recordedAt, 80) || shortText(event.payload.observedAt, 80) ? { observedAt: shortText(event.payload.recordedAt, 80) ?? shortText(event.payload.observedAt, 80) } : {}),
      ...(artifactPath && artifactSha256 && artifactSize !== undefined ? { externalArtifact: { path: artifactPath, sha256: artifactSha256, sizeBytes: artifactSize } } : {}),
      ...(submission ? {
        registeredBundle: submission.id,
        bundleValid: submission.bundleValid === true,
        experimentId: submission.experimentId,
        runId: shortText(submissionPayload?.runId, 180),
        bundleStatus: submission.status,
        providerSubmissionId: providerId,
        ...(validationScores && Object.keys(validationScores).length ? { validationScores } : {}),
        ...(provenance ? { provenance } : {}),
      } : {
        ...(shortText(event.payload.experimentId, 180) ? { experimentId: shortText(event.payload.experimentId, 180) } : {}),
        ...(validationScores && Object.keys(validationScores).length ? { validationScores } : {}),
        registeredBundle: false,
      }),
    });
  });
}
