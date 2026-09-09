import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { platform, arch, release, version } from "node:os";
import { join, relative } from "node:path";
import { runProcess } from "./process.js";

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
}

const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "uv.lock", "poetry.lock", "Pipfile.lock"];
const SECRET_KEY = /(TOKEN|KEY|SECRET|PASSWORD|COOKIE|AUTH|CREDENTIAL|PASS)/i;

function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
  const [head, diff, nodeProbe, pythonProbe, python3Probe, gpuProbe] = await Promise.all([
    probe(["git", "rev-parse", "HEAD"], cwd),
    runProcess(["git", "diff", "--no-ext-diff", "--binary", "HEAD"], cwd, 30_000).catch(() => null),
    probe(["node", "--version"], cwd),
    probe(["python", "--version"], cwd),
    probe(["python3", "--version"], cwd),
    probe(["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"], cwd),
  ]);
  const lockfiles: Record<string, string> = {};
  for (const name of LOCKFILES) {
    const path = join(root, name);
    if (existsSync(path)) lockfiles[relative(root, path)] = digest(readFileSync(path));
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
  return {
    capturedAt: new Date().toISOString(),
    node: process.version,
    platform: platform(),
    arch: arch(),
    os: { release: release(), version: version() },
    cwd,
    command,
    executor,
    gpu: gpu ?? null,
    gitHead: head?.exitCode === 0 ? head.stdout : null,
    workingTreeDiffHash: diff?.exitCode === 0 ? digest(diff.stdout) : null,
    lockfiles,
    probes: { node: nodeProbe, python: pythonProbe, python3: python3Probe, nvidiaSmi: gpuProbe },
    environment,
  };
}
