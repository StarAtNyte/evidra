import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Per-unit evaluator output: one score per evaluation unit (a row, a cell,
 * an item, a task) plus optional segment columns. The aggregate metric is a
 * single noisy number; unit scores let the ratchet run a paired test and let
 * the analyst localize where the loss actually is.
 */
export interface UnitScore {
  unit: string;
  score: number;
  segments: Record<string, string | number>;
  /** Optional mixture inputs: raw log-prob of the outcome, the same for a fallback predictor (e.g. the
   * marginal), and the scale that maps logp to score (score = logp / scale). Enables cross-fitted
   * shrink-toward-fallback headroom estimates. */
  mix?: { logp: number; fallback: number; scale: number };
}

export interface UnitScoreTable {
  units: UnitScore[];
  scoreColumn: string;
  idColumn: string;
  segmentColumns: string[];
  skippedRows: number;
  source: string;
}

export interface UnitScoreOptions {
  idColumn?: string;
  scoreColumn?: string;
  /** Columns used as segments; default: every non-id, non-score column with a bounded number of values or numeric type. */
  segmentColumns?: string[];
  /** Hard row cap so a huge per-cell file cannot exhaust memory. */
  maxRows?: number;
  /** Python interpreter used to read Parquet/Feather when present. */
  python?: string;
  logpColumn?: string;
  fallbackColumn?: string;
  scaleColumn?: string;
}

const ID_CANDIDATES = ["unit", "unit_id", "id", "row_id", "cell_id", "item_id", "key", "uid"];
const SCORE_CANDIDATES = ["score", "loss", "logprob", "log_prob", "log_likelihood", "loglik", "nll", "value", "metric", "reward", "error"];

function splitDelimited(line: string, delimiter: string): string[] {
  if (!line.includes("\"")) return line.split(delimiter);
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === "\"" && line[index + 1] === "\"") { current += "\""; index += 1; }
      else if (character === "\"") quoted = false;
      else current += character;
    } else if (character === "\"") quoted = true;
    else if (character === delimiter) { cells.push(current); current = ""; }
    else current += character;
  }
  cells.push(current);
  return cells;
}

function recordsFromText(text: string, format: "csv" | "tsv" | "jsonl" | "json", maxRows: number): Array<Record<string, unknown>> {
  if (format === "json") {
    const parsed = JSON.parse(text) as unknown;
    const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { units?: unknown }).units) ? (parsed as { units: unknown[] }).units : [];
    return rows.slice(0, maxRows).filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
  }
  const lines = text.split(/\r?\n/);
  if (format === "jsonl") {
    const records: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      if (records.length >= maxRows) break;
      if (!line.trim()) continue;
      try { const value = JSON.parse(line) as unknown; if (value && typeof value === "object" && !Array.isArray(value)) records.push(value as Record<string, unknown>); } catch { /* skip malformed line */ }
    }
    return records;
  }
  const delimiter = format === "tsv" ? "\t" : ",";
  const header = splitDelimited(lines[0] ?? "", delimiter).map((cell) => cell.trim());
  const records: Array<Record<string, unknown>> = [];
  for (const line of lines.slice(1)) {
    if (records.length >= maxRows) break;
    if (!line.trim()) continue;
    const cells = splitDelimited(line, delimiter);
    records.push(Object.fromEntries(header.map((name, index) => [name, cells[index]?.trim() ?? ""])));
  }
  return records;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
  return undefined;
}

