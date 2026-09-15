import { z } from "zod";

export interface TransferableMethod {
  schemaVersion: 1;
  id: string;
  /** Domain-neutral provenance; sourceCompetition remains for legacy records. */
  sourceContext: string;
  sourceCompetition?: string;
  sourceTaskType: string;
  title: string;
  formulationFamily: string;
  mechanism: string;
  proposedChange: string;
  evidenceIds: string[];
  observedDelta?: number;
  replicated: true;
  tags: string[];
}

export const TransferableMethodSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  sourceContext: z.string().min(1).default("general-research"),
  sourceCompetition: z.string().min(1).optional(),
  sourceTaskType: z.string().min(1),
  title: z.string().min(1),
  formulationFamily: z.string().min(1),
  mechanism: z.string(),
  proposedChange: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).min(2).refine((ids) => new Set(ids).size >= 2, "independent evidence IDs are required"),
  observedDelta: z.number().finite().optional(),
  replicated: z.literal(true),
  tags: z.array(z.string().min(1)),
});

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
}

function relevance(method: TransferableMethod, query?: string): number {
  const queryTokens = tokens(query ?? "");
  if (!queryTokens.size) return 0;
  const methodTokens = tokens(`${method.title} ${method.sourceContext} ${method.sourceCompetition ?? ""} ${method.formulationFamily} ${method.mechanism} ${method.proposedChange} ${method.tags.join(" ")}`);
  return [...queryTokens].filter((token) => methodTokens.has(token)).length / queryTokens.size;
}

/** Create a reusable method only after an independent replicated improvement. */
export function createTransferableMethod(input: Omit<TransferableMethod, "schemaVersion" | "replicated" | "sourceContext"> & { sourceContext?: string }): TransferableMethod {
  return TransferableMethodSchema.parse({
    schemaVersion: 1,
    ...input,
    sourceContext: input.sourceContext ?? input.sourceCompetition ?? "general-research",
    replicated: true,
  });
}

/** Read only durable method events and rank them for a new research objective. */
export function transferableMethodsFromEvents(events: Array<{ type: string; payload: unknown }>, query?: string, limit = 8): TransferableMethod[] {
  const seen = new Set<string>();
  return events
    .filter((event) => event.type === "research.method.transferable" && event.payload && typeof event.payload === "object")
    .map((event) => TransferableMethodSchema.safeParse(event.payload).success ? TransferableMethodSchema.parse(event.payload) : undefined)
    .filter((method): method is TransferableMethod => {
      if (method === undefined || seen.has(method.id)) return false;
      seen.add(method.id);
      return true;
    })
    .map((method, index) => ({ method, score: relevance(method, query), index }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(0, Math.min(limit, 50)))
    .map((entry) => entry.method);
}
