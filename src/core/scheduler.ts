import { PriorityInputSchema, type PriorityInput } from "./types.js";

export interface PriorityBreakdown extends PriorityInput {
  numerator: number;
  denominator: number;
  priority: number;
}

/**
 * Cost-aware research priority. The weights are deliberately explicit so the
 * director can explain why one hypothesis was scheduled ahead of another.
 */
export function scorePriority(input: PriorityInput): PriorityBreakdown {
  const value = PriorityInputSchema.parse(input);
  const numerator = value.probabilityOfSuccess * (
    value.expectedDelta + value.informationValue + value.diversityValue
  );
  const denominator = Math.max(0.01, value.gpuCost + value.llmCost + value.engineeringCost + value.risk);
  return { ...value, numerator, denominator, priority: numerator / denominator };
}

export function rankPriorities<T extends PriorityInput>(items: T[]): Array<T & PriorityBreakdown> {
  return items.map((item) => ({ ...item, ...scorePriority(item) })).sort((left, right) => right.priority - left.priority);
}