/** Build a unit-score table from generic records, inferring id/score/segment columns. */
export function unitScoresFromRecords(records: Array<Record<string, unknown>>, options: UnitScoreOptions = {}, source = "records"): UnitScoreTable {
  const columns = records.length ? Object.keys(records[0]) : [];
  const lower = new Map(columns.map((column) => [column.toLowerCase(), column]));
  const idColumn = options.idColumn ?? ID_CANDIDATES.map((name) => lower.get(name)).find(Boolean) ?? "__row__";
  const scoreColumn = options.scoreColumn ?? SCORE_CANDIDATES.map((name) => lower.get(name)).find(Boolean)
    ?? columns.find((column) => column !== idColumn && records.slice(0, 50).every((record) => numeric(record[column]) !== undefined));
  if (!scoreColumn) throw new Error(`No score column found in ${source}; set unitScores.scoreColumn (columns: ${columns.join(", ") || "none"}).`);
  const mixColumns = new Set([options.logpColumn, options.fallbackColumn, options.scaleColumn].filter((column): column is string => Boolean(column)));
  const segmentColumns = options.segmentColumns ?? columns.filter((column) => {
    if (column === idColumn || column === scoreColumn || mixColumns.has(column)) return false;
    const values = new Set(records.slice(0, 5000).map((record) => String(record[column] ?? "")));
    const allNumeric = records.slice(0, 200).every((record) => numeric(record[column]) !== undefined);
    return allNumeric || values.size <= 200;
  });
  const units: UnitScore[] = [];
  let skippedRows = 0;
  records.forEach((record, index) => {
    const score = numeric(record[scoreColumn]);
    if (score === undefined) { skippedRows += 1; return; }
    const unit = idColumn === "__row__" ? String(index) : String(record[idColumn] ?? index);
    const segments: Record<string, string | number> = {};
    for (const column of segmentColumns) {
      const raw = record[column];
      const value = numeric(raw);
      segments[column] = value ?? String(raw ?? "");
    }
    const logp = options.logpColumn ? numeric(record[options.logpColumn]) : undefined;
    const fallback = options.fallbackColumn ? numeric(record[options.fallbackColumn]) : undefined;
    const scale = options.scaleColumn ? numeric(record[options.scaleColumn]) : 1;
    units.push({ unit, score, segments, ...(logp !== undefined && fallback !== undefined && scale !== undefined && scale !== 0 ? { mix: { logp, fallback, scale } } : {}) });
  });
  return { units, scoreColumn, idColumn, segmentColumns, skippedRows, source };
}

function readColumnarWithPython(path: string, python: string, maxRows: number): string {
  const script = "import sys\nimport pandas as pd\np=sys.argv[1]\ndf=pd.read_feather(p) if p.endswith(('.feather','.arrow')) else pd.read_parquet(p)\ndf.head(int(sys.argv[2])).to_csv(sys.stdout,index=False)\n";
  const result = spawnSync(python, ["-I", "-c", script, path, String(maxRows)], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Could not read ${path} with ${python} (pandas+pyarrow required): ${(result.stderr || result.error?.message || "").slice(-400)}`);
  return result.stdout;
}

/** Load a per-unit score file (CSV, TSV, JSONL, JSON, or Parquet/Feather via Python pandas). */
export function loadUnitScores(path: string, options: UnitScoreOptions = {}): UnitScoreTable {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Unit score file not found: ${path}`);
  const maxRows = Math.max(1, Math.min(options.maxRows ?? 5_000_000, 20_000_000));
  const extension = extname(path).toLowerCase();
  let records: Array<Record<string, unknown>>;
  if (extension === ".parquet" || extension === ".feather" || extension === ".arrow") {
    records = recordsFromText(readColumnarWithPython(path, options.python ?? "python3", maxRows), "csv", maxRows);
  } else {
    const text = readFileSync(path, "utf8");
    const format = extension === ".tsv" ? "tsv" : extension === ".jsonl" || extension === ".ndjson" ? "jsonl" : extension === ".json" ? "json" : "csv";
    records = recordsFromText(text, format, maxRows);
  }
  return unitScoresFromRecords(records, options, path);
}

/** Deterministic PRNG so bootstrap verdicts are reproducible from the ledger. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PairedBootstrapOptions {
  /** Whether higher unit scores are better. */
  direction: "maximize" | "minimize";
  iterations?: number;
  /** Two-sided confidence level for the reported interval. */
  confidence?: number;
  seed?: number;
  /** Resample whole clusters (for example respondents) instead of single units. */
  clusterBy?: string;
  /** Trim this fraction of the largest-magnitude paired differences on each side (robust mean). */
  trim?: number;
}

export interface PairedBootstrapResult {
  matched: number;
  unmatchedReference: number;
  unmatchedCandidate: number;
  clusters: number;
  /** Mean improvement per unit, oriented so positive is better. */
  meanImprovement: number;
  lower: number;
  upper: number;
  confidence: number;
  /** Bootstrap share of resamples with positive improvement. */
  probabilityImproved: number;
  standardError: number;
  wins: number;
  losses: number;
  ties: number;
  iterations: number;
  seed: number;
  clusterBy?: string;
}

