import { z } from "zod";

export type AutoResearchTrack = "deep" | "wide";

const InputRecordSchema = z.object({
  question: z.string().min(1),
  type: z.enum(["deep", "wide"]).optional(),
  answer: z.array(z.string()).optional(),
  arxiv_id: z.array(z.union([z.string(), z.number()])).optional(),
}).passthrough();

export interface AutoResearchInputRecord {
  question: string;
  type: AutoResearchTrack;
  answer: string[];
  arxivId: string[];
}

export interface AutoResearchEvaluationSummary {
  source: "deep" | "wide";
  records: number;
  passes?: number;
  metrics: Record<string, number>;
  raw: unknown;
}

function parseJsonLines(text: string, label: string): unknown[] {
  const records: unknown[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid ${label} JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return records;
}

/** Parse the decrypted official AutoResearchBench task JSONL. */
export function parseAutoResearchBenchInput(text: string): AutoResearchInputRecord[] {
  const records = parseJsonLines(text, "AutoResearchBench input");
  if (!records.length) throw new Error("AutoResearchBench input is empty.");
  return records.map((record, index) => {
    const parsed = InputRecordSchema.parse(record);
    return {
      question: parsed.question.trim(),
      type: parsed.type ?? "deep",
      answer: (parsed.answer ?? []).map((value) => value.trim()).filter(Boolean),
      arxivId: (parsed.arxiv_id ?? []).map(String).map((value) => value.trim()).filter(Boolean),
    } satisfies AutoResearchInputRecord;
  }).filter((record, index) => {
    if (!record.answer.length && !record.arxivId.length) throw new Error(`AutoResearchBench record ${index + 1} has neither answer titles nor arXiv IDs.`);
    return true;
  });
}

function numericMetrics(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, raw]) => {
    if (typeof raw === "number" && Number.isFinite(raw)) return [[key, raw]];
    if (typeof raw === "string") {
      const percent = raw.trim().match(/^(-?\d+(?:\.\d+)?)%$/);
      if (percent) return [[key, Number(percent[1]) / 100]];
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return [[key, parsed]];
    }
    return [];
  }));
}

/** Parse an official deep or wide evaluator JSON file for durable comparison. */
export function parseAutoResearchBenchEvaluation(value: unknown): AutoResearchEvaluationSummary {
  if (!value || typeof value !== "object") throw new Error("AutoResearchBench evaluation must be a JSON object.");
  const payload = value as Record<string, unknown>;
  const deepSummary = payload.summary && typeof payload.summary === "object" ? payload.summary as Record<string, unknown> : undefined;
  const wideSummary = payload.aggregate_stats && typeof payload.aggregate_stats === "object" ? payload.aggregate_stats as Record<string, unknown> : undefined;
  if (deepSummary) {
    const metrics = numericMetrics(deepSummary.overall_metrics);
    const records = typeof deepSummary.total_items === "number" ? deepSummary.total_items : 0;
    const passes = typeof deepSummary.k === "number" ? deepSummary.k : undefined;
    if (!records || !Object.keys(metrics).length) throw new Error("AutoResearchBench deep evaluation is missing summary metrics.");
    return { source: "deep", records, ...(passes === undefined ? {} : { passes }), metrics, raw: value };
  }
  if (wideSummary) {
    const metrics = numericMetrics(wideSummary);
    const records = typeof wideSummary.total_records === "number" ? wideSummary.total_records : 0;
    const passes = typeof wideSummary.total_passes === "number" ? wideSummary.total_passes : undefined;
    if (!records || !Object.keys(metrics).length) throw new Error("AutoResearchBench wide evaluation is missing aggregate metrics.");
    return { source: "wide", records, ...(passes === undefined ? {} : { passes }), metrics, raw: value };
  }
  throw new Error("Unrecognized AutoResearchBench evaluation: expected summary or aggregate_stats.");
}
