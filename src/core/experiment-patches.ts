import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "./process.js";

/** Extract a unified diff from a local engineer response without trusting prose. */
export function extractUnifiedDiff(output: string): string | undefined {
  const fenced = output.match(/```(?:diff|patch)?\s*\n([\s\S]*?)```/i)?.[1]?.trim();
  const text = fenced || output.trim();
  const start = text.indexOf("diff --git ");
  if (start >= 0) return text.slice(start).trim();
  const header = text.search(/^--- (?:a\/|\/dev\/null)/m);
  if (header >= 0 && /^\+\+\+ /m.test(text.slice(header))) return text.slice(header).trim();
  return undefined;
}

/** Validate and apply a local-model diff only inside an isolated worktree. */
export async function applyUnifiedDiff(worktree: string, diff: string): Promise<void> {
  const patchPath = join(worktree, ".evidra-local-engineer.diff");
  writeFileSync(patchPath, `${diff.trim()}\n`);
  try {
    const check = await runProcess(["git", "apply", "--check", patchPath], worktree, 60_000);
    if (check.exitCode !== 0) throw new Error(`Local engineer patch failed validation: ${check.stderr || check.stdout}`);
    const applied = await runProcess(["git", "apply", "--whitespace=nowarn", patchPath], worktree, 60_000);
    if (applied.exitCode !== 0) throw new Error(`Local engineer patch could not be applied: ${applied.stderr || applied.stdout}`);
  } finally {
    try { unlinkSync(patchPath); } catch { /* patch cleanup is best effort */ }
  }
}
