/** A durable negative lesson retained to prevent repeating an exhausted route. */
export interface FailedDirection {
  schemaVersion: 1;
  id: string;
  title: string;
  proposedChange?: string;
  failureClass: string;
  reason: string;
  scope: "current-workspace";
  status: "failed_direction";
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
}

function score(direction: FailedDirection, query: string): number {
  const requested = tokens(query);
  if (!requested.size) return 0;
  const vocabulary = tokens(`${direction.title} ${direction.proposedChange ?? ""} ${direction.failureClass} ${direction.reason}`);
  return [...requested].filter((token) => vocabulary.has(token)).length / requested.size;
}

/** Extract failed experiment directions without promoting their narrative as proof. */
export function failedDirectionsFromExperiments(
  experiments: Array<{ id: string; payload: unknown }>,
  query = "",
  limit = 8,
): FailedDirection[] {
  const seen = new Set<string>();
  return experiments
    .flatMap((experiment) => {
      if (!experiment.payload || typeof experiment.payload !== "object") return [];
      const value = experiment.payload as Record<string, unknown>;
      const status = typeof value.status === "string" ? value.status : "";
      if (!["failed", "invalid", "rejected", "blocked"].includes(status)) return [];
      const title = typeof value.title === "string" ? value.title : typeof value.hypothesisTitle === "string" ? value.hypothesisTitle : experiment.id;
      const proposedChange = typeof value.proposedChange === "string" ? value.proposedChange : undefined;
      const failureClass = typeof value.failureClass === "string" ? value.failureClass : status;
      const reason = typeof value.failureReason === "string" ? value.failureReason : typeof value.reason === "string" ? value.reason : `experiment ended with status ${status}`;
      return [{ schemaVersion: 1 as const, id: experiment.id, title, ...(proposedChange ? { proposedChange } : {}), failureClass, reason, scope: "current-workspace" as const, status: "failed_direction" as const }];
    })
    .filter((direction) => {
      if (seen.has(direction.id)) return false;
      seen.add(direction.id);
      return true;
    })
    .map((direction, index) => ({ direction, index, relevance: score(direction, query) }))
    .sort((left, right) => right.relevance - left.relevance || left.index - right.index)
    .slice(0, Math.max(0, Math.min(limit, 50)))
    .map((entry) => entry.direction);
}
