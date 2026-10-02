import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { guardCommand } from "./permissions.js";
import { runProcess, type ProcessControl } from "./process.js";
import { safeBundlePath, validateSubmissionBundle, type SubmissionValidation } from "./submissions.js";
import { redactCommand, redactSecrets } from "./redaction.js";
import { worktreeBasePath } from "./worktree.js";
import type { CompetitionConfig } from "./types.js";

export interface SubmissionReceipt {
  platform: string;
  submittedAt: string;
  predictionFile: string;
  command: string[];
  stdout: string;
  stderr: string;
  submissionId?: string;
  submittedArtifacts?: Array<{ path: string; sha256: string; sizeBytes: number }>;
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

/** Bind a workspace-based submit adapter to the exact worktree that produced the run. */
export function submissionConfigForWorktree(
  root: string,
  worktreePath: string | undefined,
  competition: CompetitionConfig,
  configuredWorktreeBase = worktreeBasePath(root),
): CompetitionConfig {
  const config = competition.submission;
  if (!worktreePath || config?.source !== "workspace" || !config.workingDirectory) return competition;
  const projectRoot = realpathSync(resolve(root));
  const isInside = (parent: string, candidate: string): boolean => {
    const rel = relative(parent, candidate);
    return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
  };
  const experimentPath = resolve(worktreePath);
  const unresolvedBase = resolve(configuredWorktreeBase);
  const worktreeBase = existsSync(unresolvedBase) ? realpathSync(unresolvedBase) : unresolvedBase;
  if (!isInside(projectRoot, experimentPath) && !isInside(worktreeBase, experimentPath)) {
    throw new Error("Experiment worktree must be inside the Evidra project or its explicitly configured worktree root before a workspace submission can use it.");
  }
  const experimentRelativeToBase = relative(worktreeBase, experimentPath);
  const worktreeId = experimentRelativeToBase && !isAbsolute(experimentRelativeToBase) && !experimentRelativeToBase.startsWith(`..${sep}`)
    ? experimentRelativeToBase.split(sep)[0]
    : undefined;
  // Campaign records store the experiment working directory inside the Git
  // worktree. Resolve it against the configured root instead of assuming that
  // all worktrees live under <project>/.sota/worktrees.
  const unresolvedWorktreeRoot = worktreeId ? resolve(worktreeBase, worktreeId) : experimentPath;
  const worktreeRoot = existsSync(unresolvedWorktreeRoot) ? realpathSync(unresolvedWorktreeRoot) : unresolvedWorktreeRoot;
  if (worktreeRoot === worktreeBase || !isInside(worktreeBase, worktreeRoot)) throw new Error("Experiment worktree escapes its configured worktree root.");
  const configuredProjectDirectory = resolve(projectRoot, config.workingDirectory);
  if (!isInside(projectRoot, configuredProjectDirectory)) throw new Error("Configured submission working directory escapes the project root.");
  const checkedProjectDirectory = existsSync(configuredProjectDirectory) ? realpathSync(configuredProjectDirectory) : configuredProjectDirectory;
  if (!isInside(projectRoot, checkedProjectDirectory)) throw new Error("Configured submission working directory escapes the project root.");
  const worktreeDirectory = resolve(worktreeRoot, relative(projectRoot, configuredProjectDirectory));
  const checkedWorktreeDirectory = existsSync(worktreeDirectory) ? realpathSync(worktreeDirectory) : worktreeDirectory;
  if (!isInside(worktreeRoot, checkedWorktreeDirectory)) {
    throw new Error("Configured submission working directory escapes the Evidra project.");
  }
  const directoryRelativeToProject = isInside(projectRoot, checkedWorktreeDirectory)
    ? relative(projectRoot, checkedWorktreeDirectory)
    : checkedWorktreeDirectory;
  return {
    ...competition,
    submission: { ...config, workingDirectory: directoryRelativeToProject },
  };
}

/** Resolve the provider's identifier from a persisted submission receipt. */
export function externalSubmissionId(payload: unknown, fallback: string): string {
  if (!fallback.trim()) throw new Error("Submission bundle identifier must be non-empty.");
  if (!payload || typeof payload !== "object") return fallback;
  const receipt = (payload as { receipt?: unknown }).receipt;
  if (!receipt || typeof receipt !== "object") return fallback;
  const record = receipt as { submissionId?: unknown; stdout?: unknown };
  if (typeof record.submissionId === "string" && record.submissionId.trim()) return record.submissionId;
  return typeof record.stdout === "string" ? responseSubmissionId(record.stdout) ?? fallback : fallback;
}

function validateHttpUrl(raw: string, label: string): string {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`${label} must be a valid URL.`); }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !local) throw new Error(`${label} must use HTTPS unless it targets localhost.`);
  return parsed.toString();
}

