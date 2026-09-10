import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface PredictionVector {
  id: string;
  path: string;
  values: number[];
  checksum?: string;
}

export interface BlendCandidate {
  id: string;
  path: string;
  members: string[];
  memberChecksums: Record<string, string>;
  values: number[];
  createdAt: string;
  checksum: string;
  status: "candidate" | "validated" | "promoted" | "rejected";
}

export interface BlendValidation {
  valid: boolean;
  checksum: string;
  reason: string;
  payload?: { id?: unknown; members?: unknown; memberChecksums?: unknown; values?: unknown; status?: unknown };
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
  const rawFile = readFileSync(path, "utf8");
  const checksum = `sha256:${createHash("sha256").update(rawFile).digest("hex")}`;
  const raw = rawFile.trim();
  let values: number[] = [];
  try { values = numericValues(JSON.parse(raw)); } catch {
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const rows = lines[0]?.split(",").map((value) => value.trim().toLowerCase()) ?? [];
    const predictionIndex = Math.max(0, rows.findIndex((value) => /prediction|pred|score|value/.test(value)));
    values = lines.slice(rows.length && rows.some((value) => /prediction|pred|score|value/.test(value)) ? 1 : 0).map((line) => Number(line.split(",")[predictionIndex])).filter(Number.isFinite);
  }
  if (values.length < 2) throw new Error(`Prediction artifact '${path}' contains fewer than two numeric predictions.`);
  return { id, path, values, checksum };
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

/** Write a reproducible, checksummed blend artifact without silently promoting it. */
export function createBlendCandidate(root: string, vectors: PredictionVector[], weights?: number[]): BlendCandidate {
  if (vectors.length < 2) throw new Error("At least two prediction vectors are required to create an ensemble candidate.");
  const id = `blend_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();
  const values = greedyBlend(vectors, weights);
  const memberChecksums = Object.fromEntries(vectors.filter((vector) => vector.checksum).map((vector) => [vector.id, vector.checksum as string]));
  const payload = { schemaVersion: 1, id, members: vectors.map((vector) => ({ id: vector.id, path: vector.path, length: vector.values.length })), memberChecksums, values, createdAt, status: "candidate" as const };
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  const checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const path = join(root, ".sota", "ensembles", `${id}.json`);
  mkdirSync(join(root, ".sota", "ensembles"), { recursive: true });
  writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
  return { id, path, members: vectors.map((vector) => vector.id), memberChecksums, values, createdAt, checksum, status: "candidate" };
}

/** Verify the immutable blend artifact before allowing a lifecycle transition. */
export function validateBlendCandidate(path: string, expectedChecksum: string): BlendValidation {
  if (!existsSync(path)) return { valid: false, checksum: "", reason: "blend artifact is missing" };
  let content: string;
  try { content = readFileSync(path, "utf8"); } catch { return { valid: false, checksum: "", reason: "blend artifact is unreadable" }; }
  const checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  if (checksum !== expectedChecksum) return { valid: false, checksum, reason: "blend checksum does not match its durable record" };
  try {
    const payload = JSON.parse(content) as { id?: unknown; members?: unknown; memberChecksums?: unknown; values?: unknown; status?: unknown };
    const values = Array.isArray(payload.values) && payload.values.length > 1 && payload.values.every((value) => typeof value === "number" && Number.isFinite(value));
    const members = Array.isArray(payload.members) && payload.members.length >= 2;
    if (typeof payload.id !== "string" || !members || !values) return { valid: false, checksum, reason: "blend schema or numeric values are invalid", payload };
    const memberChecksums = payload.memberChecksums && typeof payload.memberChecksums === "object" ? payload.memberChecksums as Record<string, unknown> : {};
    for (const member of payload.members as Array<{ id?: unknown; path?: unknown }>) {
      if (typeof member.id !== "string" || typeof member.path !== "string") return { valid: false, checksum, reason: "blend member provenance is invalid", payload };
      const expected = memberChecksums[member.id];
      if (typeof expected !== "string") continue;
      if (!existsSync(member.path)) return { valid: false, checksum, reason: `blend member is missing: ${member.id}`, payload };
      const actual = `sha256:${createHash("sha256").update(readFileSync(member.path)).digest("hex")}`;
      if (actual !== expected) return { valid: false, checksum, reason: `blend member checksum changed: ${member.id}`, payload };
    }
    return { valid: true, checksum, reason: "checksum and blend schema are valid", payload };
  } catch { return { valid: false, checksum, reason: "blend artifact is not valid JSON" }; }
}
