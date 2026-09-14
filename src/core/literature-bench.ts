import { z } from "zod";

export type LiteratureTaskKind = "deep" | "wide";

export interface LiteratureBenchmarkTask {
  id: string;
  kind: LiteratureTaskKind;
  requiredWorks: string[];
  queryBudget: number;
}

export interface LiteratureBenchmarkObservation {
  taskId: string;
  queries: number;
  candidates: Array<{ work: string; grounded: boolean }>;
}

export const LiteratureBenchmarkTaskSchema = z.object({
  id: z.string().min(1).max(160),
  kind: z.enum(["deep", "wide"]),
  requiredWorks: z.array(z.string().min(1)).min(1).max(1_000),
  queryBudget: z.number().int().positive().max(10_000),
});

export const LiteratureBenchmarkObservationSchema = z.object({
  taskId: z.string().min(1).max(160),
  queries: z.number().int().nonnegative().max(10_000),
  candidates: z.array(z.object({ work: z.string().min(1), grounded: z.boolean() })).max(10_000),
});

export function parseLiteratureBenchmarkInput(value: unknown): { tasks: LiteratureBenchmarkTask[]; observations: LiteratureBenchmarkObservation[] } {
  if (!value || typeof value !== "object") throw new Error("Literature benchmark input must be an object.");
  const rawTasks = (value as { tasks?: unknown }).tasks;
  const rawObservations = (value as { observations?: unknown }).observations;
  if (!Array.isArray(rawTasks) || !rawTasks.length || !Array.isArray(rawObservations)) throw new Error("Literature benchmark input must contain non-empty tasks and an observations array.");
  const tasks = z.array(LiteratureBenchmarkTaskSchema).parse(rawTasks);
  const observations = z.array(LiteratureBenchmarkObservationSchema).parse(rawObservations);
  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (taskIds.has(task.id)) throw new Error(`Literature benchmark contains duplicate task '${task.id}'.`);
    taskIds.add(task.id);
  }
  if (observations.some((observation) => !taskIds.has(observation.taskId))) throw new Error("Literature benchmark observation references an unknown task.");
  return { tasks, observations };
}

export interface LiteratureTaskScore {
  taskId: string;
  kind: LiteratureTaskKind;
  targetRecall: number;
  groundingRate: number;
  queryEfficiency: number;
  score: number;
  valid: boolean;
  reasons: string[];
}

export interface LiteratureBenchmarkReport {
  valid: boolean;
  tasks: LiteratureTaskScore[];
  meanScore: number | null;
  deepRecall: number | null;
  wideRecall: number | null;
  meanGroundingRate: number | null;
  meanQueryEfficiency: number | null;
}

/** Normalize DOI/URL identity without trusting titles or repository metadata. */
export function literatureWorkKey(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "doi:").replace(/^doi:\s*/, "doi:").replace(/[?#].*$/, "").replace(/\/$/, "");
}

/** Score literature discovery as a task protocol, not as a narrative review. */
export function scoreLiteratureBenchmark(tasks: LiteratureBenchmarkTask[], observations: LiteratureBenchmarkObservation[]): LiteratureBenchmarkReport {
  const byTask = new Map(observations.map((observation) => [observation.taskId, observation]));
  const scores = tasks.map((task): LiteratureTaskScore => {
    const reasons: string[] = [];
    const observation = byTask.get(task.id);
    if (!observation) return { taskId: task.id, kind: task.kind, targetRecall: 0, groundingRate: 0, queryEfficiency: 0, score: 0, valid: false, reasons: ["missing observation"] };
    const required = new Set(task.requiredWorks.map(literatureWorkKey).filter(Boolean));
    const found = new Set(observation.candidates.map((candidate) => literatureWorkKey(candidate.work)).filter((work) => required.has(work)));
    const grounded = new Set(observation.candidates.filter((candidate) => candidate.grounded).map((candidate) => literatureWorkKey(candidate.work)));
    const targetRecall = required.size ? found.size / required.size : 0;
    const groundingRate = found.size ? [...found].filter((work) => grounded.has(work)).length / found.size : 0;
    const queries = Math.max(0, Math.floor(observation.queries));
    const queryEfficiency = queries > 0 ? Math.min(1, targetRecall * task.queryBudget / queries) : 0;
    if (queries > task.queryBudget) reasons.push(`query budget exceeded (${queries} > ${task.queryBudget})`);
    if (targetRecall < 1) reasons.push(`target recall ${(targetRecall * 100).toFixed(1)}%`);
    if (groundingRate < 1) reasons.push(`grounding ${(groundingRate * 100).toFixed(1)}%`);
    const valid = queries <= task.queryBudget && targetRecall === 1 && groundingRate === 1;
    return { taskId: task.id, kind: task.kind, targetRecall, groundingRate, queryEfficiency, score: 0.5 * targetRecall + 0.3 * groundingRate + 0.2 * queryEfficiency, valid, reasons };
  });
  const mean = (values: number[]): number | null => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const deep = scores.filter((score) => score.kind === "deep").map((score) => score.targetRecall);
  const wide = scores.filter((score) => score.kind === "wide").map((score) => score.targetRecall);
  return { valid: scores.length > 0 && scores.every((score) => score.valid), tasks: scores, meanScore: mean(scores.map((score) => score.score)), deepRecall: mean(deep), wideRecall: mean(wide), meanGroundingRate: mean(scores.map((score) => score.groundingRate)), meanQueryEfficiency: mean(scores.map((score) => score.queryEfficiency)) };
}
