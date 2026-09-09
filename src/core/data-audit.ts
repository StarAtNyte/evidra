import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface DataAuditReport {
  root: string;
  scannedFiles: number;
  totalBytes: number;
  duplicateGroups: Array<{ checksum: string; files: string[] }>;
  skippedFiles: string[];
  warnings: string[];
  generatedAt: string;
}

const IGNORED = new Set([".git", ".venv", "node_modules", ".sota", "__pycache__"]);

export function auditData(root: string, maxFiles = 2000, maxFileBytes = 50 * 1024 * 1024): DataAuditReport {
  const checksums = new Map<string, string[]>();
  const skippedFiles: string[] = [];
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
    }
  };
  visit(root);
  const duplicateGroups = [...checksums.entries()].filter(([, files]) => files.length > 1).map(([checksum, files]) => ({ checksum, files }));
  const warnings = [
    ...(duplicateGroups.length ? [`${duplicateGroups.length} exact duplicate file group(s) detected; ensure split policy keeps duplicates together.`] : []),
    ...(skippedFiles.length ? [`${skippedFiles.length} file(s) skipped due to audit limits.`] : []),
  ];
  return { root, scannedFiles, totalBytes, duplicateGroups, skippedFiles, warnings, generatedAt: new Date().toISOString() };
}
