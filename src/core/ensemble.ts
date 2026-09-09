import { existsSync, readFileSync } from "node:fs";

export interface PredictionVector {
  id: string;
  path: string;
  values: number[];
}

export interface DiversityPair {
  left: string;
  right: string;
  correlation: number;
  disagreement: number;
}

function numericValues(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  if (value && typeof value === "object") {
    const record = value as { predictions?: unknown; values?: unknown; prediction?: unknown };
    if (Array.isArray(record.predictions)) return numericValues(record.predictions);
    if (Array.isArray(record.values)) return numericValues(record.values);
    if (record.prediction !== undefined) return numericValues([record.prediction]);
  }
  return [];
}

export function loadPredictionVector(id: string, path: string): PredictionVector {
  if (!existsSync(path)) throw new Error(`Prediction artifact does not exist: ${path}`);
  const raw = readFileSync(path, "utf8").trim();
  let values: number[] = [];
  try { values = numericValues(JSON.parse(raw)); } catch {
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const rows = lines[0]?.split(",").map((value) => value.trim().toLowerCase()) ?? [];
    const predictionIndex = Math.max(0, rows.findIndex((value) => /prediction|pred|score|value/.test(value)));
    values = lines.slice(rows.length && rows.some((value) => /prediction|pred|score|value/.test(value)) ? 1 : 0).map((line) => Number(line.split(",")[predictionIndex])).filter(Number.isFinite);
  }
  if (values.length < 2) throw new Error(`Prediction artifact '${path}' contains fewer than two numeric predictions.`);
  return { id, path, values };
}

function mean(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }

function correlation(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  const x = left.slice(0, length); const y = right.slice(0, length);
  const xMean = mean(x); const yMean = mean(y);
  const numerator = x.reduce((sum, value, index) => sum + (value - xMean) * (y[index] - yMean), 0);
  const denominator = Math.sqrt(x.reduce((sum, value) => sum + (value - xMean) ** 2, 0) * y.reduce((sum, value) => sum + (value - yMean) ** 2, 0));
  return denominator === 0 ? 0 : numerator / denominator;
}

export function diversityReport(vectors: PredictionVector[]): DiversityPair[] {
  const pairs: DiversityPair[] = [];
  for (let left = 0; left < vectors.length; left += 1) for (let right = left + 1; right < vectors.length; right += 1) {
    const a = vectors[left].values; const b = vectors[right].values; const length = Math.min(a.length, b.length);
    pairs.push({ left: vectors[left].id, right: vectors[right].id, correlation: correlation(a, b), disagreement: a.slice(0, length).reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / length });
  }
  return pairs.sort((a, b) => a.correlation - b.correlation);
}

export function greedyBlend(vectors: PredictionVector[], weights?: number[]): number[] {
  if (!vectors.length) throw new Error("At least one prediction vector is required.");
  const length = Math.min(...vectors.map((vector) => vector.values.length));
  const blendWeights = weights?.length === vectors.length ? weights : vectors.map(() => 1 / vectors.length);
  const total = blendWeights.reduce((sum, value) => sum + value, 0) || 1;
  return Array.from({ length }, (_, index) => vectors.reduce((sum, vector, vectorIndex) => sum + vector.values[index] * blendWeights[vectorIndex], 0) / total);
}
