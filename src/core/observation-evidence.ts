import { createHash, randomUUID } from "node:crypto";

export interface WorkspaceObservationEvidence {
  sourceId: string;
  sourcePayload: Record<string, unknown>;
  claimPayload: Record<string, unknown>;
  contentHash: string;
}

/** Convert a runtime workspace snapshot into linked, content-addressed evidence. */
export function workspaceObservationEvidence(
  observation: Record<string, unknown>,
  options: { sourceId?: string; retrievedAt?: string } = {},
): WorkspaceObservationEvidence {
  const sourceId = options.sourceId ?? `observation_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const serialized = JSON.stringify(observation);
  const contentHash = createHash("sha256").update(serialized).digest("hex");
  const gitStatus = Array.isArray(observation.gitStatus) ? observation.gitStatus.length : 0;
  const repositoryFiles = Array.isArray(observation.repositoryFiles) ? observation.repositoryFiles.length : 0;
  const claims = [`Workspace inventory recorded ${repositoryFiles} file path(s) and ${gitStatus} git-status entr${gitStatus === 1 ? "y" : "ies"}.`];
  const audit = observation.dataAudit && typeof observation.dataAudit === "object" ? observation.dataAudit as Record<string, unknown> : undefined;
  if (audit) claims.push(`Data audit scanned ${Number(audit.scannedFiles) || 0} file(s), found ${Number(audit.duplicateGroups) || 0} duplicate group(s), and recorded ${Array.isArray(audit.warnings) ? audit.warnings.length : 0} warning(s).`);
  const baseline = observation.baseline && typeof observation.baseline === "object" ? observation.baseline as Record<string, unknown> : undefined;
  if (baseline) claims.push(`Canonical baseline process exited ${String(baseline.exitCode)}; duration ${String(baseline.durationMs)} ms.`);
  return {
    sourceId,
    contentHash,
    sourcePayload: {
      id: sourceId,
      title: "Evidra content-addressed workspace observation",
      url: `https://evidra.local/observation/${sourceId}`,
      retrievedAt: options.retrievedAt ?? new Date().toISOString(),
      contentHash,
      evidenceClass: "implementation",
      claims,
      text: serialized,
    },
    claimPayload: {
      statement: claims.join(" "),
      scope: "current-workspace",
      confidence: 1,
      sourceType: "observation",
      sourceId,
      status: "active",
      observation,
    },
  };
}
