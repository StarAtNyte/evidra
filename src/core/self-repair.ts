import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { writeFileAtomic } from "./improvement-ledger.js";

/**
 * Self-repair: a failure is a problem to solve, not a reason to stop.
 *
 * Every failure becomes an evidence pack handed to a repair agent. Launch-path failures are fixed
 * (environment, paths, workspace permissions) and the run resumes; a known fix is remembered by
 * failure signature and applied instantly next time. Candidate-code failures go through a bounded
 * debug loop (patch, quick check, re-run). Only fixes outside policy are escalated to a human, and
 * even then the rest of the campaign keeps running.
 */

export interface EvidencePack {
  experimentId: string;
  stage: string;
  kind: "infra" | "experiment";
  attempt: number;
  exitCode: number | null;
  signature: string;
  reason: string;
  stderrTail: string;
  stdoutTail: string;
  traceback?: string;
  environment: Record<string, string>;
  preflight?: { ok: boolean; reason: string; output?: string };
  recentDiff?: string;
  cwd: string;
  workspace: string;
  previousAttempts: Array<{ action: string; summary?: string; outcome: string }>;
  policy: RepairPolicySummary;
}

export interface RepairPolicySummary {
  writableRoots: string[];
  protectedFiles: string[];
  forbiddenEnv: string[];
  contract?: unknown;
}

export type RepairAction =
  | { kind: "env"; env: Record<string, string>; summary?: string }
  | { kind: "patch"; summary?: string }
  | { kind: "retry"; summary?: string }
  | { kind: "escalate"; reason: string; needs?: string[] }
  | { kind: "give_up"; reason: string };

/** Last Python traceback (or JS stack) in a process output. */
export function extractTraceback(output: string): string | undefined {
  const index = output.lastIndexOf("Traceback (most recent call last):");
  if (index >= 0) return output.slice(index).split(/\r?\n/).slice(0, 60).join("\n");
  const js = output.match(/^\w*Error: .*\n(\s+at .*\n?)+/m);
  return js?.[0];
}

const SAFE_ENV_VALUE = /(TOKEN|KEY|SECRET|PASSWORD|COOKIE|AUTH|CREDENTIAL|PASS)/i;

export function environmentSnapshot(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    result[key] = SAFE_ENV_VALUE.test(key) ? "<redacted>" : value.length > 400 ? `${value.slice(0, 400)}...` : value;
  }
  return result;
}

export function tail(text: string | undefined, lines = 40): string {
  return (text ?? "").split(/\r?\n/).slice(-lines).join("\n");
}

/** Parse the agent's structured answer: the last JSON object in its output with a known kind. */
export function parseRepairAction(output: unknown): RepairAction | undefined {
  if (output && typeof output === "object" && typeof (output as { kind?: unknown }).kind === "string") return normalizeAction(output as Record<string, unknown>);
  const text = String(output ?? "");
  const candidates = text.match(/\{[\s\S]*?\}(?=\s*$|\s*\n)/g) ?? [];
  for (const line of [...text.split(/\r?\n/).reverse(), ...candidates.reverse()]) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const action = normalizeAction(JSON.parse(trimmed));
      if (action) return action;
    } catch { /* not JSON */ }
  }
  return undefined;
}

function normalizeAction(raw: Record<string, unknown>): RepairAction | undefined {
  const summary = typeof raw.summary === "string" ? raw.summary : undefined;
  switch (raw.kind) {
    case "env": {
      const env = raw.env && typeof raw.env === "object" ? Object.fromEntries(Object.entries(raw.env as Record<string, unknown>).map(([key, value]) => [key, String(value)])) : {};
      return { kind: "env", env, summary };
    }
    case "patch": return { kind: "patch", summary };
    case "retry": return { kind: "retry", summary };
    case "escalate": return { kind: "escalate", reason: typeof raw.reason === "string" ? raw.reason : "agent escalated", needs: Array.isArray(raw.needs) ? raw.needs.map(String) : undefined };
    case "give_up": return { kind: "give_up", reason: typeof raw.reason === "string" ? raw.reason : "agent gave up" };
    default: return undefined;
  }
}

export interface PolicyContext {
  writableRoots: string[];
  protectedFiles: string[];
  forbiddenEnv: string[];
  /** Env names an experiment may not override at all (process identity). */
  protectedEnv?: RegExp;
}

export const DEFAULT_FORBIDDEN_ENV = ["CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES", "MEM", "MEMORY_MAX", "CPUS", "GPU", "HIP_VISIBLE_DEVICES"];
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const PROCESS_IDENTITY = /^(PATH|HOME|PWD|SHELL|EVIDRA_|LD_)/;

/**
 * Out-of-policy fixes: resource overrides the contract forbids (another GPU, a bigger memory cap,
 * more cores), edits outside the workspace or to protected evaluator files, killing processes,
 * changing permissions outside the workspace. Returns the violations; empty means in policy.
 */
