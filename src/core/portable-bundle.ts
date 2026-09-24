import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isSensitiveWorkspacePath, redactStructured, redactSecrets } from "./redaction.js";
import { PhaseGoalSchema } from "./types.js";
import type { ResearchStore } from "./store.js";

export const PORTABLE_BUNDLE_TYPE = "evidra.research.bundle";
export const PORTABLE_BUNDLE_SCHEMA_VERSION = 1;

export type PortableBundleValidation = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  counts: Record<string, number>;
};

/**
 * Build a secret-redacted, metadata-only snapshot that can travel with a
 * research project. Artifact contents stay in the workspace; their checksums
 * and relative paths make missing files explicit on the receiving machine.
 */
export function createPortableBundle(store: ResearchStore, root: string): Record<string, unknown> {
  const goals = store.phaseGoals().flatMap((entry) => {
    const parsed = PhaseGoalSchema.safeParse(entry.payload);
    return parsed.success ? [parsed.data] : [];
  });
  return redactStructured({
    type: PORTABLE_BUNDLE_TYPE,
    schemaVersion: PORTABLE_BUNDLE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    project: store.project() ?? null,
    campaign: store.campaign() ?? null,
    scheduler: store.schedulerState(),
    counts: store.counts(),
    integrity: store.verifyEventChain(),
    phaseGoals: goals,
    hypotheses: store.hypotheses(),
    decisions: store.decisions(),
    claims: store.claims(),
    sources: store.sources(),
    experiments: store.experiments(),
    runs: store.runs(),
    artifacts: store.artifacts().map((artifact) => ({ ...artifact, path: relative(root, artifact.path) })),
    queue: store.queueTasks(),
    routines: store.routines(),
    agentLanes: store.agentLanes(),
    agentControls: store.agentPauses(),
    agentSessions: store.agentSessions(),
    agentDirectives: store.agentDirectives(),
    events: store.recentEvents(512),
    limitations: [
      "This bundle contains metadata, evidence references, and recent events; it does not copy datasets, source files, model weights, or artifact contents.",
      "Re-validate all claims and rerun evaluators after importing the bundle into another workspace.",
    ],
  }) as Record<string, unknown>;
}

/** Validate an exported bundle without importing any claims into live state. */
export function validatePortableBundle(value: unknown, root: string): PortableBundleValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!object) return { valid: false, errors: ["bundle must be a JSON object"], warnings, counts: {} };
  if (object.type !== PORTABLE_BUNDLE_TYPE) errors.push(`unsupported bundle type: ${String(object.type ?? "missing")}`);
  if (object.schemaVersion !== PORTABLE_BUNDLE_SCHEMA_VERSION) errors.push(`unsupported schema version: ${String(object.schemaVersion ?? "missing")}`);
  if (!object.exportedAt || typeof object.exportedAt !== "string" || !Number.isFinite(Date.parse(object.exportedAt))) errors.push("exportedAt must be an ISO timestamp");
  for (const field of ["phaseGoals", "hypotheses", "decisions", "claims", "sources", "experiments", "runs", "artifacts", "queue", "routines", "agentLanes", "events"]) {
    if (!Array.isArray(object[field])) errors.push(`${field} must be an array`);
  }
  for (const field of ["agentControls", "agentSessions", "agentDirectives"] as const) {
    if (object[field] !== undefined && !Array.isArray(object[field])) errors.push(`${field} must be an array when present`);
  }
  const artifacts = Array.isArray(object.artifacts) ? object.artifacts : [];
  for (const entry of artifacts) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { errors.push("artifact entry must be an object"); continue; }
    const path = (entry as Record<string, unknown>).path;
    if (typeof path !== "string" || !path.trim()) { errors.push("artifact path is missing"); continue; }
    const normalized = path.replace(/\\/g, "/");
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) errors.push(`artifact path escapes workspace: ${path}`);
    if (isSensitiveWorkspacePath(normalized)) warnings.push(`sensitive-looking artifact path omitted from trust: ${path}`);
    if (normalized && !normalized.startsWith(".sota/") && !normalized.startsWith(".sota\\")) {
      // Missing artifacts are warnings because a metadata-only bundle is
      // intentionally portable without copying data or generated files.
      if (!existsSync(resolve(root, normalized))) warnings.push(`artifact is not present: ${path}`);
    }
  }
  const serialized = JSON.stringify(object);
  if (redactSecrets(serialized) !== serialized) errors.push("bundle contains an unredacted credential-like value");
  const counts = Object.fromEntries(["phaseGoals", "hypotheses", "decisions", "claims", "sources", "experiments", "runs", "artifacts", "queue", "routines", "agentLanes", "events"].map((field) => [field, Array.isArray(object[field]) ? (object[field] as unknown[]).length : 0]));
  return { valid: errors.length === 0, errors, warnings: [...new Set(warnings)], counts };
}
