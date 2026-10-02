import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";

export interface IntegritySnapshot {
  files: Record<string, string>;
}

/** Fingerprint evaluator/config files while ignoring output arguments and declared candidate files. */
export function captureProtectedFiles(cwd: string, commands: string[][], extraPaths: string[] = [], ignorePaths: string[] = []): IntegritySnapshot {
  const paths = new Set<string>();
  const ignored = new Set(ignorePaths.map((path) => resolve(cwd, path)));
  for (const command of commands) {
    for (const token of command.slice(1)) {
      const candidate = resolve(cwd, token);
      if (!ignored.has(candidate) && existsSync(candidate) && statSync(candidate).isFile() && /\.(py|js|ts|sh|json|ya?ml|toml|ini|cfg)$/i.test(candidate)) paths.add(candidate);
    }
  }
  for (const path of extraPaths) {
    const candidate = resolve(cwd, path);
    if (!ignored.has(candidate) && existsSync(candidate) && statSync(candidate).isFile()) paths.add(candidate);
  }
  return { files: Object.fromEntries([...paths].sort().map((path) => [relative(cwd, path), hash(path)])) };
}

export function changedProtectedFiles(snapshot: IntegritySnapshot, cwd: string): string[] {
  return Object.entries(snapshot.files).filter(([path, checksum]) => {
    const absolute = resolve(cwd, path);
    return !existsSync(absolute) || hash(absolute) !== checksum;
  }).map(([path]) => path);
}

function hash(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}
