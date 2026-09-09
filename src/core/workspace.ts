import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Find the Evidra project root when the CLI is launched from a nested
 * competition or starter-kit directory. A caller may still operate on an
 * uninitialised directory; in that case the starting directory is retained.
 */
export function findWorkspaceRoot(start = process.cwd()): string {
  const startingDirectory = resolve(start);
  let cursor = startingDirectory;
  while (true) {
    const packagePath = join(cursor, "package.json");
    // A project-local marker is authoritative only at the directory where the
    // user launched Evidra. Never adopt an unrelated `.sota` directory from a
    // parent such as `$HOME`; that silently redirects state and experiments.
    if (cursor === startingDirectory && (existsSync(join(cursor, "details.md")) || existsSync(join(cursor, ".sota")) || existsSync(join(cursor, "competition.json")))) return cursor;
    // Nested invocations inside an initialized Evidra project still inherit
    // that project's state directory. The launch-directory check above keeps
    // a standalone challenge manifest from being redirected to an unrelated
    // parent state directory.
    if (existsSync(join(cursor, "details.md")) || (cursor !== startingDirectory && existsSync(join(cursor, ".sota")))) return cursor;
    if (existsSync(packagePath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown };
        if (packageJson.name === "evidra") return cursor;
      } catch {
        // Keep walking; a malformed package belongs to the caller to report.
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) return startingDirectory;
    cursor = parent;
  }
}
