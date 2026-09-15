import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { platform, arch, release, version } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { runProcess } from "./process.js";
import { redactSecrets } from "./redaction.js";

type Probe = { exitCode: number; stdout: string; stderr: string } | null;

export interface EnvironmentSnapshot {
  capturedAt: string;
  node: string;
  platform: string;
  arch: string;
  os: { release: string; version: string };
  cwd: string;
  command: string[];
  executor: string;
  gpu: string | null;
  gitHead: string | null;
  workingTreeDiffHash: string | null;
  lockfiles: Record<string, string>;
  probes: Record<string, Probe>;
  environment: Record<string, string>;
  entropyAudit: {
    reproducibilityFingerprint: string;
    explicitSeedSignals: string[];
    uncontrolledInputs: string[];
  };
}

const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "uv.lock", "poetry.lock", "Pipfile.lock"];
const SECRET_KEY = /(TOKEN|KEY|SECRET|PASSWORD|COOKIE|AUTH|CREDENTIAL|PASS)/i;

function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const VOLATILE_ENV = /^(PWD|OLDPWD|SHLVL|_|TERM|COLORTERM|LS_COLORS|XDG_RUNTIME_DIR|HOSTNAME|SSH_CONNECTION|TMPDIR|TMP)$/i;
const SEED_KEY = /(?:^|_)(SEED|RANDOM_STATE|DETERMINISTIC|CUBLAS_WORKSPACE_CONFIG|CUDA_LAUNCH_BLOCKING)(?:$|_)/i;
const SENSITIVE_FLAG = /^(?:--?|\/)?(?:api[-_]?key|token|secret|password|passwd|authorization|auth|credential)(?:=|$)/i;

function safeCommand(command: string[]): string[] {
  let redactNext = false;
  return command.map((part) => {
    if (redactNext) {
      redactNext = false;
      return "[REDACTED_ARGUMENT]";
    }
    if (SENSITIVE_FLAG.test(part)) {
      const equals = part.indexOf("=");
      if (equals >= 0) return `${part.slice(0, equals + 1)}[REDACTED_ARGUMENT]`;
      redactNext = true;
    }
    return redactSecrets(part);
  });
}

function entropyAudit(command: string[], environment: Record<string, string>, stable: Record<string, unknown>): EnvironmentSnapshot["entropyAudit"] {
  const explicitSeedSignals = Object.entries(environment).filter(([key]) => SEED_KEY.test(key)).map(([key, value]) => `${key}=${value}`).sort();
  const commandSeedSignals = command.filter((part) => /(?:seed|random[_-]?state|deterministic|reproduc)/i.test(part));
  const uncontrolledInputs = [
    ...(explicitSeedSignals.length || commandSeedSignals.length ? [] : ["no explicit seed or deterministic-mode signal in command/environment"]),
    ...(environment.CUDA_VISIBLE_DEVICES ? [] : ["CUDA_VISIBLE_DEVICES is not pinned"]),
    ...(environment.OMP_NUM_THREADS || environment.MKL_NUM_THREADS ? [] : ["thread-count environment is not pinned"]),
  ];
  return {
    reproducibilityFingerprint: digest(JSON.stringify(stable)),
    explicitSeedSignals: [...explicitSeedSignals, ...commandSeedSignals].slice(0, 20),
    uncontrolledInputs,
  };
}

async function probe(command: string[], cwd: string): Promise<Probe> {
  try {
    const result = await runProcess(command, cwd, 10_000);
    return { exitCode: result.exitCode, stdout: result.stdout.trim().slice(0, 2_000), stderr: result.stderr.trim().slice(0, 2_000) };
  } catch {
    return null;
  }
}

/** Capture enough host state to reproduce a run without persisting credentials. */
export async function captureEnvironment(
  root: string,
  cwd: string,
  command: string[],
  executor: string,
  gpu?: string,
): Promise<EnvironmentSnapshot> {
  const persistedCommand = safeCommand(command);
  const [head, diff, nodeProbe, pythonProbe, python3Probe, gpuProbe] = await Promise.all([
    probe(["git", "rev-parse", "HEAD"], cwd),
    runProcess(["git", "diff", "--no-ext-diff", "--binary", "HEAD"], cwd, 30_000).catch(() => null),
    probe(["node", "--version"], cwd),
    probe(["python", "--version"], cwd),
    probe(["python3", "--version"], cwd),
    probe(["nvidia-smi", "--query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw", "--format=csv,noheader"], cwd),
  ]);
  const lockfiles: Record<string, string> = {};
  const roots = new Set<string>();
  let cursor = resolve(cwd);
  const boundary = resolve(root);
  while (cursor === boundary || cursor.startsWith(`${boundary}/`)) {
    roots.add(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  roots.add(boundary);
  for (const directory of roots) for (const name of LOCKFILES) {
    const path = join(directory, name);
    if (existsSync(path)) lockfiles[relative(boundary, path)] = digest(readFileSync(path));
  }
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => Boolean(value) && !SECRET_KEY.test(key))
    .map(([key, value]) => {
      const text = value as string;
      // URL-shaped variables can carry user:password@host even when their key
      // does not contain AUTH or PASSWORD. Preserve the variable's presence,
      // but never persist its credential-bearing value.
      if (/^[a-z][a-z\d+.-]*:\/\/[^/\s]+@/i.test(text)) return [key, "<redacted-url-credentials>"];
      return [key, text];
    }));
  const snapshot: Omit<EnvironmentSnapshot, "entropyAudit"> = {
    capturedAt: new Date().toISOString(),
    node: process.version,
    platform: platform(),
    arch: arch(),
    os: { release: release(), version: version() },
    cwd,
    command: persistedCommand,
    executor,
    gpu: gpu ?? null,
    gitHead: head?.exitCode === 0 ? head.stdout : null,
    workingTreeDiffHash: diff?.exitCode === 0 ? digest(diff.stdout) : null,
    lockfiles,
    probes: { node: nodeProbe, python: pythonProbe, python3: python3Probe, nvidiaSmi: gpuProbe },
    environment,
  };
  return { ...snapshot, entropyAudit: entropyAudit(persistedCommand, environment, { node: snapshot.node, platform: snapshot.platform, arch: snapshot.arch, os: snapshot.os, cwd: snapshot.cwd, command: snapshot.command, executor: snapshot.executor, gpu: snapshot.gpu, gitHead: snapshot.gitHead, workingTreeDiffHash: snapshot.workingTreeDiffHash, lockfiles: snapshot.lockfiles, probes: snapshot.probes, environment: Object.fromEntries(Object.entries(environment).filter(([key]) => !VOLATILE_ENV.test(key))) }) };
}
