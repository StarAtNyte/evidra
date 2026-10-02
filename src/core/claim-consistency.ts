export interface ConsistencyClaim {
  id: string;
  statement: string;
  sourceType: string;
  confidence: number;
}

export type ClaimRelation = "duplicate" | "contradicts";

function normalize(statement: string): string {
  return statement.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function polarity(statement: string): boolean {
  return /\b(?:not|no|never|without|cannot|can't|doesn't|doesnt|isn't|isnt|fails?|failed|unable)\b/i.test(statement);
}

/**
 * A negation is only evidence of contradiction when it flips the same claim.
 * Negation anywhere in a sentence is not enough: qualifiers such as
 * "this is not a new locked comparison" must not invert an earlier result.
 */
function negationCore(statement: string): string {
  return normalize(statement)
    .replace(/\b(?:is|are|was|were|does|do|did|has|have|had|can|could|will|would|should|must)\s+(?:not|never)\b/g, " ")
    .replace(/\b(?:not|no|never|without|cannot|cant|doesnt|isnt|fails?|failed|unable)\b/g, " ")
    .replace(/\b(?:is|are|was|were|does|do|did|has|have|had|can|could|will|would|should|must)\b/g, " ")
    .replace(/\b([a-z]{4,})s\b/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Conservative claim comparison; ambiguous semantic differences are intentionally ignored. */
export function compareClaims(left: ConsistencyClaim, right: ConsistencyClaim): { relation: ClaimRelation; confidence: number } | undefined {
  if (left.id === right.id) return undefined;
  const leftNormalized = normalize(left.statement);
  const rightNormalized = normalize(right.statement);
  if (!leftNormalized || !rightNormalized) return undefined;
  if (leftNormalized === rightNormalized) return { relation: "duplicate", confidence: Math.min(left.confidence, right.confidence) };
  if (polarity(left.statement) === polarity(right.statement)) return undefined;
  if (!negationCore(left.statement) || negationCore(left.statement) !== negationCore(right.statement)) return undefined;
  return { relation: "contradicts", confidence: Math.min(0.8, Math.min(left.confidence, right.confidence)) };
}
