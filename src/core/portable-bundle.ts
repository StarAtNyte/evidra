import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isSensitiveWorkspacePath, redactStructured, redactSecrets } from "./redaction.js";
import { PhaseGoalSchema } from "./types.js";
import type { PersistedAgentRoleContract, ResearchStore } from "./store.js";
import { loadExternalResearchTools, loadExternalToolState } from "./external-tools.js";

export const PORTABLE_BUNDLE_TYPE = "evidra.research.bundle";
export const PORTABLE_BUNDLE_SCHEMA_VERSION = 1;

export type PortableBundleValidation = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  counts: Record<string, number>;
};

export type PortableAgentContract = Omit<PersistedAgentRoleContract, "updatedAt">;

/** Extract only organization configuration; evidence and runtime state never enter this import path. */
export function portableAgentContracts(value: unknown): PortableAgentContract[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const entries = (value as Record<string, unknown>).agentContracts;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry): PortableAgentContract[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const contract = entry as Record<string, unknown>;
    const role = typeof contract.role === "string" ? contract.role.trim().slice(0, 160) : "";
    const responsibility = typeof contract.responsibility === "string" ? contract.responsibility.trim().slice(0, 1_000) : "";
    const authority = contract.authority;
    const playbook = Array.isArray(contract.playbook) ? [...new Set(contract.playbook.filter((step): step is string => typeof step === "string" && Boolean(step.trim())).map((step) => step.trim().slice(0, 300)))].slice(0, 16) : [];
    const toolAllowlist = contract.toolAllowlist === undefined ? undefined : Array.isArray(contract.toolAllowlist) ? [...new Set(contract.toolAllowlist.filter((tool): tool is string => typeof tool === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(tool.trim())).map((tool) => tool.trim().toLowerCase()))].slice(0, 32) : [];
    if (!role || !responsibility || !["coordinate", "investigate", "validate", "execute", "repair"].includes(String(authority)) || !playbook.length) return [];
    if (contract.toolAllowlist !== undefined && !toolAllowlist?.length) return [];
    return [{ role, parentRole: typeof contract.parentRole === "string" && contract.parentRole.trim() ? contract.parentRole.trim().slice(0, 160) : null, responsibility, authority: authority as PortableAgentContract["authority"], reviewRequired: true, playbook, ...(toolAllowlist ? { toolAllowlist } : {}) }];
  });
}

/**
 * Build a secret-redacted, metadata-only snapshot that can travel with a
 * research project. Artifact contents stay in the workspace; their checksums
 * and relative paths make missing files explicit on the receiving machine.
 */
export function createPortableBundle(store: ResearchStore, root: string): Record<string, unknown> {
  const externalManifest = loadExternalResearchTools(root);
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
    agentContracts: store.agentRoleContracts(),
    agentSessions: store.agentSessions(),
    agentDirectives: store.agentDirectives(),
    externalTools: externalManifest.tools,
    externalToolManifestHash: externalManifest.contentHash,
    externalToolState: loadExternalToolState(root),
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
  for (const field of ["agentControls", "agentContracts", "agentSessions", "agentDirectives"] as const) {
    if (object[field] !== undefined && !Array.isArray(object[field])) errors.push(`${field} must be an array when present`);
  }
  if (Array.isArray(object.agentContracts)) {
    for (const entry of object.agentContracts) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) { errors.push("agent contract entry must be an object"); continue; }
      const contract = entry as Record<string, unknown>;
      if (typeof contract.role !== "string" || !contract.role.trim()) errors.push("agent contract role is required");
      if (contract.parentRole !== null && contract.parentRole !== undefined && typeof contract.parentRole !== "string") errors.push(`agent contract ${String(contract.role ?? "unknown")} has an invalid parentRole`);
      if (typeof contract.responsibility !== "string" || !contract.responsibility.trim()) errors.push(`agent contract ${String(contract.role ?? "unknown")} is missing responsibility`);
      if (!["coordinate", "investigate", "validate", "execute", "repair"].includes(String(contract.authority))) errors.push(`agent contract ${String(contract.role ?? "unknown")} has an invalid authority`);
      if (!Array.isArray(contract.playbook) || contract.playbook.length === 0 || contract.playbook.some((step) => typeof step !== "string" || !step.trim())) errors.push(`agent contract ${String(contract.role ?? "unknown")} has an invalid playbook`);
      if (contract.toolAllowlist !== undefined && (!Array.isArray(contract.toolAllowlist) || contract.toolAllowlist.length === 0 || contract.toolAllowlist.length > 32 || contract.toolAllowlist.some((tool) => typeof tool !== "string" || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(tool.trim())))) errors.push(`agent contract ${String(contract.role ?? "unknown")} has an invalid tool allowlist`);
    }
  }
  if (object.externalTools !== undefined && !Array.isArray(object.externalTools)) errors.push("externalTools must be an array when present");
  if (object.externalToolState !== undefined && (!object.externalToolState || typeof object.externalToolState !== "object" || Array.isArray(object.externalToolState))) errors.push("externalToolState must be an object when present");
  if (object.externalToolManifestHash !== undefined && object.externalToolManifestHash !== null && (typeof object.externalToolManifestHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(object.externalToolManifestHash))) errors.push("externalToolManifestHash must be a SHA-256 fingerprint when present");
  if (Array.isArray(object.externalTools)) {
    for (const entry of object.externalTools) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) { errors.push("external tool entry must be an object"); continue; }
      const tool = entry as Record<string, unknown>;
      if (typeof tool.name !== "string" || !/^external\.[a-z0-9][a-z0-9._-]{1,78}$/.test(tool.name)) errors.push("external tool name is invalid");
      if (typeof tool.description !== "string" || !tool.description.trim()) errors.push(`external tool ${String(tool.name ?? "unknown")} is missing a description`);
      if (!Array.isArray(tool.command) || !tool.command.length || tool.command.length > 32 || !tool.command.every((part) => typeof part === "string" && part.length > 0 && part.length <= 400)) errors.push(`external tool ${String(tool.name ?? "unknown")} has an invalid argv command`);
    }
  }
  if (object.externalToolState && typeof object.externalToolState === "object" && !Array.isArray(object.externalToolState)) {
    for (const [name, entry] of Object.entries(object.externalToolState as Record<string, unknown>)) {
      if (!/^external\.[a-z0-9][a-z0-9._-]{1,78}$/.test(name) || !entry || typeof entry !== "object" || Array.isArray(entry) || !["enabled", "disabled", "quarantined"].includes((entry as Record<string, unknown>).status as string)) errors.push(`external tool state is invalid for ${name}`);
    }
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
