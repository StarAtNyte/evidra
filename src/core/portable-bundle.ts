import { relative } from "node:path";
import { redactStructured } from "./redaction.js";
import { PhaseGoalSchema } from "./types.js";
import type { ResearchStore } from "./store.js";

export const PORTABLE_BUNDLE_TYPE = "evidra.research.bundle";
export const PORTABLE_BUNDLE_SCHEMA_VERSION = 1;

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
    events: store.recentEvents(512),
    limitations: [
      "This bundle contains metadata, evidence references, and recent events; it does not copy datasets, source files, model weights, or artifact contents.",
      "Re-validate all claims and rerun evaluators after importing the bundle into another workspace.",
    ],
  }) as Record<string, unknown>;
}
