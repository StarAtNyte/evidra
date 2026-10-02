import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { sha256File } from "./evidence.js";

export type ImplementationSnapshot = { worktree: string; files: Record<string, string> };
export type PinnedImplementationArtifact = { path: string; sha256: string; targetPath: string };

/** Copy an existing workspace implementation into a candidate only when its declared hash matches. */
export function seedImplementationSource(workspace: string, targetPath: string, sourceRelativePath: string, expectedSha256: string): { sourcePath: string; sourceSha256: string; targetPath: string } {
  const root = realpathSync(workspace);
  const sourceCandidate = resolve(root, sourceRelativePath);
  const sourceFromRoot = relative(root, sourceCandidate);
  if (isAbsolute(sourceFromRoot) || sourceFromRoot === ".." || sourceFromRoot.startsWith(`..${sep}`)) throw new Error(`Implementation seed escapes the workspace: ${sourceRelativePath}`);
  if (!existsSync(sourceCandidate)) throw new Error(`Implementation seed does not exist: ${sourceRelativePath}`);
  const sourcePath = realpathSync(sourceCandidate);
  const realSourceFromRoot = relative(root, sourcePath);
  if (isAbsolute(realSourceFromRoot) || realSourceFromRoot === ".." || realSourceFromRoot.startsWith(`..${sep}`)) throw new Error(`Implementation seed resolves outside the workspace: ${sourceRelativePath}`);
  const sourceStat = statSync(sourcePath);
  if (!sourceStat.isFile() || sourceStat.size > 2_000_000) throw new Error("Implementation seed must be a regular file no larger than 2 MB.");
  const sourceSha256 = sha256File(sourcePath);
  const expectedDigest = expectedSha256.replace(/^sha256:/i, "");
  const sourceDigest = sourceSha256.replace(/^sha256:/i, "");
  if (!/^[a-f0-9]{64}$/i.test(expectedDigest) || sourceDigest.toLowerCase() !== expectedDigest.toLowerCase()) throw new Error(`Implementation seed checksum mismatch for ${sourceRelativePath}.`);
  if (!existsSync(targetPath) || !statSync(targetPath).isFile()) throw new Error("Implementation seed target must be an existing regular file in the candidate worktree.");
  const targetRealPath = realpathSync(targetPath);
  copyFileSync(sourcePath, targetRealPath);
  if (sha256File(targetRealPath) !== sourceSha256) throw new Error("Implementation seed copy failed checksum verification.");
  return { sourcePath, sourceSha256, targetPath: targetRealPath };
}

