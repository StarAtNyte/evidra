import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runProcess } from "./process.js";

export function worktreeBasePath(rootPath: string, configuredBase = process.env.EVIDRA_WORKTREE_ROOT): string {
  return resolve(configuredBase?.trim() || join(rootPath, ".sota", "worktrees"));
}

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

export async function ensureWorktree(repoPath: string, rootPath: string, id: string): Promise<string> {
  if (!/^[a-zA-Z0-9_.-]{1,160}$/.test(id) || id === "." || id === "..") throw new Error("Worktree id must be a bounded path-safe identifier.");
  const basePath = worktreeBasePath(rootPath);
  mkdirSync(basePath, { recursive: true });
  const checkedBase = realpathSync(basePath);
  if (checkedBase !== basePath || checkedBase === resolve(rootPath)) throw new Error("Configured worktree root must resolve directly and must not be the project root.");
  const worktreePath = join(checkedBase, id);
  if (!isInside(checkedBase, worktreePath)) throw new Error("Worktree path escapes its configured root.");
  // A worktree is a Git concept, not a competition-specific Python layout.
  // Checking for estimator.py made every non-WhestBench project appear stale.
  if (existsSync(join(worktreePath, ".git"))) return worktreePath;
  const result = await runProcess(["git", "worktree", "add", "--detach", worktreePath, "HEAD"], repoPath);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to create experiment worktree: ${result.stderr || result.stdout}`);
  }
  return worktreePath;
}
