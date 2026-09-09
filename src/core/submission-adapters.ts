import { existsSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { guardCommand } from "./permissions.js";
import { runProcess, type ProcessControl } from "./process.js";
import { validateSubmissionBundle, type SubmissionValidation } from "./submissions.js";
import type { CompetitionConfig } from "./types.js";

export interface SubmissionReceipt {
  platform: string;
  submittedAt: string;
  predictionFile: string;
  command: string[];
  stdout: string;
  stderr: string;
}

export interface SubmissionAttempt {
  receipt: SubmissionReceipt;
  validation: SubmissionValidation;
}

function predictionFile(bundlePath: string, configured?: string): string {
  const candidate = configured ? resolve(bundlePath, configured) : readdirSync(bundlePath).map((name) => join(bundlePath, name)).find((path) => /submission|prediction/i.test(basename(path)));
  if (!candidate || !existsSync(candidate)) throw new Error("Submission adapter could not find a configured prediction file in the bundle.");
  const rel = relative(resolve(bundlePath), resolve(candidate));
  if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("Configured predictionFile escapes the submission bundle.");
  return candidate;
}

function substitute(command: string[], values: Record<string, string>): string[] {
  return command.map((part) => part.replace(/\{(bundle|file|competition|message)\}/g, (_, key: string) => values[key] ?? ""));
}

/** Submit only through an explicitly configured platform adapter. */
export async function submitApprovedBundle(root: string, bundlePath: string, competition: CompetitionConfig, message = "Evidra research submission", onProcess?: (control: ProcessControl) => void): Promise<SubmissionAttempt> {
  const validation = validateSubmissionBundle(bundlePath);
  if (!validation.valid) throw new Error(`Submission bundle is invalid; refusing external submission.`);
  const config = competition.submission;
  const platform = config?.platform ?? "manual";
  if (platform === "manual") throw new Error("Manual submission is configured. Upload the validated bundle and record its score with Evidra.");
  const file = predictionFile(bundlePath, config?.predictionFile);
  const values = { bundle: bundlePath, file, competition: config?.competition ?? competition.id, message };
  const command = platform === "kaggle"
    ? ["kaggle", "competitions", "submit", "-c", values.competition, "-f", values.file, "-m", values.message]
    : substitute(config?.submitCommand ?? [], values);
  if (!command.length) throw new Error("Command submission requires submission.submitCommand in competition.json.");
  const guard = guardCommand(command);
  if (!guard.allowed) throw new Error(`Submission command refused: ${guard.reason}`);
  const result = await runProcess(command, root, 10 * 60_000, undefined, onProcess);
  if (result.exitCode !== 0) throw new Error(`External submission failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  return {
    validation,
    receipt: { platform, submittedAt: new Date().toISOString(), predictionFile: file, command, stdout: result.stdout, stderr: result.stderr },
  };
}