/** Stage small, immutable implementation inputs into an isolated adapter workspace. */
export function seedImplementationArtifacts(
  projectRoot: string,
  worktree: string,
  workspaceRelativePath: string,
  artifacts: PinnedImplementationArtifact[],
): Array<{ sourcePath: string; sourceSha256: string; targetPath: string }> {
  if (artifacts.length > 8) throw new Error("At most eight implementation artifacts may be staged per experiment.");
  const project = realpathSync(projectRoot);
  const staged: Array<{ sourcePath: string; sourceSha256: string; targetPath: string }> = [];
  const targets = new Set<string>();
  let totalBytes = 0;
  for (const artifact of artifacts) {
    if (!artifact.path.trim() || !artifact.targetPath.trim()) throw new Error("Implementation artifacts require source and target paths.");
    const sourceCandidate = resolve(project, artifact.path);
    const sourceFromRoot = relative(project, sourceCandidate);
    if (isAbsolute(sourceFromRoot) || sourceFromRoot === ".." || sourceFromRoot.startsWith(`..${sep}`)) throw new Error(`Implementation artifact escapes the project: ${artifact.path}`);
    if (!existsSync(sourceCandidate)) throw new Error(`Implementation artifact does not exist: ${artifact.path}`);
    const sourcePath = realpathSync(sourceCandidate);
    const realSourceFromRoot = relative(project, sourcePath);
    if (isAbsolute(realSourceFromRoot) || realSourceFromRoot === ".." || realSourceFromRoot.startsWith(`..${sep}`)) throw new Error(`Implementation artifact resolves outside the project: ${artifact.path}`);
    const sourceStat = statSync(sourcePath);
    if (!sourceStat.isFile() || sourceStat.size > 64 * 1024 * 1024) throw new Error(`Implementation artifact must be a regular file no larger than 64 MiB: ${artifact.path}`);
    totalBytes += sourceStat.size;
    if (totalBytes > 128 * 1024 * 1024) throw new Error("Implementation artifacts exceed the 128 MiB aggregate staging limit.");
    const sourceSha256 = sha256File(sourcePath);
    const expectedDigest = artifact.sha256.replace(/^sha256:/i, "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedDigest) || sourceSha256.replace(/^sha256:/i, "").toLowerCase() !== expectedDigest) {
      throw new Error(`Implementation artifact checksum mismatch: ${artifact.path}`);
    }

    const workspace = resolveImplementationPaths(worktree, workspaceRelativePath);
    const targetCandidate = resolve(workspace.workspaceRoot, artifact.targetPath);
    const targetFromWorkspace = relative(workspace.workspaceRoot, targetCandidate);
    if (isAbsolute(targetFromWorkspace) || targetFromWorkspace === ".." || targetFromWorkspace.startsWith(`..${sep}`)) {
      throw new Error(`Implementation artifact target escapes the adapter workspace: ${artifact.targetPath}`);
    }
    if (targets.has(targetCandidate)) throw new Error(`Duplicate implementation artifact target: ${artifact.targetPath}`);
    targets.add(targetCandidate);
    const parent = dirname(targetCandidate);
    mkdirSync(parent, { recursive: true });
    const realParent = realpathSync(parent);
    const realParentFromWorkspace = relative(workspace.workspaceRoot, realParent);
    if (isAbsolute(realParentFromWorkspace) || realParentFromWorkspace === ".." || realParentFromWorkspace.startsWith(`..${sep}`)) {
      throw new Error(`Implementation artifact target resolves outside the adapter workspace: ${artifact.targetPath}`);
    }
    let targetExists = false;
    try {
      const targetInfo = lstatSync(targetCandidate);
      if (targetInfo.isSymbolicLink()) throw new Error(`Implementation artifact target cannot be a symlink: ${artifact.targetPath}`);
      targetExists = true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") throw error;
    }
    if (targetExists) {
      const existing = statSync(targetCandidate);
      if (!existing.isFile() || sha256File(targetCandidate) !== sourceSha256) throw new Error(`Implementation artifact target already exists with different content: ${artifact.targetPath}`);
    } else {
      copyFileSync(sourcePath, targetCandidate, 1);
    }
    if (sha256File(targetCandidate) !== sourceSha256) throw new Error(`Implementation artifact staging failed checksum verification: ${artifact.targetPath}`);
    staged.push({ sourcePath, sourceSha256, targetPath: realpathSync(targetCandidate) });
  }
  return staged;
}

/** Hash the changed candidate sources that will be evaluated; paths stay worktree-relative. */
export function captureImplementationSnapshot(worktree: string, paths: string[]): ImplementationSnapshot {
  const root = realpathSync(worktree);
  const files: Record<string, string> = {};
  for (const path of [...new Set(paths)].sort()) {
    const candidate = resolve(root, path);
    const fromRoot = relative(root, candidate);
    if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) throw new Error(`Implementation source escapes its worktree: ${path}`);
    if (!existsSync(candidate)) continue;
    const realCandidate = realpathSync(candidate);
    const realFromRoot = relative(root, realCandidate);
    if (isAbsolute(realFromRoot) || realFromRoot === ".." || realFromRoot.startsWith(`..${sep}`)) throw new Error(`Implementation source resolves outside its worktree: ${path}`);
    if (!statSync(realCandidate).isFile()) continue;
    files[realFromRoot] = sha256File(realCandidate);
  }
  if (!Object.keys(files).length) throw new Error("Implementation snapshot contains no existing source files.");
  return { worktree: root, files };
}

