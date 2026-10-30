import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function isProjectMarker(directory: string): boolean {
  return existsSync(join(directory, "details.md")) || existsSync(join(directory, ".sota")) || existsSync(join(directory, "competition.json"));
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * An ancestor project owns a nested directory only when that directory is part
 * of the project: its state, its competitions tree, or a declared competition
 * workspace. An unrelated folder that merely sits below a project (for example
 * a new project under a `$HOME` that holds another campaign) is not adopted.
 */
function ancestorOwns(ancestor: string, start: string): boolean {
  if (isWithin(join(ancestor, ".sota"), start) || isWithin(join(ancestor, "competitions"), start)) return true;
  let competitions: string[] = [];
  try { competitions = readdirSync(join(ancestor, "competitions")); } catch { return false; }
  for (const id of competitions) {
    try {
      const manifest = JSON.parse(readFileSync(join(ancestor, "competitions", id, "competition.json"), "utf8")) as { workspacePath?: unknown };
      if (typeof manifest.workspacePath === "string" && manifest.workspacePath.trim() && isWithin(resolve(ancestor, manifest.workspacePath), start)) return true;
    } catch { /* not a competition manifest */ }
  }
  return false;
}

/**
 * Find the Evidra project root. The launch directory is the root when it is
 * marked as a project or not owned by an ancestor project; nested invocations
 * inside a project's own workspace inherit that project's state.
 */
export function findWorkspaceRoot(start = process.cwd()): string {
  const explicitlySelected = process.env.EVIDRA_WORKSPACE_ROOT?.trim();
  if (explicitlySelected) return resolve(explicitlySelected);
  const startingDirectory = resolve(start);
  if (isProjectMarker(startingDirectory)) return startingDirectory;
  let cursor = dirname(startingDirectory);
  while (true) {
    if (isProjectMarker(cursor) && ancestorOwns(cursor, startingDirectory)) return cursor;
    const packagePath = join(cursor, "package.json");
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
