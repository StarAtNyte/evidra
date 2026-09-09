import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Find the Evidra project root when the CLI is launched from a nested
 * competition or starter-kit directory. A caller may still operate on an
 * uninitialised directory; in that case the starting directory is retained.
 */
export function findWorkspaceRoot(start = process.cwd()): string {
  let cursor = resolve(start);
  while (true) {
    const packagePath = join(cursor, "package.json");
    if (existsSync(join(cursor, "details.md")) || existsSync(join(cursor, ".sota"))) return cursor;
    if (existsSync(packagePath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown };
        if (packageJson.name === "evidra") return cursor;
      } catch {
        // Keep walking; a malformed package belongs to the caller to report.
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(start);
    cursor = parent;
  }
}
