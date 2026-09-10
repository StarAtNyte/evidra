export interface TransferableMethod {
  schemaVersion: 1;
  id: string;
  sourceCompetition: string;
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

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
}

function relevance(method: TransferableMethod, query?: string): number {
  const queryTokens = tokens(query ?? "");
  if (!queryTokens.size) return 0;
  const methodTokens = tokens(`${method.title} ${method.formulationFamily} ${method.mechanism} ${method.proposedChange} ${method.tags.join(" ")}`);
  return [...queryTokens].filter((token) => methodTokens.has(token)).length / queryTokens.size;
}

/** Create a reusable method only after an independent replicated improvement. */
export function createTransferableMethod(input: Omit<TransferableMethod, "schemaVersion" | "replicated">): TransferableMethod {
  return { schemaVersion: 1, ...input, replicated: true };
}

/** Read only durable method events and rank them for a new research objective. */
export function transferableMethodsFromEvents(events: Array<{ type: string; payload: unknown }>, query?: string, limit = 8): TransferableMethod[] {
  return events
    .filter((event) => event.type === "research.method.transferable" && event.payload && typeof event.payload === "object")
    .map((event) => event.payload as TransferableMethod)
    .filter((method) => method.schemaVersion === 1 && method.replicated === true && typeof method.title === "string" && typeof method.proposedChange === "string")
    .map((method, index) => ({ method, score: relevance(method, query), index }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(0, Math.min(limit, 50)))
    .map((entry) => entry.method);
}