/** Fail closed if a resumed experiment lost or changed the implementation that was evaluated for. */
export function verifyImplementationSnapshot(snapshot: ImplementationSnapshot): string[] {
  let root: string;
  try { root = realpathSync(snapshot.worktree); }
  catch { return [`recorded worktree is unavailable: ${snapshot.worktree}`]; }
  const mismatches: string[] = [];
  for (const [path, expected] of Object.entries(snapshot.files)) {
    try {
      const candidate = resolve(root, path);
      const fromRoot = relative(root, candidate);
      if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) { mismatches.push(`${path} escapes the recorded worktree`); continue; }
      if (!existsSync(candidate) || !statSync(candidate).isFile()) { mismatches.push(`${path} is missing`); continue; }
      const realCandidate = realpathSync(candidate);
      const realFromRoot = relative(root, realCandidate);
      if (isAbsolute(realFromRoot) || realFromRoot === ".." || realFromRoot.startsWith(`..${sep}`)) { mismatches.push(`${path} resolves outside the recorded worktree`); continue; }
      if (sha256File(realCandidate) !== expected) mismatches.push(`${path} checksum changed`);
    } catch { mismatches.push(`${path} cannot be verified`); }
  }
  return mismatches;
}

/** Decide whether an experiment engineer produced an evaluable implementation. */
export function implementationChanged(before: string | undefined, after: string | undefined, changedPaths: string[], targetRequired: boolean): boolean {
  if (targetRequired) return before !== after && after !== undefined;
  // Some research tasks have no single declared entrypoint. In that case,
  // require a real source change, not just prose, docs, or generated reports.
  return changedPaths.some((path) => /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|cpp|cc|cxx|c|h|hpp|rb|php|swift|sh)$/i.test(path));
}

export function implementationRetryPrompt(objective: string, targetFile?: string, previousFailure?: string): string {
  return [
    "The previous implementation attempt did not change the candidate source. Do not repeat the same edits.",
    "Return ONLY a unified diff beginning with `diff --git`; Evidra will apply and validate it.",
    "Use worktree-relative paths only. Do not use absolute paths or write to /tmp.",
    targetFile ? `The evaluator entrypoint that must change is: ${targetFile}` : "Change the relevant implementation source file.",
    "Make the smallest real source-code change that tests the declared hypothesis. Include no prose before or after the diff.",
    ...(previousFailure ? ["The previous diff was rejected. Fix this exact validation error; do not repeat the malformed hunk:", previousFailure] : []),
    "Original task:",
    objective,
  ].join("\n");
}

/** Ask a tool-capable engineer to make a real in-place edit before falling back to diff mode. */
export function implementationEditRetryPrompt(objective: string, targetFile?: string, previousFailure?: string): string {
  return [
    "The previous attempt completed without changing any candidate source file, so the experiment cannot run yet.",
    "You are operating in an isolated writable worktree with tools enabled. Inspect the current source, then make the smallest substantive source-code edit that tests the hypothesis; do not answer with a plan, explanation, or unified diff.",
    targetFile ? `The declared evaluator entrypoint is ${targetFile}; change it only if the hypothesis requires it.` : "Edit the relevant implementation source file, not documentation or generated output.",
    "After editing, verify the worktree contains the source change. Do not run the competition evaluator, alter evaluator/data files, submit anything, or claim a score.",
    ...(previousFailure ? [`Previous attempt detail: ${previousFailure}`] : []),
    "Original task:",
    objective,
  ].join("\n");
}

