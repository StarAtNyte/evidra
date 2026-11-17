import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

export interface DataAuditReport {
  root: string;
  scannedFiles: number;
  totalBytes: number;
  duplicateGroups: Array<{ checksum: string; files: string[] }>;
  tabularDiagnostics: Array<{ file: string; rows: number; columns: number; duplicateRows: number; constantColumns: string[]; highMissingColumns: string[]; columnProfiles: Record<string, { missingRate: number; uniqueValues: number; sample: string[] }> }>;
  distributionShift: Array<{ trainFile: string; testFile: string; shiftedColumns: string[] }>;
  skippedFiles: string[];
  /** Dataset-like files whose bytes were counted/hashed but whose contents were not parsed. */
  uninspectedDataFiles: Array<{ file: string; format: string; reason: string }>;
  /** Non-tabular JSON documents (configuration, metadata) that were parsed but hold no records. */
  metadataFiles: string[];
  /** Evidra/workspace manifests and state that are not dataset inputs and were not audited. */
  excludedFiles: string[];
  /** Blocking integrity findings: duplicates, leakage, or distribution shift. */
  warnings: string[];
  /** Informational coverage and quality notes; these never block a phase gate by themselves. */
  notes: string[];
  /** Report schema version; campaigns re-audit instead of reusing an older report. */
  auditVersion: number;
  generatedAt: string;
}

