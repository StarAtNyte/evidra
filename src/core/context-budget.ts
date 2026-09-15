export interface ContextBudgetReport {
  maxChars: number;
  usedChars: number;
  dropped: string[];
  truncated: string[];
}

export interface BoundedContext {
  context: Record<string, unknown>;
  report: ContextBudgetReport;
}

const priority = [
  "observation", "phaseGoal", "allocation", "evidenceConflicts", "toolResults",
  "crossPollination", "laneReports", "researchMemory", "experienceReplay",
  "literatureFrontier", "literatureBenchmarkEvidence", "openCriticConstraint", "adaptiveHarnessPolicy",
  "harnessAdaptationAgenda", "harnessEvolutionPlan", "harnessBenchmarkEvidence",
  "harnessChangeHistory",
  "recentEvents", "researchSources", "availableTools",
];

function size(value: unknown): number {
  try { return JSON.stringify(value).length; } catch { return 0; }
}

function boundValue(value: unknown, budget: number, path: string, truncated: string[]): unknown {
  if (budget <= 0) return undefined;
  if (typeof value === "string") {
    if (value.length <= budget) return value;
    truncated.push(path);
    return `${value.slice(0, Math.max(0, budget - 32))}\n...[context truncated by Evidra]`;
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const remaining = Math.max(128, Math.floor((budget - size(output)) / Math.max(1, value.length - index)));
      const item = boundValue(value[index], remaining, `${path}[${index}]`, truncated);
      if (item === undefined) { truncated.push(path); break; }
      output.push(item);
      if (size(output) >= budget * 0.95) {
        if (index + 1 < value.length) truncated.push(path);
        break;
      }
    }
    return output;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const remaining = Math.max(128, budget - size(output));
      const bounded = boundValue(child, remaining, `${path}.${key}`, truncated);
      if (bounded !== undefined) output[key] = bounded;
      if (size(output) >= budget * 0.95) {
        if (Object.keys(output).length < Object.keys(value as Record<string, unknown>).length) truncated.push(path);
        break;
      }
    }
    return output;
  }
  return value;
}

/** Pack model context under one aggregate character budget without changing evidence semantics. */
/**
 * Keep provider turns small enough for responsive, repeated autonomous cycles.
 * Large historical state is still durable in SQLite; it should not be replayed
 * wholesale into every lane/director prompt. Operators can raise the ceiling
 * for unusually large tasks without changing the evidence on disk.
 */
export function boundResearchContext(input: Record<string, unknown>, maxChars = Number(process.env.EVIDRA_CONTEXT_MAX_CHARS ?? 48_000)): BoundedContext {
  const budget = Math.max(4_000, Math.floor(maxChars));
  const truncated: string[] = [];
  const dropped: string[] = [];
  const keys = Object.keys(input).sort((left, right) => {
    const leftIndex = priority.indexOf(left);
    const rightIndex = priority.indexOf(right);
    return (leftIndex < 0 ? priority.length : leftIndex) - (rightIndex < 0 ? priority.length : rightIndex) || left.localeCompare(right);
  });
  const context: Record<string, unknown> = {};
  for (const key of keys) {
    const remaining = budget - size(context);
    if (remaining < 256) { dropped.push(key); continue; }
    const bounded = boundValue(input[key], remaining, key, truncated);
    if (bounded === undefined) dropped.push(key);
    else context[key] = bounded;
  }
  const report: ContextBudgetReport = { maxChars: budget, usedChars: size(context), dropped: [...new Set(dropped)], truncated: [...new Set(truncated)] };
  context.contextBudget = report;
  return { context, report };
}