/** Resolve adapter-relative source paths inside the isolated worktree. */
export function resolveImplementationPaths(worktree: string, workspaceRelativePath: string, targetRelativePath?: string): { workspaceRoot: string; targetPath?: string; targetRelativeToWorktree?: string } {
  const root = realpathSync(worktree);
  const workspaceCandidate = resolve(root, workspaceRelativePath || ".");
  const lexicalWorkspaceFromRoot = relative(root, workspaceCandidate);
  if (isAbsolute(lexicalWorkspaceFromRoot) || lexicalWorkspaceFromRoot === ".." || lexicalWorkspaceFromRoot.startsWith(`..${sep}`)) {
    throw new Error(`Experiment workspace escapes its isolated worktree: ${workspaceRelativePath}`);
  }
  if (!existsSync(workspaceCandidate)) throw new Error(`Experiment workspace does not exist: ${workspaceRelativePath || "."}`);
  const workspaceRoot = realpathSync(workspaceCandidate);
  const workspaceFromRoot = relative(root, workspaceRoot);
  if (isAbsolute(workspaceFromRoot) || workspaceFromRoot === ".." || workspaceFromRoot.startsWith(`..${sep}`)) {
    throw new Error(`Experiment workspace escapes its isolated worktree: ${workspaceRelativePath}`);
  }
  if (!targetRelativePath?.trim()) return { workspaceRoot };
  const targetPath = resolve(workspaceRoot, targetRelativePath);
  const targetFromWorkspace = relative(workspaceRoot, targetPath);
  if (isAbsolute(targetFromWorkspace) || targetFromWorkspace === ".." || targetFromWorkspace.startsWith(`..${sep}`)) {
    throw new Error(`Experiment target escapes its adapter workspace: ${targetRelativePath}`);
  }
  if (existsSync(targetPath)) {
    const realTarget = realpathSync(targetPath);
    const realFromWorkspace = relative(workspaceRoot, realTarget);
    if (realFromWorkspace === ".." || realFromWorkspace.startsWith(`..${sep}`)) {
      throw new Error(`Experiment target resolves outside its adapter workspace: ${targetRelativePath}`);
    }
  }
  return { workspaceRoot, targetPath, targetRelativeToWorktree: relative(root, targetPath) };
}

/** Capture a checksum pin for the current file when a verification hypothesis omits one. */
export function captureVerificationSourcePin(projectRoot: string, workspaceRelativePath: string, targetRelativePath: string): { path: string; sha256: string; targetPath: string } {
  const project = realpathSync(projectRoot);
  const paths = resolveImplementationPaths(project, workspaceRelativePath, targetRelativePath);
  if (!paths.targetPath || !existsSync(paths.targetPath)) throw new Error(`Verification source does not exist: ${targetRelativePath}`);
  const target = realpathSync(paths.targetPath);
  const stat = statSync(target);
  if (!stat.isFile() || stat.size > 2_000_000) throw new Error("Verification source must be a regular file no larger than 2 MB.");
  const digest = sha256File(target);
  if (!/^sha256:[a-f0-9]{64}$/i.test(digest)) throw new Error(`Unable to compute a valid SHA-256 for verification source: ${targetRelativePath}`);
  return { path: relative(project, target), sha256: digest, targetPath: targetRelativePath };
}

/** Seed and snapshot a pinned implementation for a verification-only experiment without invoking an editor. */
export function seedVerificationImplementation(
  projectRoot: string,
  worktree: string,
  workspaceRelativePath: string,
  sourceRelativePath: string,
  targetRelativePath: string,
  expectedSha256: string,
): { sourcePath: string; sourceSha256: string; targetPath: string; snapshot: ImplementationSnapshot } {
  const paths = resolveImplementationPaths(worktree, workspaceRelativePath, targetRelativePath);
  if (!paths.targetPath || !paths.targetRelativeToWorktree) throw new Error("Verification seed requires a declared candidate target path.");
  const seeded = seedImplementationSource(projectRoot, paths.targetPath, sourceRelativePath, expectedSha256);
  const snapshot = captureImplementationSnapshot(worktree, [paths.targetRelativeToWorktree]);
  if (snapshot.files[paths.targetRelativeToWorktree] !== seeded.sourceSha256) {
    throw new Error("Verification seed snapshot does not match the checksum-pinned implementation.");
  }
  return { ...seeded, snapshot };
}
