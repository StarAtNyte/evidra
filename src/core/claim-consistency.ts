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

function tokens(statement: string): Set<string> {
  return new Set(normalize(statement).split(" ").filter((token) => token.length > 2));
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

function polarity(statement: string): boolean {
  return /\b(?:not|no|never|without|cannot|can't|doesn't|doesnt|isn't|isnt|fails?|failed|unable)\b/i.test(statement);
}

/** Conservative claim comparison; ambiguous semantic differences are intentionally ignored. */
export function compareClaims(left: ConsistencyClaim, right: ConsistencyClaim): { relation: ClaimRelation; confidence: number } | undefined {
  if (left.id === right.id) return undefined;
  const leftNormalized = normalize(left.statement);
  const rightNormalized = normalize(right.statement);
  if (!leftNormalized || !rightNormalized) return undefined;
  if (leftNormalized === rightNormalized) return { relation: "duplicate", confidence: Math.min(left.confidence, right.confidence) };
  const leftTokens = tokens(left.statement);
  const rightTokens = tokens(right.statement);
  if (overlap(leftTokens, rightTokens) < 0.75 || polarity(left.statement) === polarity(right.statement)) return undefined;
  return { relation: "contradicts", confidence: Math.min(0.8, Math.min(left.confidence, right.confidence)) };
}
