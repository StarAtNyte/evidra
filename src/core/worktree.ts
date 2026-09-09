import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "./process.js";

export async function ensureWorktree(repoPath: string, rootPath: string, id: string): Promise<string> {
  const worktreePath = join(rootPath, ".sota", "worktrees", id);
  if (existsSync(join(worktreePath, "estimator.py"))) return worktreePath;
  mkdirSync(join(rootPath, ".sota", "worktrees"), { recursive: true });
  const result = await runProcess(["git", "worktree", "add", "--detach", worktreePath, "HEAD"], repoPath);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to create experiment worktree: ${result.stderr || result.stdout}`);
  }
  return worktreePath;
}
