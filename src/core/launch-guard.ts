import { existsSync } from "node:fs";

/**
 * Launch-path safety for long or quota-limited evaluators.
 *
 * Three questions are answered before an experiment result is believed:
 *  1. Is the launch chain itself healthy? (preflight, infra-vs-experiment classification,
 *     systemic failure detection) An infrastructure failure is not evidence about the idea.
 *  2. Is the candidate ready? (declared dependencies with readiness conditions)
 *  3. Does the run fit the hosted target? (explicit environment contract, peak memory and wall
 *     time checked against hosted limits with a safety margin)
 */

export interface LaunchPolicy {
  preflightCommand?: string[];
  preflightTtlMinutes: number;
  /** Exit codes that mean "the payload never ran" (EX_TEMPFAIL, not executable, not found). */
  infraExitCodes: number[];
  /** Output patterns that identify launch-path failures rather than experiment failures. */
  infraPatterns: string[];
  /** This many failures with the same signature inside the window is systemic: halt. */
  systemicFailures: number;
  systemicWindowMinutes: number;
  /** A failure this fast (seconds) counts toward systemic detection even when not recognized as infra. */
  quickFailureSeconds: number;
}

export const DEFAULT_INFRA_PATTERNS = [
  "Failed to connect to bus",
  "No medium found",
  "Permission denied",
  "command not found",
  "No such file or directory: '?/(usr|bin|opt)",
  "cannot open shared object file",
  "Operation not permitted",
  "CUDA driver version is insufficient",
  "no CUDA-capable device",
  "NVIDIA-SMI has failed",
  "Read-only file system",
  "No space left on device",
  "Unit .* already exists",
  "Failed to start transient scope",
  "preflight:",
];

export function resolveLaunchPolicy(config: Partial<LaunchPolicy> | undefined): LaunchPolicy {
  return {
    preflightCommand: config?.preflightCommand,
    preflightTtlMinutes: config?.preflightTtlMinutes ?? 30,
    infraExitCodes: config?.infraExitCodes ?? [75, 126, 127],
    infraPatterns: [...DEFAULT_INFRA_PATTERNS, ...(config?.infraPatterns ?? [])],
    systemicFailures: Math.max(2, config?.systemicFailures ?? 3),
    systemicWindowMinutes: config?.systemicWindowMinutes ?? 30,
    quickFailureSeconds: config?.quickFailureSeconds ?? 120,
  };
}

export interface LaunchOutcome {
  exitCode: number | null;
  output: string;
}

export interface LaunchClassification {
  kind: "ok" | "infra" | "experiment";
  reason: string;
  signature: string;
}