export function repairPolicyViolations(action: RepairAction, changedPaths: string[], context: PolicyContext): string[] {
  const violations: string[] = [];
  if (action.kind === "env") {
    for (const name of Object.keys(action.env)) {
      if (!ENV_NAME.test(name)) violations.push(`invalid environment name ${name}`);
      else if (context.forbiddenEnv.includes(name)) violations.push(`${name} is fixed by the resource contract`);
      else if ((context.protectedEnv ?? PROCESS_IDENTITY).test(name)) violations.push(`${name} is a protected process variable`);
    }
  }
  if (action.kind === "escalate") violations.push(action.reason, ...(action.needs ?? []));
  for (const needed of action.kind === "escalate" ? action.needs ?? [] : []) if (/\bkill\b|sudo|chmod|chown/.test(needed)) violations.push(`requires: ${needed}`);
  const roots = context.writableRoots.map((root) => resolve(root));
  const protectedFiles = new Set(context.protectedFiles.map((path) => resolve(path)));
  for (const path of changedPaths) {
    const absolute = resolve(path);
    if (!roots.some((root) => absolute === root || !relative(root, absolute).startsWith("..") && !isAbsolute(relative(root, absolute)))) violations.push(`edit outside the workspace: ${path}`);
    else if (protectedFiles.has(absolute)) violations.push(`edit to a protected evaluator file: ${path}`);
  }
  return [...new Set(violations)];
}

export interface RepairMemoryEntry {
  signature: string;
  kind: "infra" | "experiment";
  env: Record<string, string>;
  summary?: string;
  successes: number;
  firstSeen: string;
  lastUsed: string;
}

export function repairMemoryPath(stateDir: string): string { return join(stateDir, "repair-memory.json"); }

export function readRepairMemory(stateDir: string): RepairMemoryEntry[] {
  try { return JSON.parse(readFileSync(repairMemoryPath(stateDir), "utf8")) as RepairMemoryEntry[]; } catch { return []; }
}

export function rememberRepair(stateDir: string, entry: Omit<RepairMemoryEntry, "successes" | "firstSeen" | "lastUsed">): void {
  const memory = readRepairMemory(stateDir);
  const now = new Date().toISOString();
  const existing = memory.find((item) => item.signature === entry.signature);
  if (existing) Object.assign(existing, { env: { ...existing.env, ...entry.env }, summary: entry.summary ?? existing.summary, successes: existing.successes + 1, lastUsed: now });
  else memory.push({ ...entry, successes: 1, firstSeen: now, lastUsed: now });
  mkdirSync(stateDir, { recursive: true });
  writeFileAtomic(repairMemoryPath(stateDir), `${JSON.stringify(memory, null, 2)}\n`);
}

export function knownRepair(stateDir: string, signature: string): RepairMemoryEntry | undefined {
  return readRepairMemory(stateDir).find((entry) => entry.signature === signature);
}

/** Every remembered environment fix: applied to all launches so a repaired lane stays repaired. */
export function rememberedEnvironment(stateDir: string): Record<string, string> {
  return Object.assign({}, ...readRepairMemory(stateDir).filter((entry) => entry.kind === "infra").map((entry) => entry.env));
}

export function escalationPath(stateDir: string): string { return join(stateDir, "ESCALATIONS.md"); }

export function writeEscalation(stateDir: string, note: { experimentId: string; stage: string; reason: string; violations: string[]; evidence: Pick<EvidencePack, "signature" | "reason" | "exitCode" | "stderrTail">; proposed?: RepairAction }): string {
  const path = escalationPath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, "# Escalations\n\nFixes the repair agent may not apply on its own. The rest of the campaign keeps running.\n");
  appendFileSync(path, [
    "",
    `## ${new Date().toISOString()} ${note.experimentId} (${note.stage})`,
    "",
    `- Failure: ${note.evidence.reason} (exit ${note.evidence.exitCode ?? "signal"})`,
    `- Why it needs a human: ${note.violations.join("; ") || note.reason}`,
    ...(note.proposed ? [`- Proposed fix: \`${JSON.stringify(note.proposed)}\``] : []),
    "- Evidence (stderr tail):",
    "",
    "```",
    tail(note.evidence.stderrTail, 15),
    "```",
    "",
  ].join("\n"));
  return path;
}

/**
 * Run an external repair agent command (deterministic or scripted repairers, tests). The pack is
 * written to a file named by EVIDRA_REPAIR_PACK; the agent works in `cwd` and prints a JSON action.
 */
export function runRepairCommand(command: string[], pack: EvidencePack, packPath: string, env: NodeJS.ProcessEnv, timeoutMs = 20 * 60_000): RepairAction | undefined {
  mkdirSync(dirname(packPath), { recursive: true });
  writeFileSync(packPath, `${JSON.stringify(pack, null, 2)}\n`);
  const result = spawnSync(command[0], command.slice(1), { cwd: pack.cwd, env: { ...env, EVIDRA_REPAIR_PACK: packPath }, encoding: "utf8", timeout: timeoutMs });
  return parseRepairAction(result.stdout ?? "");
}

export const REPAIR_INSTRUCTIONS = `You are the repair engineer for an autonomous research harness. A run failed; the evidence pack describes it. Find the cause and fix it so the run can continue. Inspect files and run commands as needed.
- Launch-path failure (kind "infra": missing environment variables, wrong paths, missing dependencies available in a local cache, permissions inside the workspace): fix it. If the fix is an environment variable, return {"kind":"env","env":{...}}; if you edited workspace files (never the evaluator or protected files), return {"kind":"patch"}.
- Candidate-code failure (kind "experiment", e.g. a traceback in the candidate): patch the candidate in this worktree so it runs, keeping the hypothesis intact, then return {"kind":"patch","summary":"..."}.
- Stay in policy: no edits outside the writable roots, no protected evaluator files, no other GPU or larger memory/cores than the contract, no killing processes you did not start, no permission changes outside the workspace. If the only fix is outside policy, return {"kind":"escalate","reason":"...","needs":["..."]}.
- If you cannot find a fix, return {"kind":"give_up","reason":"..."}.
Finish with exactly one JSON object on the last line.`;