function trimmedMean(values: number[], trim: number): number {
  if (!values.length) return 0;
  if (trim <= 0) return values.reduce((sum, value) => sum + value, 0) / values.length;
  const sorted = [...values].sort((left, right) => left - right);
  const cut = Math.floor(sorted.length * Math.min(0.45, trim));
  const kept = sorted.slice(cut, sorted.length - cut);
  return kept.reduce((sum, value) => sum + value, 0) / Math.max(1, kept.length);
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return Number.NaN;
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  return sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * (position - lowerIndex);
}

/**
 * Paired bootstrap over evaluation units matched by id. Both runs are scored
 * on the same units, so the per-unit difference removes the shared item
 * difficulty that makes two aggregate numbers hard to compare.
 */
export function pairedBootstrap(reference: readonly UnitScore[], candidate: readonly UnitScore[], options: PairedBootstrapOptions): PairedBootstrapResult {
  const iterations = Math.max(100, Math.min(Math.floor(options.iterations ?? 2000), 20_000));
  const confidence = Math.min(0.999, Math.max(0.5, options.confidence ?? 0.95));
  const seed = Math.floor(options.seed ?? 20260917);
  const trim = Math.max(0, Math.min(0.45, options.trim ?? 0));
  const sign = options.direction === "maximize" ? 1 : -1;
  const referenceById = new Map(reference.map((unit) => [unit.unit, unit]));
  const candidateIds = new Set<string>();
  const clusters = new Map<string, number[]>();
  let wins = 0; let losses = 0; let ties = 0;
  for (const unit of candidate) {
    candidateIds.add(unit.unit);
    const prior = referenceById.get(unit.unit);
    if (!prior) continue;
    const difference = sign * (unit.score - prior.score);
    if (difference > 1e-12) wins += 1; else if (difference < -1e-12) losses += 1; else ties += 1;
    const clusterKey = options.clusterBy ? String(unit.segments[options.clusterBy] ?? prior.segments[options.clusterBy] ?? unit.unit) : unit.unit;
    const bucket = clusters.get(clusterKey);
    if (bucket) bucket.push(difference); else clusters.set(clusterKey, [difference]);
  }
  const matched = wins + losses + ties;
  if (options.clusterBy && matched > 0 && clusters.size === matched && !candidate.some((unit) => unit.segments[options.clusterBy!] !== undefined) && !reference.some((unit) => unit.segments[options.clusterBy!] !== undefined)) {
    // Fail loudly: resampling single units when clusters were requested understates the variance.
    throw new Error(`pairedBootstrap: cluster column "${options.clusterBy}" is not present in the unit scores; load it (segment or cluster column) or drop clusterBy`);
  }
  const unmatchedReference = reference.filter((unit) => !candidateIds.has(unit.unit)).length;
  const unmatchedCandidate = candidate.length - matched;
  const groups = [...clusters.values()];
  const all = groups.flat();
  const meanImprovement = trimmedMean(all, trim);
  const random = mulberry32(seed);
  const samples: number[] = [];
  if (groups.length) {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      if (trim > 0) {
        const draw: number[] = [];
        for (let index = 0; index < groups.length; index += 1) draw.push(...groups[Math.floor(random() * groups.length)]);
        samples.push(trimmedMean(draw, trim));
      } else {
        let sum = 0; let count = 0;
        for (let index = 0; index < groups.length; index += 1) {
          const group = groups[Math.floor(random() * groups.length)];
          for (const value of group) sum += value;
          count += group.length;
        }
        samples.push(count ? sum / count : 0);
      }
    }
  }
  samples.sort((left, right) => left - right);
  const alpha = (1 - confidence) / 2;
  const mean = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, samples.length - 1);
  return {
    matched,
    unmatchedReference,
    unmatchedCandidate,
    clusters: groups.length,
    meanImprovement,
    lower: samples.length ? quantile(samples, alpha) : Number.NaN,
    upper: samples.length ? quantile(samples, 1 - alpha) : Number.NaN,
    confidence,
    probabilityImproved: samples.length ? samples.filter((value) => value > 0).length / samples.length : 0,
    standardError: Math.sqrt(variance),
    wins,
    losses,
    ties,
    iterations,
    seed,
    ...(options.clusterBy ? { clusterBy: options.clusterBy } : {}),
  };
}