function httpAuthHeaders(authEnv: string | undefined): Record<string, string> {
  if (!authEnv) return {};
  const token = process.env[authEnv];
  if (!token?.trim()) throw new Error(`HTTP submission requires credential environment variable '${authEnv}' to be set.`);
  return { Authorization: `Bearer ${token}` };
}

async function httpResponse(response: Response, label: string): Promise<string> {
  const maxBytes = 32_000;
  let body: string;
  if (!response.body) {
    body = "";
  } else {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < maxBytes) {
        const next = await reader.read();
        if (next.done) break;
        const remaining = maxBytes - total;
        const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
        const portion = chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk;
        chunks.push(portion);
        total += portion.byteLength;
        if (portion.byteLength < chunk.byteLength) {
          await reader.cancel();
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
    body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${redactSecrets(body || response.statusText)}`);
  return body;
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** Retry only safe/idempotent HTTP reads; callers must opt into the bound. */
async function fetchWithRetry(url: string, init: RequestInit, label: string, maxAttempts: number): Promise<Response> {
  const attempts = Math.max(1, Math.min(3, Math.floor(maxAttempts)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10 * 60_000) });
      if (attempt < attempts && retryableHttpStatus(response.status)) {
        await response.arrayBuffer();
        await new Promise<void>((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`${label} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export function responseSubmissionId(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const value = parsed as Record<string, unknown>;
      for (const key of ["submissionId", "submission_id", "id", "jobId", "job_id"]) if (typeof value[key] === "string" && value[key].trim()) return value[key];
    }
  } catch { /* permit text responses */ }
  return body.match(/(?:submission|job)(?:[_ -]?id)?(?:\s*[:=#]\s*|\s+)([A-Za-z0-9][A-Za-z0-9._:-]{0,127})/i)?.[1];
}

async function httpSubmit(file: string, config: NonNullable<CompetitionConfig["submission"]>): Promise<{ submissionId?: string; body: string }> {
  if (!config.submitUrl) throw new Error("HTTP submission requires submission.submitUrl.");
  const url = validateHttpUrl(config.submitUrl, "submission.submitUrl");
  const form = new FormData();
  form.append(config.fileField ?? "file", new Blob([readFileSync(file)]), basename(file));
  // POST is intentionally single-attempt: a timeout does not prove that the
  // remote service did not accept the submission, and replay could duplicate it.
  const response = await fetchWithRetry(url, { method: "POST", headers: httpAuthHeaders(config.authEnv), body: form }, "HTTP submission", 1);
  const body = await httpResponse(response, "HTTP submission");
  return { body, ...(responseSubmissionId(body) ? { submissionId: responseSubmissionId(body) } : {}) };
}

async function httpScore(submissionId: string, config: NonNullable<CompetitionConfig["submission"]>): Promise<{ score: number; body: string; url: string }> {
  if (!config.scoreUrl) throw new Error("HTTP score polling requires submission.scoreUrl.");
  const url = validateHttpUrl(config.scoreUrl.replaceAll("{submission}", encodeURIComponent(submissionId)), "submission.scoreUrl");
  const response = await fetchWithRetry(url, { method: "GET", headers: httpAuthHeaders(config.authEnv) }, "HTTP score polling", 3);
  const body = await httpResponse(response, "HTTP score polling");
  const score = parseSubmissionScore(body);
  if (score === undefined) throw new Error("HTTP score polling completed but emitted no finite score.");
  return { score, body, url };
}

function predictionFile(bundlePath: string, configured?: string): string {
  const candidateName = configured ?? readdirSync(bundlePath).find((name) => /submission|prediction/i.test(basename(name)));
  const candidate = candidateName ? safeBundlePath(bundlePath, candidateName) : undefined;
  if (!candidate || !existsSync(candidate)) throw new Error("Submission adapter could not find a configured prediction file in the bundle.");
  return candidate;
}

function substitute(command: string[], values: Record<string, string>, bundlePath: string, artifactPaths: string[] = []): string[] {
  return command.map((part) => part.replace(/\{(bundle|file|competition|message|submission)\}|\{artifact:([^{}]+)\}/g, (match, key: string | undefined, artifactPath: string | undefined) => {
    if (artifactPath !== undefined) {
      if (!artifactPaths.includes(artifactPath)) throw new Error(`Submission command references undeclared artifact '${artifactPath}'.`);
      const artifact = safeBundlePath(bundlePath, `source/${artifactPath}`);
      if (!artifact || !existsSync(artifact)) throw new Error(`Immutable submission artifact '${artifactPath}' is missing or unsafe.`);
      return artifact;
    }
    return values[key ?? ""] ?? match;
  }));
}

function submissionArtifactReceipts(bundlePath: string, artifactPaths: string[] = []): Array<{ path: string; sha256: string; sizeBytes: number }> {
  return artifactPaths.map((path) => {
    const file = safeBundlePath(bundlePath, `source/${path}`);
    if (!file || !existsSync(file)) throw new Error(`Immutable submission artifact '${path}' is missing or unsafe.`);
    return { path, sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), sizeBytes: statSync(file).size };
  });
}

function commandWorkingDirectory(root: string, configured?: string): string {
  const rootPath = realpathSync(resolve(root));
  const workingDirectory = configured ? resolve(rootPath, configured) : rootPath;
  // Lexical containment is insufficient when a configured directory is a
  // symlink. Resolve the existing path before allowing an authenticated
  // external command to run there.
  const checked = existsSync(workingDirectory) ? realpathSync(workingDirectory) : workingDirectory;
  const workingRelative = relative(rootPath, checked);
  if (isAbsolute(workingRelative) || workingRelative === ".." || workingRelative.startsWith(`..${sep}`)) {
    const externalWorktreeBase = resolve(worktreeBasePath(rootPath));
    const checkedBase = existsSync(externalWorktreeBase) ? realpathSync(externalWorktreeBase) : externalWorktreeBase;
    const externalRelative = relative(checkedBase, checked);
    if (isAbsolute(externalRelative) || externalRelative === ".." || externalRelative.startsWith(`..${sep}`)) throw new Error("Submission workingDirectory must stay inside the project or configured worktree root.");
  }
  return checked;
}

function kaggleCompetition(config: NonNullable<CompetitionConfig["submission"]>, competition: CompetitionConfig): string {
  const value = config.competition ?? competition.id;
  if (!value.trim()) throw new Error("Kaggle submission requires a competition slug.");
  return value;
}

function kaggleSubmitCommand(config: NonNullable<CompetitionConfig["submission"]>, competition: CompetitionConfig, file: string, message: string): string[] {
  return ["kaggle", "competitions", "submit", "-c", kaggleCompetition(config, competition), "-f", file, "-m", message];
}

function kaggleScoreCommand(config: NonNullable<CompetitionConfig["submission"]>, competition: CompetitionConfig): string[] {
  return ["kaggle", "competitions", "submissions", "-c", kaggleCompetition(config, competition), "--csv"];
}

/** Parse one bounded RFC 4180-style CSV row without adding a dependency to the CLI. */
function parseCsvRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) {
      cells.push(cell.trim()); cell = "";
    } else cell += character;
  }
  if (quoted) throw new Error("Malformed CSV score output: unterminated quoted field.");
  cells.push(cell.trim());
  return cells;
}

