import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, statfsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface StageExperimentInputsOptions {
  projectRoot: string;
  worktreeRoot: string;
  worktreeBase?: string;
  workspaceRoot: string;
  dataPaths?: string[];
  supportFiles?: string[];
}

const INPUT_STAGING_FREE_SPACE_RESERVE_BYTES = 256 * 1024 * 1024;

function inside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function inputTreeBytes(path: string, workspaceRoot: string, ancestors: Set<string> = new Set()): number {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) {
    const target = realpathSync(path);
    if (!inside(workspaceRoot, target)) throw new Error(`Declared experiment input contains a symlink that escapes the workspace: ${path}`);
    if (ancestors.has(target)) throw new Error(`Declared experiment input contains a symlink cycle: ${path}`);
    return inputTreeBytes(target, workspaceRoot, ancestors);
  }
  if (info.isDirectory()) {
    const canonical = realpathSync(path);
    if (ancestors.has(canonical)) throw new Error(`Declared experiment input contains a directory cycle: ${path}`);
    const nestedAncestors = new Set([...ancestors, canonical]);
    return readdirSync(path).reduce((total, entry) => total + inputTreeBytes(join(path, entry), workspaceRoot, nestedAncestors), 0);
  }
  return info.isFile() ? info.size : 0;
}

/** Pure capacity gate, exported so storage policy can be tested without filling a filesystem. */
export function hasExperimentInputStagingCapacity(requiredBytes: number, availableBytes: number, reserveBytes = INPUT_STAGING_FREE_SPACE_RESERVE_BYTES): boolean {
  return Number.isFinite(requiredBytes) && requiredBytes >= 0 && Number.isFinite(availableBytes) && availableBytes >= 0 && availableBytes - requiredBytes >= reserveBytes;
}

/** Copy explicitly declared datasets and immutable workspace support files into an experiment worktree. */
export function stageExperimentInputs(options: StageExperimentInputsOptions): void {
  const projectRoot = realpathSync(resolve(options.projectRoot));
  const worktreeRoot = realpathSync(resolve(options.worktreeRoot));
  const unresolvedWorktreeBase = resolve(options.worktreeBase ?? join(projectRoot, ".sota", "worktrees"));
  const worktreeBase = existsSync(unresolvedWorktreeBase) ? realpathSync(unresolvedWorktreeBase) : unresolvedWorktreeBase;
  const workspaceRoot = realpathSync(resolve(options.workspaceRoot));
  if (!inside(worktreeBase, worktreeRoot) || worktreeRoot === worktreeBase || !inside(projectRoot, workspaceRoot)) {
    throw new Error("Experiment worktree must remain inside its configured worktree root, and workspace inputs must remain inside the project.");
  }
  const workspaceRelative = relative(projectRoot, workspaceRoot);
  const stage = (declared: string, kind: "data" | "support"): void => {
    if (!declared.trim() || isAbsolute(declared)) throw new Error(`Declared ${kind} path must be a non-empty relative path: ${declared}`);
    const source = resolve(workspaceRoot, declared);
    if (!inside(workspaceRoot, source) || source === workspaceRoot || !existsSync(source)) {
      throw new Error(`Declared experiment ${kind} path is missing or escapes the workspace: ${declared}`);
    }
    const checkedSource = realpathSync(source);
    if (!inside(workspaceRoot, checkedSource)) throw new Error(`Declared experiment ${kind} path resolves outside the workspace: ${declared}`);
    if (kind === "support" && !statSync(checkedSource).isFile()) throw new Error(`Declared experiment support path must be a file: ${declared}`);

    const destination = resolve(worktreeRoot, workspaceRelative, declared);
    if (!inside(worktreeRoot, destination) || destination === worktreeRoot) throw new Error(`Declared experiment input path escapes the isolated worktree: ${declared}`);
    if (existsSync(destination)) {
      if (lstatSync(destination).isSymbolicLink()) throw new Error(`Experiment input destination cannot be a symlink: ${declared}`);
      const checkedDestination = realpathSync(destination);
      if (!inside(worktreeRoot, checkedDestination)) throw new Error(`Experiment input destination resolves outside the worktree: ${declared}`);
      if (kind === "support" && (!statSync(checkedDestination).isFile() || !readFileSync(checkedSource).equals(readFileSync(checkedDestination)))) {
        throw new Error(`Immutable experiment support file differs in the isolated worktree: ${declared}`);
      }
      if (kind === "support") return;
    }
    let existingParent = dirname(destination);
    while (!existsSync(existingParent) && existingParent !== worktreeRoot) existingParent = dirname(existingParent);
    const checkedExistingParent = realpathSync(existingParent);
    if (!inside(worktreeRoot, checkedExistingParent)) throw new Error(`Experiment input parent resolves outside the worktree: ${declared}`);
    const requiredBytes = inputTreeBytes(checkedSource, workspaceRoot);
    const filesystem = statfsSync(checkedExistingParent);
    const availableBytes = filesystem.bavail * filesystem.bsize;
    if (!hasExperimentInputStagingCapacity(requiredBytes, availableBytes)) {
      const requiredGiB = (requiredBytes / (1024 ** 3)).toFixed(2);
      const availableGiB = (availableBytes / (1024 ** 3)).toFixed(2);
      throw new Error(`Insufficient free space to stage declared experiment ${kind} '${declared}' (${requiredGiB} GiB required; ${availableGiB} GiB available, with 0.25 GiB reserved). Free space or set EVIDRA_WORKTREE_ROOT to a filesystem with enough capacity.`);
    }
    mkdirSync(dirname(destination), { recursive: true });
    if (!inside(worktreeRoot, realpathSync(dirname(destination)))) throw new Error(`Experiment input parent resolves outside the worktree: ${declared}`);
    const destinationExisted = existsSync(destination);
    try {
      cpSync(checkedSource, destination, { recursive: kind === "data", force: kind === "data", dereference: true, errorOnExist: kind === "support" });
    } catch (error) {
      if (!destinationExisted) rmSync(destination, { recursive: true, force: true });
      if (error && typeof error === "object" && "code" in error && error.code === "ENOSPC") {
        throw new Error(`Disk ran out of space while staging experiment ${kind} '${declared}'.${destinationExisted ? " Existing staged input was preserved." : " The newly-created partial copy was removed."} Set EVIDRA_WORKTREE_ROOT to a filesystem with enough free space and retry.`, { cause: error });
      }
      throw error;
    }
  };

  for (const path of options.dataPaths ?? []) stage(path, "data");
  for (const path of options.supportFiles ?? []) stage(path, "support");
}
