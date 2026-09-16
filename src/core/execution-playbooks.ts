import { z } from "zod";
import type { ExperienceRecord } from "./experience.js";

/**
 * A deterministic execution recipe learned from a successful trajectory.
 * Scientific ideas and operational procedures are intentionally separate:
 * this record can improve reliability without becoming a claim about the
 * underlying method or silently changing a future evaluator.
 */
export interface ExecutionPlaybook {
  schemaVersion: 1;
  id: string;
  title: string;
  task: string;
  domain: string;
  trigger: string;
  steps: string[];
  environment: {
    executor?: string;
    provider?: string;
    model?: string;
    datasetVersion?: string;
    splitVersion?: string;
  };
  failureModes: string[];
  evidenceIds: string[];
  sourceTrajectoryId: string;
  status: "verified_procedure";
}

export const ExecutionPlaybookSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  title: z.string().min(1).max(300),
  task: z.string().min(1).max(120),
  domain: z.string().min(1).max(120),
  trigger: z.string().min(1).max(500),
  steps: z.array(z.string().min(1).max(500)).min(2).max(8),
  environment: z.object({
    executor: z.string().min(1).max(80).optional(),
    provider: z.string().min(1).max(80).optional(),
    model: z.string().min(1).max(160).optional(),
    datasetVersion: z.string().min(1).max(200).optional(),
    splitVersion: z.string().min(1).max(200).optional(),
  }),
  failureModes: z.array(z.string().min(1).max(500)).min(1).max(8),
  evidenceIds: z.array(z.string().min(1)).min(1).max(8),
  sourceTrajectoryId: z.string().min(1),
  status: z.literal("verified_procedure"),
});

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback: string, max = 500): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

/**
 * Derive a procedure only from a structurally passing experience. Failed or
 * replay-only trajectories remain negative/replay evidence and never become
 * an executable-looking recipe.
 */
export function executionPlaybookFromExperience(experience: ExperienceRecord): ExecutionPlaybook | undefined {
  if (experience.admission !== "candidate" || experience.outcome.status !== "success" || experience.quality.overall !== "PASS") return undefined;
  const manifest = object(experience.events.find((event) => object(event.payload).manifest)?.payload && object(experience.events.find((event) => object(event.payload).manifest)?.payload).manifest);
  const resources = object(manifest.resources);
  const evaluation = object(manifest.evaluation);
  const metrics = Array.isArray(evaluation.metrics)
    ? evaluation.metrics.flatMap((metric) => {
      const value = object(metric).name;
      return typeof value === "string" && value.trim() ? [value.trim()] : [];
    }).slice(0, 6)
    : [];
  const verificationCommands = [
    ...(Array.isArray(evaluation.verificationCommand) ? [evaluation.verificationCommand] : []),
    ...(Array.isArray(evaluation.verificationCommands) ? evaluation.verificationCommands : []),
  ].filter((command) => Array.isArray(command) && command.every((part) => typeof part === "string"));
  const executor = typeof resources.executor === "string" ? resources.executor : undefined;
  const steps = [
    `Use the immutable experiment manifest in an isolated ${executor ?? "declared"} executor.`,
    `Run the declared evaluation${metrics.length ? ` for ${metrics.join(", ")}` : ""}${Array.isArray(evaluation.folds) ? ` across ${evaluation.folds.length} fold(s)` : ""}${Array.isArray(evaluation.seeds) ? ` and ${evaluation.seeds.length} seed(s)` : ""}.`,
    "Persist bounded logs, metrics, environment metadata, and checksummed artifacts before interpreting the result.",
    ...(verificationCommands.length ? [`Run ${verificationCommands.length} declared verification command(s) before promotion.`] : ["Require the controller's evidence audit before promotion."]),
  ];
  const failures = [...new Set([
    ...experience.gaps,
    "the target task, data, split, or evaluator may differ from the source procedure",
    "a successful procedure does not establish that its scientific intervention transfers",
  ])].slice(0, 8);
  const environment = {
    ...(executor ? { executor } : {}),
    ...(experience.routing?.provider ? { provider: experience.routing.provider } : {}),
    ...(experience.routing?.model ? { model: experience.routing.model } : {}),
    ...(typeof manifest.datasetVersion === "string" ? { datasetVersion: manifest.datasetVersion } : {}),
    ...(typeof manifest.splitVersion === "string" ? { splitVersion: manifest.splitVersion } : {}),
  };
  return ExecutionPlaybookSchema.parse({
    schemaVersion: 1,
    id: `execution_playbook_${experience.trajectoryId}`,
    title: `Verified execution procedure for ${experience.scene.task}`,
    task: experience.scene.task,
    domain: experience.scene.domain,
    trigger: `When pursuing an objective similar to: ${experience.goal.objective}`,
    steps,
    environment,
    failureModes: failures.length ? failures : ["procedure has not been validated on the target task"],
    evidenceIds: [experience.trajectoryId],
    sourceTrajectoryId: experience.trajectoryId,
    status: "verified_procedure",
  });
}

function relevance(playbook: ExecutionPlaybook, query: string): number {
  const queryTokens = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
  if (!queryTokens.size) return 0;
  const vocabulary = new Set(`${playbook.title} ${playbook.task} ${playbook.domain} ${playbook.trigger} ${playbook.steps.join(" ")}`.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
  return [...queryTokens].filter((token) => vocabulary.has(token)).length / queryTokens.size;
}

/** Read only validated procedural-memory events and rank them by target fit. */
export function executionPlaybooksFromEvents(events: Array<{ type: string; payload: unknown }>, query = "", limit = 8): ExecutionPlaybook[] {
  const seen = new Set<string>();
  return events
    .filter((event) => event.type === "research.execution.playbook")
    .flatMap((event) => {
      const parsed = ExecutionPlaybookSchema.safeParse(event.payload);
      return parsed.success ? [parsed.data] : [];
    })
    .filter((playbook) => {
      if (seen.has(playbook.id)) return false;
      seen.add(playbook.id);
      return true;
    })
    .map((playbook, index) => ({ playbook, index, score: relevance(playbook, query) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(0, Math.min(limit, 50)))
    .map((entry) => entry.playbook);
}
