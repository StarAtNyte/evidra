import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface DataAuditReport {
  root: string;
  scannedFiles: number;
  totalBytes: number;
  duplicateGroups: Array<{ checksum: string; files: string[] }>;
  tabularDiagnostics: Array<{ file: string; rows: number; columns: number; duplicateRows: number; constantColumns: string[]; highMissingColumns: string[] }>;
  skippedFiles: string[];
  warnings: string[];
  generatedAt: string;
}

const IGNORED = new Set([".git", ".venv", "node_modules", ".sota", "__pycache__"]);
const TABULAR_EXTENSIONS = new Set([".csv", ".tsv", ".jsonl"]);

function tabularDiagnostic(root: string, path: string, maxRows = 50_000): DataAuditReport["tabularDiagnostics"][number] | undefined {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (!TABULAR_EXTENSIONS.has(extension)) return undefined;
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, maxRows + 1);
  if (lines.length < 2) return { file: relative(root, path), rows: 0, columns: 0, duplicateRows: 0, constantColumns: [], highMissingColumns: [] };
  if (extension === ".jsonl") {
    const records = lines.slice(0, maxRows).map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return {}; } });
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
    return { file: relative(root, path), rows: records.length, columns: headers.length, duplicateRows: records.length - rows.size, constantColumns: headers.filter((header) => (counts.get(header)?.size ?? 0) <= 1), highMissingColumns: headers.filter((header) => (missing.get(header) ?? 0) / Math.max(1, records.length) >= 0.5) };
  }
  const delimiter = extension === ".tsv" ? "\t" : ",";
  const header = lines[0].split(delimiter).map((value) => value.trim());
  const rows = lines.slice(1, maxRows + 1).map((line) => line.split(delimiter));
  const values = header.map((_, index) => new Set(rows.map((row) => row[index] ?? "")));
  const missing = header.map((_, index) => rows.filter((row) => !row[index]?.trim()).length);
  const duplicateRows = rows.length - new Set(rows.map((row) => row.join("\u001f"))).size;
  return { file: relative(root, path), rows: rows.length, columns: header.length, duplicateRows, constantColumns: header.filter((_, index) => values[index].size <= 1), highMissingColumns: header.filter((_, index) => missing[index] / Math.max(1, rows.length) >= 0.5) };
}

export function auditData(root: string, maxFiles = 2000, maxFileBytes = 50 * 1024 * 1024): DataAuditReport {
  const checksums = new Map<string, string[]>();
  const skippedFiles: string[] = [];
  const tabularDiagnostics: DataAuditReport["tabularDiagnostics"] = [];
  let scannedFiles = 0;
  let totalBytes = 0;

  const visit = (directory: string): void => {
    if (!existsSync(directory) || scannedFiles >= maxFiles) return;
    for (const name of readdirSync(directory)) {
      if (IGNORED.has(name)) continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) { visit(path); continue; }
      if (!stat.isFile()) continue;
      if (scannedFiles >= maxFiles || stat.size > maxFileBytes) {
        skippedFiles.push(relative(root, path));
        continue;
      }
      const checksum = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
      const files = checksums.get(checksum) ?? [];
      files.push(relative(root, path));
      checksums.set(checksum, files);
      scannedFiles += 1;
      totalBytes += stat.size;
      try { const diagnostic = tabularDiagnostic(root, path); if (diagnostic) tabularDiagnostics.push(diagnostic); } catch { /* malformed tabular files remain ordinary scanned files */ }
    }
  };
  visit(root);
  const duplicateGroups = [...checksums.entries()].filter(([, files]) => files.length > 1).map(([checksum, files]) => ({ checksum, files }));
  const warnings = [
    ...(duplicateGroups.length ? [`${duplicateGroups.length} exact duplicate file group(s) detected; ensure split policy keeps duplicates together.`] : []),
    ...(skippedFiles.length ? [`${skippedFiles.length} file(s) skipped due to audit limits.`] : []),
    ...(tabularDiagnostics.some((diagnostic) => diagnostic.duplicateRows > 0) ? ["Duplicate rows detected in tabular files; use group-aware or duplicate-component splits."] : []),
    ...(tabularDiagnostics.some((diagnostic) => diagnostic.constantColumns.length > 0) ? ["Constant tabular columns detected; verify they are not artifacts or unusable identifiers."] : []),
    ...(tabularDiagnostics.some((diagnostic) => diagnostic.highMissingColumns.length > 0) ? ["High-missingness tabular columns detected; inspect train/test missingness before modeling."] : []),
  ];
  return { root, scannedFiles, totalBytes, duplicateGroups, tabularDiagnostics, skippedFiles, warnings, generatedAt: new Date().toISOString() };
}
