import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "./process.js";

export async function ensureWorktree(repoPath: string, rootPath: string, id: string): Promise<string> {
  const worktreePath = join(rootPath, ".sota", "worktrees", id);
  // A worktree is a Git concept, not a competition-specific Python layout.
  // Checking for estimator.py made every non-WhestBench project appear stale.
  if (existsSync(join(worktreePath, ".git"))) return worktreePath;
  mkdirSync(join(rootPath, ".sota", "worktrees"), { recursive: true });
  const result = await runProcess(["git", "worktree", "add", "--detach", worktreePath, "HEAD"], repoPath);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to create experiment worktree: ${result.stderr || result.stdout}`);
  }
  return worktreePath;
}
