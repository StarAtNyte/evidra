import { existsSync, readdirSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { guardCommand } from "./permissions.js";
import { runProcess, type ProcessControl } from "./process.js";
import { safeBundlePath, validateSubmissionBundle, type SubmissionValidation } from "./submissions.js";
import { redactCommand, redactSecrets } from "./redaction.js";
import type { CompetitionConfig } from "./types.js";

export interface SubmissionReceipt {
  platform: string;
  submittedAt: string;
  predictionFile: string;
  command: string[];
  stdout: string;
  stderr: string;
  submissionId?: string;
}

export interface SubmissionAttempt {
  receipt: SubmissionReceipt;
  validation: SubmissionValidation;
}

export interface SubmissionScoreObservation {
  platform: string;
  observedAt: string;
  score: number;
  command: string[];
  stdout: string;
  stderr: string;
}

function predictionFile(bundlePath: string, configured?: string): string {
  const candidateName = configured ?? readdirSync(bundlePath).find((name) => /submission|prediction/i.test(basename(name)));
  const candidate = candidateName ? safeBundlePath(bundlePath, candidateName) : undefined;
  if (!candidate || !existsSync(candidate)) throw new Error("Submission adapter could not find a configured prediction file in the bundle.");
  return candidate;
}

function substitute(command: string[], values: Record<string, string>): string[] {
  return command.map((part) => part.replace(/\{(bundle|file|competition|message|submission)\}/g, (_, key: string) => values[key] ?? ""));
}

function commandWorkingDirectory(root: string, configured?: string): string {
  const workingDirectory = configured ? resolve(root, configured) : root;
  const workingRelative = relative(resolve(root), workingDirectory);
  if (isAbsolute(workingRelative) || workingRelative.startsWith("..")) throw new Error("Submission workingDirectory must stay inside the project root.");
  return workingDirectory;
}

/** Parse the intentionally small score protocol used by generic competition adapters. */
export function parseSubmissionScore(output: string): number | undefined {
  const candidates: unknown[] = [];
  for (const line of output.split(/\r?\n/)) {
    try {
      const parsed: unknown = JSON.parse(line.trim());
      if (parsed && typeof parsed === "object") {
        const value = parsed as Record<string, unknown>;
        for (const key of ["publicScore", "public_score", "leaderboardScore", "leaderboard_score", "score"]) candidates.push(value[key]);
        const nested = value.result;
        if (nested && typeof nested === "object") candidates.push((nested as Record<string, unknown>).score);
      } else candidates.push(parsed);
    } catch { /* permit human-readable adapter output below */ }
  }
  for (const match of output.matchAll(/(?:public[_ ]score|leaderboard[_ ]score|score)\s*[:=]\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/gi)) candidates.push(match[1]);
  for (const value of candidates) {
    const score = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (Number.isFinite(score)) return score;
  }
  return undefined;
}

/** Submit only through an explicitly configured platform adapter. */
export async function submitApprovedBundle(root: string, bundlePath: string, competition: CompetitionConfig, message = "Evidra research submission", onProcess?: (control: ProcessControl) => void): Promise<SubmissionAttempt> {
  const validation = validateSubmissionBundle(bundlePath);
  if (!validation.valid) throw new Error(`Submission bundle is invalid; refusing external submission.`);
  const config = competition.submission;
  const platform = config?.platform ?? "manual";
  if (platform === "manual") throw new Error("Manual submission is configured. Upload the validated bundle and record its score with Evidra.");
  const template = config?.submitCommand ?? [];
  const needsFile = platform === "kaggle" || Boolean(config?.predictionFile) || template.some((part) => part.includes("{file}"));
  const file = needsFile ? predictionFile(bundlePath, config?.predictionFile) : "";
  const values = { bundle: bundlePath, file, competition: config?.competition ?? competition.id, message, submission: "" };
  const command = platform === "kaggle"
    ? ["kaggle", "competitions", "submit", "-c", values.competition, "-f", values.file, "-m", values.message]
    : substitute(config?.submitCommand ?? [], values);
  if (!command.length) throw new Error("Command submission requires submission.submitCommand in competition.json.");
  const guard = guardCommand(command);
  if (!guard.allowed) throw new Error(`Submission command refused: ${guard.reason}`);
  const workingDirectory = commandWorkingDirectory(root, config?.workingDirectory);
  let result;
  try {
    result = await runProcess(command, workingDirectory, 10 * 60_000, undefined, onProcess);
  } catch (error) {
    throw new Error(`External submission could not start: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  }
  if (result.exitCode !== 0) throw new Error(`External submission failed (${result.exitCode}): ${redactSecrets(result.stderr || result.stdout)}`);
  return {
    validation,
    receipt: { platform, submittedAt: new Date().toISOString(), predictionFile: file, command: redactCommand(command), stdout: redactSecrets(result.stdout), stderr: redactSecrets(result.stderr) },
  };
}

/** Poll a platform through a configured read-only command and return a durable score observation. */
export async function pollSubmissionScore(root: string, bundlePath: string, submissionId: string, competition: CompetitionConfig, onProcess?: (control: ProcessControl) => void): Promise<SubmissionScoreObservation> {
  const validation = validateSubmissionBundle(bundlePath);
  if (!validation.valid) throw new Error("Submission bundle is invalid; refusing to poll its external score.");
  const config = competition.submission;
  const template = config?.scoreCommand ?? [];
  if (!template.length) throw new Error("No scoreCommand is configured. Add submission.scoreCommand or use submission record for a manually observed score.");
  const needsFile = Boolean(config?.predictionFile) || template.some((part) => part.includes("{file}"));
  const file = needsFile ? predictionFile(bundlePath, config?.predictionFile) : "";
  const command = substitute(template, { bundle: bundlePath, file, competition: config?.competition ?? competition.id, message: "", submission: submissionId });
  const guard = guardCommand(command);
  if (!guard.allowed) throw new Error(`Score polling command refused: ${guard.reason}`);
  let result;
  try {
    result = await runProcess(command, commandWorkingDirectory(root, config?.workingDirectory), 10 * 60_000, undefined, onProcess);
  } catch (error) {
    throw new Error(`External score polling could not start: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  }
  const score = parseSubmissionScore(result.stdout);
  if (result.exitCode !== 0) throw new Error(`External score polling failed (${result.exitCode}): ${redactSecrets(result.stderr || result.stdout)}`);
  if (score === undefined) throw new Error("Score polling completed but emitted no finite score. Emit JSON such as {\"publicScore\": 0.812} or 'score: 0.812'.");
  return { platform: config?.platform ?? "command", observedAt: new Date().toISOString(), score, command: redactCommand(command), stdout: redactSecrets(result.stdout), stderr: redactSecrets(result.stderr) };
}
