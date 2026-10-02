/**
 * Extract a candidate relative source path from a model-proposed change.
 *
 * This is intentionally syntax-agnostic: Evidra supports research workspaces
 * written in Python, TypeScript, Rust, or any other language.  The returned
 * path is only a hint; execution still happens inside an isolated worktree
 * and the manifest/evaluator contract remains authoritative.
 */
export function candidateChangePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  // The change description can mention datasets (for example `valid.parquet`)
  // before it names the source being edited. Only source-code paths can be
  // passed to an evaluator's `--estimator` argument.
  const sourceExtensions = new Set([
    ".py", ".pyi", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
    ".rs", ".go", ".java", ".kt", ".kts", ".scala", ".c", ".cc", ".cpp", ".h", ".hh",
    ".hpp", ".cs", ".rb", ".php", ".swift", ".sh",
  ]);
  const tokenPattern = /(?:\.\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9_-]+/g;
  for (const match of value.matchAll(tokenPattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    const before = value[start - 1];
    const after = value[start + token.length];
    // Do not accept a path fragment inside a URL, absolute path, or larger
    // identifier. Punctuation used to quote or end a sentence is allowed.
    if (before && /[A-Za-z0-9_./-]/.test(before)) continue;
    if (after && /[A-Za-z0-9_/-]/.test(after)) continue;
    const normalized = token.replace(/^\.\//, "");
    // Numeric literals such as `0.5` are common in hypotheses and must never
    // be interpreted as candidate file paths.
    if (/^\d+(?:\.\d+)?$/.test(normalized)) continue;
    const extension = normalized.slice(normalized.lastIndexOf(".")).toLowerCase();
    if (!sourceExtensions.has(extension)) continue;
    const parts = normalized.split("/");
    if (!normalized || parts.some((part) => !part || part === "." || part === "..")) continue;
    return normalized;
  }
  return undefined;
}
