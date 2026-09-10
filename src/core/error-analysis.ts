export interface PredictionRow {
  id?: string;
  actual: string | number | boolean | null;
  predicted: string | number | boolean | null;
  group?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ErrorGroupSummary {
  group: string;
  total: number;
  errors: number;
  errorRate: number;
  meanAbsoluteError?: number;
}

export interface ErrorAnalysisReport {
  schemaVersion: 1;
  task: "classification" | "regression";
  total: number;
  errors: number;
  errorRate: number;
  accuracy?: number;
  mae?: number;
  rmse?: number;
  confusion?: Array<{ actual: string; predicted: string; count: number }>;
  groups: ErrorGroupSummary[];
  worstGroups: ErrorGroupSummary[];
  slices: ErrorSliceSummary[];
  worstSlices: ErrorSliceSummary[];
  calibration?: CalibrationBin[];
}

export interface PredictionComparison {
  matched: number;
  fixed: number;
  regressed: number;
  unchangedErrors: number;
  groups: Array<{ group: string; fixed: number; regressed: number; net: number }>;
}

export interface ErrorSliceSummary {
  feature: string;
  value: string;
  total: number;
  errors: number;
  errorRate: number;
  meanAbsoluteError?: number;
}

export interface CalibrationBin {
  bin: number;
  total: number;
  meanPredicted: number;
  empiricalRate: number;
  gap: number;
}

type Scalar = PredictionRow["actual"];

function scalar(value: unknown): Scalar | undefined {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

function key(value: Scalar): string {
  return value === null ? "null" : String(value);
}

function finiteNumber(value: Scalar | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizedRow(value: unknown): PredictionRow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as { id?: unknown; actual?: unknown; target?: unknown; y?: unknown; predicted?: unknown; prediction?: unknown; pred?: unknown; group?: unknown; subgroup?: unknown; metadata?: unknown; attributes?: unknown };
  const actual = scalar(row.actual ?? row.target ?? row.y);
  const predicted = scalar(row.predicted ?? row.prediction ?? row.pred);
  if (actual === undefined || predicted === undefined) return undefined;
  const rawMetadata = row.metadata ?? row.attributes;
  const metadata = rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
    ? Object.fromEntries(Object.entries(rawMetadata).filter(([, item]) => item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean")) as Record<string, string | number | boolean | null>
    : undefined;
  return {
    ...(typeof row.id === "string" ? { id: row.id } : {}),
    actual,
    predicted,
    ...(typeof (row.group ?? row.subgroup) === "string" ? { group: String(row.group ?? row.subgroup) } : {}),
    ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
  };
}

/** Parse a bounded JSON array/object or JSONL prediction artifact. */
export function parsePredictionRows(value: unknown, limit = 100_000): PredictionRow[] {
  const source = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { predictions?: unknown }).predictions) ? (value as { predictions: unknown[] }).predictions : undefined;
  if (source) return source.slice(0, Math.max(1, limit)).flatMap((entry) => normalizedRow(entry) ? [normalizedRow(entry)!] : []);
  if (typeof value !== "string") return [];
  return value.split(/\r?\n/).slice(0, Math.max(1, limit)).flatMap((line) => {
    if (!line.trim()) return [];
    try { const parsed = JSON.parse(line) as unknown; const row = normalizedRow(parsed); return row ? [row] : []; } catch { return []; }
  });
}

/** Deterministic, bounded error analysis over a prediction artifact. */
export function analyzePredictionRows(rows: PredictionRow[], limit = 20): ErrorAnalysisReport {
  const bounded = rows.slice(0, Math.max(0, Math.min(rows.length, 100_000)));
  const numeric = bounded.length > 0 && bounded.every((row) => finiteNumber(row.actual) && finiteNumber(row.predicted));
  const groups = new Map<string, { total: number; errors: number; absolute: number[] }>();
  const slices = new Map<string, { feature: string; value: string; total: number; errors: number; absolute: number[] }>();
  const calibration = Array.from({ length: 10 }, () => ({ total: 0, predicted: 0, positive: 0 }));
  const confusion = new Map<string, number>();
  let errors = 0;
  let absoluteSum = 0;
  let squareSum = 0;
  for (const row of bounded) {
    const isError = numeric ? (row.actual as number) !== (row.predicted as number) : key(row.actual) !== key(row.predicted);
    const absolute = numeric ? Math.abs((row.predicted as number) - (row.actual as number)) : isError ? 1 : 0;
    if (isError) errors += 1;
    absoluteSum += absolute;
    squareSum += absolute ** 2;
    const group = row.group ?? "__all__";
    const entry = groups.get(group) ?? { total: 0, errors: 0, absolute: [] };
    entry.total += 1;
    if (isError) entry.errors += 1;
    entry.absolute.push(absolute);
    groups.set(group, entry);
    for (const [feature, metadataValue] of Object.entries(row.metadata ?? {})) {
      const sliceValue = key(metadataValue);
      const sliceKey = `${feature}\u001f${sliceValue}`;
      const slice = slices.get(sliceKey) ?? { feature, value: sliceValue, total: 0, errors: 0, absolute: [] };
      slice.total += 1;
      if (isError) slice.errors += 1;
      slice.absolute.push(absolute);
      slices.set(sliceKey, slice);
    }
    if (typeof row.predicted === "number" && Number.isFinite(row.predicted) && row.predicted >= 0 && row.predicted <= 1 && (row.actual === 0 || row.actual === 1 || row.actual === false || row.actual === true)) {
      const bin = Math.min(9, Math.floor(row.predicted * 10));
      calibration[bin].total += 1;
      calibration[bin].predicted += row.predicted;
      calibration[bin].positive += row.actual === 1 || row.actual === true ? 1 : 0;
    }
    if (!numeric) {
      const pair = `${key(row.actual)}\u001f${key(row.predicted)}`;
      confusion.set(pair, (confusion.get(pair) ?? 0) + 1);
    }
  }
  const summaries = [...groups.entries()].filter(([group]) => group !== "__all__").map(([group, value]) => ({ group, total: value.total, errors: value.errors, errorRate: value.errors / value.total, ...(numeric ? { meanAbsoluteError: value.absolute.reduce((sum, item) => sum + item, 0) / value.total } : {}) } satisfies ErrorGroupSummary));
  summaries.sort((left, right) => right.errorRate - left.errorRate || right.total - left.total || left.group.localeCompare(right.group));
  const sliceSummaries = [...slices.values()].map((value) => ({ feature: value.feature, value: value.value, total: value.total, errors: value.errors, errorRate: value.errors / value.total, ...(numeric ? { meanAbsoluteError: value.absolute.reduce((sum, item) => sum + item, 0) / value.total } : {}) } satisfies ErrorSliceSummary));
  sliceSummaries.sort((left, right) => right.errorRate - left.errorRate || right.total - left.total || left.feature.localeCompare(right.feature) || left.value.localeCompare(right.value));
  const calibrationBins = calibration.flatMap((value, bin) => value.total ? [{ bin, total: value.total, meanPredicted: value.predicted / value.total, empiricalRate: value.positive / value.total, gap: Math.abs(value.predicted / value.total - value.positive / value.total) }] : []);
  const report: ErrorAnalysisReport = {
    schemaVersion: 1,
    task: numeric ? "regression" : "classification",
    total: bounded.length,
    errors,
    errorRate: bounded.length ? errors / bounded.length : 0,
    ...(numeric ? { mae: bounded.length ? absoluteSum / bounded.length : 0, rmse: bounded.length ? Math.sqrt(squareSum / bounded.length) : 0 } : { accuracy: bounded.length ? 1 - errors / bounded.length : 0, confusion: [...confusion.entries()].map(([pair, count]) => { const [actual, predicted] = pair.split("\u001f"); return { actual, predicted, count }; }).sort((left, right) => right.count - left.count || left.actual.localeCompare(right.actual)).slice(0, 100) }),
    groups: summaries.slice(0, Math.max(0, limit)),
    worstGroups: summaries.slice(0, Math.max(0, limit)),
    slices: sliceSummaries.slice(0, Math.max(0, limit * 4)),
    worstSlices: sliceSummaries.slice(0, Math.max(0, limit)),
    ...(calibrationBins.length ? { calibration: calibrationBins } : {}),
  };
  return report;
}

/** Compare two prediction artifacts by stable row id or aligned row position. */
export function comparePredictionRows(baseline: PredictionRow[], candidate: PredictionRow[], limit = 20): PredictionComparison {
  const baselineById = new Map(baseline.filter((row) => row.id).map((row) => [row.id!, row]));
  const pairs = candidate.flatMap((row, index) => {
    const prior = row.id ? baselineById.get(row.id) : baseline[index];
    return prior ? [{ prior, row }] : [];
  });
  const isError = (row: PredictionRow): boolean => key(row.actual) !== key(row.predicted);
  const groupStats = new Map<string, { fixed: number; regressed: number }>();
  let fixed = 0; let regressed = 0; let unchangedErrors = 0;
  for (const { prior, row } of pairs) {
    const wasError = isError(prior); const isNowError = isError(row);
    const group = row.group ?? prior.group ?? "__all__";
    const stats = groupStats.get(group) ?? { fixed: 0, regressed: 0 };
    if (wasError && !isNowError) { fixed += 1; stats.fixed += 1; }
    else if (!wasError && isNowError) { regressed += 1; stats.regressed += 1; }
    else if (wasError) unchangedErrors += 1;
    groupStats.set(group, stats);
  }
  return {
    matched: pairs.length,
    fixed,
    regressed,
    unchangedErrors,
    groups: [...groupStats.entries()].filter(([group]) => group !== "__all__").map(([group, stats]) => ({ group, ...stats, net: stats.fixed - stats.regressed })).sort((left, right) => right.net - left.net || left.group.localeCompare(right.group)).slice(0, Math.max(0, limit)),
  };
}