async function verifyKaggleAccess(config: NonNullable<CompetitionConfig["submission"]>, competition: CompetitionConfig, cwd: string, onProcess?: (control: ProcessControl) => void): Promise<void> {
  const command = ["kaggle", "competitions", "files", "-c", kaggleCompetition(config, competition)];
  const guard = guardCommand(command);
  if (!guard.allowed) throw new Error(`Kaggle access preflight refused: ${guard.reason}`);
  let result;
  try {
    result = await runProcess(command, cwd, 2 * 60_000, undefined, onProcess);
  } catch (error) {
    throw new Error(`Kaggle authentication/access preflight could not start: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  }
  if (result.exitCode !== 0) throw new Error(`Kaggle authentication or competition access failed: ${redactSecrets(result.stderr || result.stdout)}`);
}

/** Parse the intentionally small score protocol used by generic competition adapters. */
export function parseSubmissionScore(output: string, metricName?: string): number | undefined {
  const candidates: unknown[] = [];
  const csvScores: number[] = [];
  const normalizeKey = (value: string): string => value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  const recognizedKeys = new Set(["publicscore", "leaderboardscore", "score"]);
  if (metricName?.trim()) recognizedKeys.add(normalizeKey(metricName));
  for (const line of output.split(/\r?\n/)) {
    try {
      const parsed: unknown = JSON.parse(line.trim());
      if (parsed && typeof parsed === "object") {
        const value = parsed as Record<string, unknown>;
        for (const [key, score] of Object.entries(value)) if (recognizedKeys.has(normalizeKey(key))) candidates.push(score);
        const nested = value.result;
        if (nested && typeof nested === "object") {
          for (const [key, score] of Object.entries(nested as Record<string, unknown>)) if (recognizedKeys.has(normalizeKey(key))) candidates.push(score);
        }
      } else candidates.push(parsed);
    } catch { /* permit human-readable adapter output below */ }
  }
  // Kaggle's `competitions submissions --csv` emits a header followed by
  // rows, commonly using publicScore/privateScore columns without labels.
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length >= 2) {
    let header: string[];
    try { header = parseCsvRow(lines[0]!).map((value) => value.toLowerCase().replaceAll(/[^a-z0-9]/g, "")); }
    catch { header = []; }
    const scoreIndex = header.findIndex((value) => recognizedKeys.has(value));
    if (scoreIndex >= 0) {
      for (const line of lines.slice(1).reverse()) {
        try {
          const value = parseCsvRow(line)[scoreIndex];
          const score = value ? Number(value) : NaN;
          if (Number.isFinite(score)) csvScores.push(score);
        } catch { /* fall back to the other score formats */ }
      }
    }
  }
  // Prefer a structurally recognized CSV value over incidental `score: ...`
  // text in status logs or descriptions emitted alongside the table.
  if (csvScores.length) return csvScores.at(-1);
  const labelPattern = [...recognizedKeys].sort((a, b) => b.length - a.length).map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  for (const match of output.matchAll(new RegExp(`(?:${labelPattern})(?:\\s*[:=]\\s*|\\s+)(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?)`, "gi"))) candidates.push(match[1]);
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
    ? kaggleSubmitCommand(config!, competition, values.file, values.message)
    : substitute(config?.submitCommand ?? [], values, bundlePath, config?.artifactPaths ?? []);
  if (platform === "http") {
    if (!config) throw new Error("HTTP submission configuration is missing.");
    const file = predictionFile(bundlePath, config?.predictionFile);
    try {
      const response = await httpSubmit(file, config);
      return { validation, receipt: { platform, submittedAt: new Date().toISOString(), predictionFile: file, command: ["HTTP", "POST", redactSecrets(config.submitUrl ?? "")], ...(response.submissionId ? { submissionId: response.submissionId } : {}), stdout: redactSecrets(response.body), stderr: "" } };
    } catch (error) {
      throw new Error(`HTTP submission could not complete: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    }
  }
  if (!command.length) throw new Error("Command submission requires submission.submitCommand in competition.json.");
  const guard = guardCommand(command);
  if (!guard.allowed) throw new Error(`Submission command refused: ${guard.reason}`);
  const workingDirectory = commandWorkingDirectory(root, config?.workingDirectory);
  if (platform === "kaggle") await verifyKaggleAccess(config!, competition, workingDirectory, onProcess);
  const submittedArtifacts = submissionArtifactReceipts(bundlePath, config?.artifactPaths ?? []);
  let result;
  try {
    result = await runProcess(command, workingDirectory, 10 * 60_000, undefined, onProcess);
  } catch (error) {
    throw new Error(`External submission could not start: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  }
  if (result.exitCode !== 0) throw new Error(`External submission failed (${result.exitCode}): ${redactSecrets(result.stderr || result.stdout)}`);
  const artifactsAfterSubmit = submissionArtifactReceipts(bundlePath, config?.artifactPaths ?? []);
  if (JSON.stringify(artifactsAfterSubmit) !== JSON.stringify(submittedArtifacts)) {
    throw new Error("Submission command modified an immutable prepared artifact; external outcome requires reconciliation before retry.");
  }
  return {
    validation,
    receipt: { platform, submittedAt: new Date().toISOString(), predictionFile: file, command: redactCommand(command), ...(responseSubmissionId(result.stdout) ? { submissionId: responseSubmissionId(result.stdout) } : {}), ...(submittedArtifacts.length ? { submittedArtifacts } : {}), stdout: redactSecrets(result.stdout), stderr: redactSecrets(result.stderr) },
  };
}

/** Poll a platform through a configured read-only command and return a durable score observation. */
export async function pollSubmissionScore(root: string, bundlePath: string, submissionId: string, competition: CompetitionConfig, onProcess?: (control: ProcessControl) => void): Promise<SubmissionScoreObservation> {
  const validation = validateSubmissionBundle(bundlePath);
  if (!validation.valid) throw new Error("Submission bundle is invalid; refusing to poll its external score.");
  const config = competition.submission;
  const template = config?.scoreCommand ?? (config?.platform === "kaggle" ? kaggleScoreCommand(config, competition) : []);
  if (config?.platform === "http") {
    try {
      const response = await httpScore(submissionId, config);
      return { platform: "http", observedAt: new Date().toISOString(), score: response.score, command: ["HTTP", "GET", redactSecrets(response.url)], stdout: redactSecrets(response.body), stderr: "" };
    } catch (error) {
      throw new Error(`HTTP score polling could not complete: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    }
  }
  if (!template.length) throw new Error("No scoreCommand is configured. Add submission.scoreCommand or use submission record for a manually observed score.");
  const needsFile = Boolean(config?.predictionFile) || template.some((part) => part.includes("{file}"));
  const file = needsFile ? predictionFile(bundlePath, config?.predictionFile) : "";
  const command = substitute(template, { bundle: bundlePath, file, competition: config?.competition ?? competition.id, message: "", submission: submissionId }, bundlePath, config?.artifactPaths ?? []);
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
