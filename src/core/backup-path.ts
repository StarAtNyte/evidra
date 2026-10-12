import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** Interactive backups stay inside the workspace; configured startup volumes are separate. */
export function workspaceBackupDestination(root: string, destination: string, liveDatabase: string): string {
  const workspace = resolve(root), target = resolve(workspace, destination);
  const within = (base: string, path: string): boolean => {
    const result = relative(base, path);
    return result !== ".." && !result.startsWith("../") && !result.startsWith("..\\") && !isAbsolute(result);
  };
  if (target === resolve(liveDatabase) || target === workspace || !within(workspace, target)) throw new Error("Backup destination must be inside the Evidra workspace and must not overwrite the live database.");
  let ancestor = dirname(target);
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  if (!within(realpathSync(workspace), realpathSync(ancestor))) throw new Error("Backup destination parent resolves outside the Evidra workspace.");
  return target;
}