/** Stable identity for the findings in an audit, excluding its generation time. */
export function dataAuditFingerprint(report: DataAuditReport): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ duplicateGroups: report.duplicateGroups, tabularDiagnostics: report.tabularDiagnostics, distributionShift: report.distributionShift, skippedFiles: report.skippedFiles, uninspectedDataFiles: report.uninspectedDataFiles, warnings: report.warnings })).digest("hex")}`;
}

/** Bump when report semantics change so cached campaign audits are recomputed. */
export const DATA_AUDIT_VERSION = 2;

const IGNORED = new Set([".git", ".venv", "node_modules", ".sota", ".evidra", "__pycache__"]);
const TABULAR_EXTENSIONS = new Set([".csv", ".tsv", ".jsonl", ".ndjson", ".json"]);
// Evidra's own workspace manifests and policy files describe the task; they
// are not dataset inputs and must not be audited (or duplicate-matched) as data.
const WORKSPACE_MANIFEST_FILES = new Set(["competition.json", "validation-policy.json", "validation-policy.lock.json"]);

export interface DataAuditOptions {
  /** Additional absolute directories (for example the Evidra state directory) to leave out of the audit. */
  excludeDirectories?: string[];
}

function excludedDirectory(path: string, options: DataAuditOptions): boolean {
  const target = resolve(path);
  return (options.excludeDirectories ?? []).some((directory) => {
    const excluded = resolve(directory);
    return target === excluded || target.startsWith(`${excluded}${sep}`);
  });
}

function workspaceManifest(path: string): boolean {
  return WORKSPACE_MANIFEST_FILES.has(basename(path).toLowerCase());
}
const UNINSPECTED_DATA_FORMATS: Record<string, string> = {
  ".parquet": "Parquet", ".feather": "Feather", ".arrow": "Arrow", ".avro": "Avro", ".orc": "ORC",
  ".xlsx": "Excel", ".xls": "Excel", ".json": "JSON", ".ndjson": "NDJSON",
  ".sqlite": "SQLite", ".db": "database", ".npy": "NumPy", ".npz": "NumPy archive",
  ".h5": "HDF5", ".hdf5": "HDF5", ".pt": "PyTorch", ".pth": "PyTorch", ".tfrecord": "TFRecord",
};

/**
 * Cheap identity for the auditable file set. Campaigns use this to reuse an
 * unchanged audit instead of hashing/parsing the same inputs on every cycle.
 * Size, timestamps, and filesystem identity detect normal replacement and
 * edits without reading large dataset contents again.
 */
export function dataAuditManifestFingerprint(root: string, maxFiles = 2000, options: DataAuditOptions = {}): string {
  const entries: string[] = [];
  const limit = Number.isFinite(maxFiles) ? Math.max(0, Math.min(100_000, Math.floor(maxFiles))) : 2000;
  const visit = (directory: string): void => {
    if (!existsSync(directory) || entries.length >= limit) return;
    let names: string[];
    try { names = readdirSync(directory).sort(); } catch { return; }
    for (const name of names) {
      if (IGNORED.has(name)) continue;
      const path = join(directory, name);
      let stat;
      try { stat = lstatSync(path); } catch { continue; }
      if (stat.isDirectory()) { if (!excludedDirectory(path, options)) visit(path); continue; }
      if (!stat.isFile() || workspaceManifest(path)) continue;
      entries.push(`${relative(root, path)}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.dev}\0${stat.ino}`);
      if (entries.length >= limit) break;
    }
  };
  visit(root);
  return `sha256:${createHash("sha256").update(entries.join("\n")).digest("hex")}`;
}

/** Parse RFC-4180-style delimited text without loading an unbounded number of rows. */
function parseDelimited(text: string, delimiter: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let reachedLimit = false;

  const finishField = (): void => {
    row.push(field);
    field = "";
  };
  const finishRow = (): void => {
    finishField();
    if (row.some((value) => value.length > 0)) rows.push(row);
    row = [];
    if (rows.length >= maxRows) reachedLimit = true;
  };

  for (let index = 0; index < text.length && !reachedLimit; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      finishField();
    } else if (character === "\n") {
      finishRow();
    } else if (character === "\r") {
      if (text[index + 1] === "\n") index += 1;
      finishRow();
    } else {
      field += character;
    }
  }
  if (!reachedLimit && (row.length > 0 || field.length > 0)) finishRow();
  return rows;
}

type TabularDiagnostic = DataAuditReport["tabularDiagnostics"][number];

function emptyDiagnostic(file: string): TabularDiagnostic {
  return { file, rows: 0, columns: 0, duplicateRows: 0, constantColumns: [], highMissingColumns: [], columnProfiles: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Apply the same duplicate/constant/missingness diagnostics as CSV to parsed JSON records. */
function recordDiagnostic(file: string, records: Array<Record<string, unknown>>): TabularDiagnostic {
  if (records.length === 0) return emptyDiagnostic(file);
  const headers = [...new Set(records.flatMap((record) => Object.keys(record)))];
  const counts = new Map<string, Set<string>>();
  const missing = new Map<string, number>();
  const rows = new Set<string>();
  for (const record of records) {
    rows.add(JSON.stringify(record));
    for (const header of headers) {
      const value = record[header];
      if (value === undefined || value === null || value === "") missing.set(header, (missing.get(header) ?? 0) + 1);
      else {
        const values = counts.get(header) ?? new Set<string>();
        values.add(JSON.stringify(value));
        counts.set(header, values);
      }
    }
  }
  return { file, rows: records.length, columns: headers.length, duplicateRows: records.length - rows.size, constantColumns: headers.filter((header) => (counts.get(header)?.size ?? 0) <= 1), highMissingColumns: headers.filter((header) => (missing.get(header) ?? 0) / Math.max(1, records.length) >= 0.5), columnProfiles: Object.fromEntries(headers.map((header) => [header, { missingRate: (missing.get(header) ?? 0) / Math.max(1, records.length), uniqueValues: counts.get(header)?.size ?? 0, sample: [...(counts.get(header) ?? new Set<string>())].slice(0, 20) }])) };
}

type ContentInspection =
  | { kind: "tabular"; diagnostic: TabularDiagnostic }
  | { kind: "metadata" }
  | { kind: "unparsed"; reason: string };

function inspectContent(root: string, path: string, maxRows = 50_000): ContentInspection | undefined {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (!TABULAR_EXTENSIONS.has(extension)) return undefined;
  const file = relative(root, path);
  const text = readFileSync(path, "utf8");
  if (extension === ".json") {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (error) {
      // A JSON file may still be line-delimited records under a .json name.
      const lines = text.split(/\r?\n/).filter((line) => line.trim());
      const records = lines.slice(0, maxRows).map((line) => { try { return JSON.parse(line) as unknown; } catch { return undefined; } });
      if (lines.length > 1 && records.every(isRecord)) return { kind: "tabular", diagnostic: recordDiagnostic(file, records) };
      return { kind: "unparsed", reason: `JSON parse failed (${error instanceof Error ? error.message.slice(0, 120) : "invalid JSON"}); only file metadata and checksum were inspected` };
    }
    // Arrays of records are datasets; any other document (objects, scalars,
    // arrays of scalars) is configuration or metadata rather than rows.
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isRecord)) return { kind: "tabular", diagnostic: recordDiagnostic(file, parsed.slice(0, maxRows)) };
    return { kind: "metadata" };
  }
  if (extension === ".jsonl" || extension === ".ndjson") {
    const lines = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, maxRows);
    const records = lines.map((line) => { try { const value = JSON.parse(line) as unknown; return isRecord(value) ? value : {}; } catch { return {}; } });
    return { kind: "tabular", diagnostic: recordDiagnostic(file, records) };
  }
  const delimiter = extension === ".tsv" ? "\t" : ",";
  const parsed = parseDelimited(text, delimiter, maxRows + 1);
  if (parsed.length < 2) return { kind: "tabular", diagnostic: emptyDiagnostic(file) };
  const header = parsed[0].map((value) => value.trim());
  const rows = parsed.slice(1, maxRows + 1);
  const values = header.map((_, index) => new Set(rows.map((row) => row[index] ?? "")));
  const missing = header.map((_, index) => rows.filter((row) => !row[index]?.trim()).length);
  const duplicateRows = rows.length - new Set(rows.map((row) => row.join("\u001f"))).size;
  return { kind: "tabular", diagnostic: { file, rows: rows.length, columns: header.length, duplicateRows, constantColumns: header.filter((_, index) => values[index].size <= 1), highMissingColumns: header.filter((_, index) => missing[index] / Math.max(1, rows.length) >= 0.5), columnProfiles: Object.fromEntries(header.map((name, index) => [name, { missingRate: missing[index] / Math.max(1, rows.length), uniqueValues: values[index].size, sample: [...values[index]].filter(Boolean).slice(0, 20) }])) } };
}

export function auditData(root: string, maxFiles = 2000, maxFileBytes = 50 * 1024 * 1024, options: DataAuditOptions = {}): DataAuditReport {
  const checksums = new Map<string, string[]>();
  const skippedFiles: string[] = [];
  const metadataFiles: string[] = [];
  const excludedFiles: string[] = [];
  const uninspectedDataFiles: DataAuditReport["uninspectedDataFiles"] = [];
  const tabularDiagnostics: DataAuditReport["tabularDiagnostics"] = [];
  let scannedFiles = 0;
  let totalBytes = 0;

  const visit = (directory: string): void => {
    if (!existsSync(directory) || scannedFiles >= maxFiles) return;
    for (const name of readdirSync(directory)) {
      if (IGNORED.has(name)) continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        if (excludedDirectory(path, options)) excludedFiles.push(`${relative(root, path)}/`);
        else visit(path);
        continue;
      }
      if (!stat.isFile()) continue;
      if (workspaceManifest(path)) { excludedFiles.push(relative(root, path)); continue; }
      if (scannedFiles >= maxFiles || stat.size > maxFileBytes) {
        skippedFiles.push(relative(root, path));
        const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
        const format = UNINSPECTED_DATA_FORMATS[extension];
        if (format) uninspectedDataFiles.push({
          file: relative(root, path),
          format,
          reason: stat.size > maxFileBytes
            ? `file size ${stat.size} exceeds the ${maxFileBytes}-byte audit limit; content and checksum were not inspected`
            : `audit file-count limit (${maxFiles}) reached before this file was inspected`,
        });
        continue;
      }
      const checksum = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
      const files = checksums.get(checksum) ?? [];
      files.push(relative(root, path));
      checksums.set(checksum, files);
      scannedFiles += 1;
      totalBytes += stat.size;
      const inspection = inspectContent(root, path);
      if (inspection?.kind === "tabular") tabularDiagnostics.push(inspection.diagnostic);
      else if (inspection?.kind === "metadata") metadataFiles.push(relative(root, path));
      else if (inspection?.kind === "unparsed") uninspectedDataFiles.push({ file: relative(root, path), format: UNINSPECTED_DATA_FORMATS[path.slice(path.lastIndexOf(".")).toLowerCase()] ?? "JSON", reason: inspection.reason });
      else {
        const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
        const format = UNINSPECTED_DATA_FORMATS[extension];
        if (format) uninspectedDataFiles.push({ file: relative(root, path), format, reason: "content parser unavailable; only file metadata and checksum were inspected" });
      }
    }
  };
  visit(root);
  const duplicateGroups = [...checksums.entries()].filter(([, files]) => files.length > 1).map(([checksum, files]) => ({ checksum, files }));
  const distributionShift: DataAuditReport["distributionShift"] = [];
  for (const train of tabularDiagnostics.filter((entry) => /(^|[._/-])train(ing)?([._/-]|$)/i.test(entry.file))) {
    const expectedTest = train.file.replace(/train(ing)?/i, "test");
    const test = tabularDiagnostics.find((entry) => entry.file === expectedTest);
    if (!test) continue;
    const shiftedColumns = Object.keys(train.columnProfiles).filter((column) => {
      const trainProfile = train.columnProfiles[column];
      const testProfile = test.columnProfiles[column];
      if (!testProfile) return true;
      const sampleOverlap = new Set(trainProfile.sample).size ? testProfile.sample.filter((value) => trainProfile.sample.includes(value)).length / Math.max(1, new Set(testProfile.sample).size) : 0;
      return Math.abs(trainProfile.missingRate - testProfile.missingRate) >= 0.25 || (trainProfile.sample.length > 0 && testProfile.sample.length > 0 && sampleOverlap < 0.25);
    });
    if (shiftedColumns.length) distributionShift.push({ trainFile: train.file, testFile: test.file, shiftedColumns });
  }
  // Blocking findings are integrity problems an operator must resolve or
  // explicitly accept. Coverage gaps and column-quality observations are
  // informational: they never establish leakage and must not stall a gate.
  const warnings = [
    ...(duplicateGroups.length ? [`${duplicateGroups.length} exact duplicate file group(s) detected; ensure split policy keeps duplicates together.`] : []),
    ...(tabularDiagnostics.some((diagnostic) => diagnostic.duplicateRows > 0) ? ["Duplicate rows detected in tabular files; use group-aware or duplicate-component splits."] : []),
    ...(distributionShift.length ? [`Candidate train/test distribution shift detected in ${distributionShift.length} file pair(s); validate by group, source, or time before trusting random splits.`] : []),
  ];
  const notes = [
    ...(skippedFiles.length ? [`${skippedFiles.length} file(s) skipped due to audit limits.`] : []),
    ...(uninspectedDataFiles.length ? [`${uninspectedDataFiles.length} dataset file(s) were not content-inspected (${[...new Set(uninspectedDataFiles.map((entry) => entry.format))].join(", ")}); empty tabular diagnostics do not establish absence of duplicates, leakage, or distribution shift.`] : []),
    ...(metadataFiles.length ? [`${metadataFiles.length} JSON file(s) hold no records and were classified as metadata.`] : []),
    ...(tabularDiagnostics.some((diagnostic) => diagnostic.constantColumns.length > 0) ? ["Constant tabular columns detected; verify they are not artifacts or unusable identifiers."] : []),
    ...(tabularDiagnostics.some((diagnostic) => diagnostic.highMissingColumns.length > 0) ? ["High-missingness tabular columns detected; inspect train/test missingness before modeling."] : []),
  ];
  return { root, scannedFiles, totalBytes, duplicateGroups, tabularDiagnostics, distributionShift, skippedFiles, uninspectedDataFiles, metadataFiles, excludedFiles, warnings, notes, auditVersion: DATA_AUDIT_VERSION, generatedAt: new Date().toISOString() };
}
