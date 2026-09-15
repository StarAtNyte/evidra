import { z } from "zod";
import { TransferableMethodSchema } from "./method-transfer.js";

/** A reusable procedure distilled from an independently replicated result. */
export interface VerifiedPlaybook {
  schemaVersion: 1;
  id: string;
  title: string;
  sourceContext: string;
  sourceCompetition: string;
  sourceTaskType: string;
  formulationFamily: string;
  trigger: string;
  steps: string[];
  failureModes: string[];
  evidenceIds: string[];
  tags: string[];
  /** Playbooks are leads for a new workspace, never proof of transfer. */
  status: "replicated_lead";
}

export const VerifiedPlaybookSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  title: z.string().min(1),
  sourceContext: z.string().min(1).default("general-research"),
  sourceCompetition: z.string().min(1).default("general-research"),
  sourceTaskType: z.string().min(1),
  formulationFamily: z.string().min(1),
  trigger: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1).max(8),
  failureModes: z.array(z.string().min(1)).min(1).max(8),
  evidenceIds: z.array(z.string().min(1)).min(2).refine((ids) => new Set(ids).size >= 2, "independent evidence IDs are required"),
  tags: z.array(z.string().min(1)).max(12),
  status: z.literal("replicated_lead"),
});

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
}

function relevance(playbook: VerifiedPlaybook, query: string): number {
  const requested = tokens(query);
  if (!requested.size) return 0;
  const vocabulary = tokens(`${playbook.title} ${playbook.sourceContext} ${playbook.sourceTaskType} ${playbook.formulationFamily} ${playbook.trigger} ${playbook.steps.join(" ")} ${playbook.tags.join(" ")}`);
  return [...requested].filter((token) => vocabulary.has(token)).length / requested.size;
}

/** Derive a playbook only from the durable replicated-method contract. */
export function playbookFromMethod(method: {
  id: string;
  sourceContext?: string;
  sourceCompetition?: string;
  sourceTaskType: string;
  title: string;
  formulationFamily: string;
  mechanism: string;
  proposedChange: string;
  evidenceIds: string[];
  tags: string[];
}): VerifiedPlaybook {
  return VerifiedPlaybookSchema.parse({
    schemaVersion: 1,
    id: `playbook_${method.id}`,
    title: method.title,
    sourceContext: method.sourceContext ?? method.sourceCompetition ?? "general-research",
    sourceCompetition: method.sourceCompetition ?? "general-research",
    sourceTaskType: method.sourceTaskType,
    formulationFamily: method.formulationFamily,
    trigger: method.mechanism,
    steps: [method.proposedChange],
    // A replicated method does not imply universal applicability. Preserve
    // the explicit transfer uncertainty in the playbook itself.
    failureModes: ["may not transfer to the current task, split, or data distribution"],
    evidenceIds: [...new Set(method.evidenceIds)],
    tags: [...new Set(method.tags)],
    status: "replicated_lead",
  });
}

/** Rank durable playbooks for a new objective without treating them as proof. */
export function verifiedPlaybooksFromEvents(events: Array<{ type: string; payload: unknown }>, query = "", limit = 8): VerifiedPlaybook[] {
  const seen = new Set<string>();
  return events
    .filter((event) => event.type === "research.method.transferable" && event.payload && typeof event.payload === "object")
    .flatMap((event) => {
      const method = TransferableMethodSchema.safeParse(event.payload);
      if (!method.success) return [];
      const parsed = VerifiedPlaybookSchema.safeParse(playbookFromMethod(method.data));
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