/** Normalize an error so identical failures across runs share a signature (numbers, paths, hex ids stripped). */
export function failureSignature(output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(-3).join(" | ");
  return tail.replace(/0x[0-9a-f]+/gi, "#").replace(/[0-9a-f]{8,}/gi, "#").replace(/\d+(\.\d+)?/g, "#").replace(/\/[^\s'"]+/g, "<path>").slice(0, 240);
}

export function classifyLaunchFailure(outcome: LaunchOutcome, policy: LaunchPolicy): LaunchClassification {
  const signature = failureSignature(outcome.output);
  if (outcome.exitCode === 0) return { kind: "ok", reason: "exit 0", signature };
  if (outcome.exitCode !== null && policy.infraExitCodes.includes(outcome.exitCode)) return { kind: "infra", reason: `exit code ${outcome.exitCode} means the payload did not run`, signature };
  for (const pattern of policy.infraPatterns) {
    let regex: RegExp;
    try { regex = new RegExp(pattern, "i"); } catch { continue; }
    const match = outcome.output.match(regex);
    if (match) return { kind: "infra", reason: `launch-path failure: ${match[0]}`, signature };
  }
  return { kind: "experiment", reason: `exit ${outcome.exitCode ?? "signal"}`, signature };
}

export interface RecordedFailure {
  signature: string;
  at: string;
  experimentId: string;
  kind: "infra" | "experiment";
  durationSeconds?: number;
}

/** N recent failures with one signature inside the window: the launch path is broken, not the ideas. */
export function detectSystemicFailure(failures: readonly RecordedFailure[], policy: Pick<LaunchPolicy, "systemicFailures" | "systemicWindowMinutes" | "quickFailureSeconds">, now = Date.now()): { systemic: boolean; signature?: string; experiments: string[] } {
  const windowStart = now - policy.systemicWindowMinutes * 60_000;
  // Distinct ideas do not fail identically within seconds; slow, idea-specific failures are evidence, not infrastructure.
  const recent = failures.filter((failure) => Date.parse(failure.at) >= windowStart && (failure.kind === "infra" || (failure.durationSeconds ?? Infinity) <= policy.quickFailureSeconds));
  const bySignature = new Map<string, Set<string>>();
  for (const failure of recent) {
    const set = bySignature.get(failure.signature) ?? new Set<string>();
    set.add(failure.experimentId);
    bySignature.set(failure.signature, set);
  }
  for (const [signature, experiments] of bySignature) {
    if (experiments.size >= policy.systemicFailures) return { systemic: true, signature, experiments: [...experiments] };
  }
  return { systemic: false, experiments: [] };
}

/** Required environment variables missing from the worker environment. */
export function missingEnvironment(required: readonly string[], env: NodeJS.ProcessEnv): string[] {
  return required.filter((name) => !env[name]);
}

export interface Dependency {
  /** What the candidate depends on (a submission directory, an artifact, a report). */
  path: string;
  readyWhen?: { file?: string; command?: string[] };
  /** Who produces it; "external" (another agent) requires an explicit readiness condition. */
  producer?: string;
}

export interface ReadinessConfig {
  /** Marker file name required inside a dependency directory when no readyWhen is declared. */
  defaultMarker: string;
  /** Environment variables whose value names a dependency: NAME -> path template with {value}. */
  envPaths: Record<string, string>;
  /** Dependency paths already verified by their owner (e.g. the operator's submitted baselines). */
  trusted: string[];
}

/** Dependencies of a candidate: its declared ones plus any implied by environment values (e.g. EV_SUBMISSION=v50_bx). */
export function candidateDependencies(declared: readonly Dependency[] | undefined, env: Record<string, string>, readiness: ReadinessConfig | undefined): Dependency[] {
  const result = [...(declared ?? [])];
  for (const [name, template] of Object.entries(readiness?.envPaths ?? {})) {
    const value = env[name];
    if (!value) continue;
    const path = template.replace("{value}", value);
    if (!result.some((entry) => entry.path === path)) result.push({ path, producer: "external" });
  }
  return result;
}

export interface DependencyStatus {
  ready: boolean;
  pending: Array<{ path: string; waitingFor: string }>;
}

/**
 * A dependency is ready when its declared condition holds; with no condition, when the path
 * exists and carries the default readiness marker. A path that merely exists is not ready: a
 * submission another agent is still building has files long before it is verified.
 */
export function dependencyStatus(dependencies: readonly Dependency[], readiness: ReadinessConfig | undefined, probe: { exists?: (path: string) => boolean; run?: (command: string[]) => boolean } = {}): DependencyStatus {
  const exists = probe.exists ?? existsSync;
  const pending: DependencyStatus["pending"] = [];
  const trusted = new Set((readiness?.trusted ?? []).map((path) => path.replace(/\/$/, "")));
  for (const dependency of dependencies) {
    if (trusted.has(dependency.path.replace(/\/$/, "")) && !dependency.readyWhen) continue;
    if (!exists(dependency.path)) { pending.push({ path: dependency.path, waitingFor: "path does not exist" }); continue; }
    if (dependency.readyWhen?.command) {
      if (!(probe.run?.(dependency.readyWhen.command) ?? false)) pending.push({ path: dependency.path, waitingFor: `readiness command ${dependency.readyWhen.command.join(" ")}` });
      continue;
    }
    const marker = dependency.readyWhen?.file ?? `${dependency.path.replace(/\/$/, "")}/${readiness?.defaultMarker ?? "READY"}`;
    if (!exists(marker)) pending.push({ path: dependency.path, waitingFor: `marker ${marker}` });
  }
  return { ready: pending.length === 0, pending };
}

export interface RunResources {
  peakRssMb?: number;
  wallSeconds?: number;
}

/** Parse GNU `/usr/bin/time -v` output. */
export function parseTimeVerbose(text: string): RunResources {
  const rss = text.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
  const wall = text.match(/Elapsed \(wall clock\) time \(h:mm:ss or m:ss\):\s*([\d:.]+)/);
  let wallSeconds: number | undefined;
  if (wall) {
    const parts = wall[1].split(":").map(Number);
    wallSeconds = parts.reduce((total, part) => total * 60 + part, 0);
  }
  return { ...(rss ? { peakRssMb: Number(rss[1]) / 1024 } : {}), ...(wallSeconds !== undefined && Number.isFinite(wallSeconds) ? { wallSeconds } : {}) };
}

/** Resources an evaluator reported in its JSON stdout (`"resources": {"peakRssMb", "wallSeconds"}`). */
export function resourcesFromOutput(stdout: string): RunResources | undefined {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    if (!line.includes("resources")) continue;
    try {
      const parsed = JSON.parse(line) as { resources?: { peakRssMb?: unknown; wallSeconds?: unknown } };
      const resources = parsed.resources;
      if (!resources) continue;
      return {
        ...(typeof resources.peakRssMb === "number" ? { peakRssMb: resources.peakRssMb } : {}),
        ...(typeof resources.wallSeconds === "number" ? { wallSeconds: resources.wallSeconds } : {}),
      };
    } catch { /* not JSON */ }
  }
  return undefined;
}

export interface EnvContract {
  requiredEnv: string[];
  /** Evaluator-relative file with GNU `time -v` output, used when stdout carries no resources. */
  timeFile?: string;
  devices: string[];
  localMemoryCapGb?: number;
  localCores?: number;
  hosted?: { memoryGb?: number; cpus?: number; gpu?: string; wallSeconds?: number };
  memorySafetyFraction: number;
  wallSafetyFraction: number;
  /** Multiply a local wall time by this to predict the hosted wall time (e.g. 4090 -> H100). */
  wallScale: number;
}

export function resolveEnvContract(config: Partial<EnvContract> | undefined): EnvContract | undefined {
  if (!config) return undefined;
  return { requiredEnv: config.requiredEnv ?? [], timeFile: config.timeFile, devices: config.devices ?? [], localMemoryCapGb: config.localMemoryCapGb, localCores: config.localCores, hosted: config.hosted, memorySafetyFraction: config.memorySafetyFraction ?? 0.85, wallSafetyFraction: config.wallSafetyFraction ?? 0.85, wallScale: config.wallScale ?? 1 };
}

export interface ResourceVerdict {
  ok: boolean;
  reasons: string[];
  limits: { memoryMb?: number; wallSeconds?: number };
  predictedHostedWallSeconds?: number;
}

/** Reject a run whose peak memory or predicted hosted wall time breaks the hosted limits with margin. */
export function checkResources(resources: RunResources | undefined, contract: EnvContract | undefined): ResourceVerdict {
  if (!contract?.hosted || !resources) return { ok: true, reasons: [], limits: {} };
  const reasons: string[] = [];
  const memoryMb = contract.hosted.memoryGb !== undefined ? contract.hosted.memoryGb * 1024 * contract.memorySafetyFraction : undefined;
  const wallSeconds = contract.hosted.wallSeconds !== undefined ? contract.hosted.wallSeconds * contract.wallSafetyFraction : undefined;
  if (memoryMb !== undefined && resources.peakRssMb !== undefined && resources.peakRssMb > memoryMb) reasons.push(`peak RSS ${resources.peakRssMb.toFixed(0)} MB exceeds ${(contract.memorySafetyFraction * 100).toFixed(0)}% of hosted ${contract.hosted.memoryGb} GB (${memoryMb.toFixed(0)} MB)`);
  const predicted = resources.wallSeconds !== undefined ? resources.wallSeconds * contract.wallScale : undefined;
  if (wallSeconds !== undefined && predicted !== undefined && predicted > wallSeconds) reasons.push(`predicted hosted wall ${predicted.toFixed(0)} s (local ${resources.wallSeconds!.toFixed(0)} s x ${contract.wallScale}) exceeds ${(contract.wallSafetyFraction * 100).toFixed(0)}% of ${contract.hosted.wallSeconds} s`);
  return { ok: reasons.length === 0, reasons, limits: { ...(memoryMb !== undefined ? { memoryMb } : {}), ...(wallSeconds !== undefined ? { wallSeconds } : {}) }, ...(predicted !== undefined ? { predictedHostedWallSeconds: predicted } : {}) };
}
