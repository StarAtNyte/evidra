import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { sha256File } from "./evidence.js";
import { guardAutonomousCommand } from "./permissions.js";
import { runProcess, type ProcessControl } from "./process.js";

/** A stepwise, agent-agnostic task contract for scientific and engineering work. */
export const ScientificTaskStageSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/),
  title: z.string().min(1).max(200),
  objective: z.string().min(1).max(2_000),
  command: z.array(z.string().min(1)).min(1),
  cwd: z.string().default("."),
  timeoutMinutes: z.number().positive().max(24 * 60).default(15),
  retries: z.number().int().nonnegative().max(3).default(1),
  alternateCommands: z.array(z.array(z.string().min(1)).min(1)).max(3).default([]),
  requiredArtifacts: z.array(z.string().min(1)).max(32).default([]),
  verificationCommands: z.array(z.array(z.string().min(1)).min(1)).max(16).default([]),
  snapshotPaths: z.array(z.string().min(1)).max(32).default([]),
});

export const ScientificTaskSchema = z.object({
  schemaVersion: z.number().int().positive().default(1),
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/),
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(8_000),
  stages: z.array(ScientificTaskStageSchema).min(1).max(32),
}).superRefine((task, context) => {
  const ids = new Set<string>();
  for (const [index, stage] of task.stages.entries()) {
    if (ids.has(stage.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["stages", index, "id"], message: "stage IDs must be unique" });
    ids.add(stage.id);
    for (const [field, values] of [["requiredArtifacts", stage.requiredArtifacts], ["snapshotPaths", stage.snapshotPaths], ["verificationCommands", stage.verificationCommands.map((command) => JSON.stringify(command))]] as const) {
      if (new Set(values).size !== values.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["stages", index, field], message: `${field} must contain unique entries` });
    }
  }
});

export type ScientificTask = z.infer<typeof ScientificTaskSchema>;
export type ScientificTaskStage = z.infer<typeof ScientificTaskStageSchema>;

function taskFingerprint(task: ScientificTask): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(task)).digest("hex")}`;
}

const ScientificVerificationSchema = z.object({
  declared: z.number().int().nonnegative(),
  executed: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
}).superRefine((verification, context) => {
  if (verification.executed > verification.declared) context.addIssue({ code: z.ZodIssueCode.custom, path: ["executed"], message: "executed verifiers cannot exceed declared verifiers" });
  if (verification.passed + verification.failed > verification.executed) context.addIssue({ code: z.ZodIssueCode.custom, path: ["passed"], message: "passed and failed verifiers cannot exceed executed verifiers" });
});

export const ScientificStageObservationSchema = z.object({
  stageId: z.string().min(1),
  status: z.enum(["completed", "failed", "interrupted", "resumed"]),
  exitCode: z.number().int(),
  durationMs: z.number().nonnegative(),
  verification: ScientificVerificationSchema,
  artifacts: z.record(z.string(), z.string()),
  snapshot: z.object({ id: z.string().min(1), files: z.record(z.string(), z.string()) }),
  stdoutTail: z.string(),
  stderrTail: z.string(),
  attempts: z.array(z.object({
    attempt: z.number().int().positive(),
    route: z.enum(["primary", "alternate"]),
    command: z.array(z.string().min(1)).min(1),
    exitCode: z.number().int(),
    durationMs: z.number().nonnegative(),
    verification: ScientificVerificationSchema,
    stdoutTail: z.string(),
    stderrTail: z.string(),
  })).max(4).optional(),
});

export const ScientificTaskRunSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().min(1),
  taskFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  status: z.enum(["completed", "failed", "interrupted"]),
  stages: z.array(ScientificStageObservationSchema).max(32),
}).superRefine((run, context) => {
  const ids = run.stages.map((stage) => stage.stageId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["stages"], message: "stage observations must be unique" });
});

export interface ScientificStageObservation {
  stageId: string;
  status: "completed" | "failed" | "interrupted" | "resumed";
  exitCode: number;
  durationMs: number;
  verification: { declared: number; executed: number; passed: number; failed: number };
  artifacts: Record<string, string>;
  snapshot: { id: string; files: Record<string, string> };
  stdoutTail: string;
  stderrTail: string;
  attempts?: Array<{ attempt: number; route: "primary" | "alternate"; command: string[]; exitCode: number; durationMs: number; verification: { declared: number; executed: number; passed: number; failed: number }; stdoutTail: string; stderrTail: string }>;
}

export interface ScientificTaskRun {
  schemaVersion: 1;
  taskId: string;
  taskFingerprint: string;
  startedAt: string;
  completedAt?: string;
  status: "completed" | "failed" | "interrupted";
  stages: ScientificStageObservation[];
}

export interface ScientificTaskEvaluation {
  valid: boolean;
  completed: boolean;
  stageScore: number;
  processQuality: number;
  missingStages: string[];
  invalidStages: string[];
  reason: string;
}

function containedPath(root: string, requested: string, label: string): string {
  if (isAbsolute(requested)) throw new Error(`${label} must be relative: ${requested}`);
  const rootPath = realpathSync(resolve(root));
  const candidate = resolve(rootPath, requested);
  const checked = existsSync(candidate) ? realpathSync(candidate) : candidate;
  const escaped = relative(rootPath, checked);
  if (escaped.startsWith("..") || isAbsolute(escaped)) throw new Error(`${label} escapes task workspace: ${requested}`);
  return checked;
}

function fileSnapshot(cwd: string, paths: string[], label: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const requested of paths) {
    const path = containedPath(cwd, requested, label);
    if (!existsSync(path) || !statSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error(`${label} must name a regular file: ${requested}`);
    files[requested] = sha256File(path);
  }
  return files;
}

function snapshotId(files: Record<string, string>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest("hex")}`;
}

function verifyObservation(task: ScientificTask, observation: ScientificStageObservation): string | undefined {
  const stage = task.stages.find((candidate) => candidate.id === observation.stageId);
  if (!stage) return "unknown stage";
  if (observation.status !== "completed" && observation.status !== "resumed") return "stage did not complete";
  if (observation.exitCode !== 0) return "stage command failed";
  if (observation.verification.executed !== observation.verification.declared || observation.verification.failed > 0 || observation.verification.passed !== observation.verification.declared) return "verification contract is incomplete";
  for (const artifact of stage.requiredArtifacts) if (!observation.artifacts[artifact]) return `required artifact is missing: ${artifact}`;
  for (const path of stage.snapshotPaths) if (!observation.snapshot.files[path]) return `snapshot file is missing: ${path}`;
  if (observation.snapshot.id !== snapshotId(observation.snapshot.files)) return "snapshot checksum is inconsistent";
  return undefined;
}

function resumableObservation(task: ScientificTask, stage: ScientificTaskStage, cwd: string, observation: ScientificStageObservation): boolean {
  if (verifyObservation(task, observation)) return false;
  try {
    const currentFiles = fileSnapshot(cwd, stage.snapshotPaths, `stage '${stage.id}' snapshot`);
    if (JSON.stringify(currentFiles) !== JSON.stringify(observation.snapshot.files) || snapshotId(currentFiles) !== observation.snapshot.id) return false;
    for (const artifact of stage.requiredArtifacts) {
      const current = fileSnapshot(cwd, [artifact], `stage '${stage.id}' artifact`)[artifact];
      if (current !== observation.artifacts[artifact]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Score intermediate progress without collapsing a multi-stage task into one final answer. */
export function evaluateScientificTaskRun(taskValue: unknown, run: ScientificTaskRun): ScientificTaskEvaluation {
  const task = ScientificTaskSchema.parse(taskValue);
  const parsedRun = ScientificTaskRunSchema.parse(run);
  const byId = new Map(parsedRun.stages.map((stage) => [stage.stageId, stage]));
  const missingStages = task.stages.filter((stage) => !byId.has(stage.id)).map((stage) => stage.id);
  const orderMismatch = parsedRun.stages.some((stage, index) => task.stages[index]?.id !== stage.stageId);
  const invalidStages = task.stages.flatMap((stage) => {
    const observation = byId.get(stage.id);
    const reason = observation ? verifyObservation(task, observation) : undefined;
    return reason ? [`${stage.id}: ${reason}`] : [];
  });
  if (orderMismatch) invalidStages.push("stage observations are out of task order");
  const validStages = task.stages.length - missingStages.length - invalidStages.length;
  const stageScore = validStages / task.stages.length;
  if (parsedRun.taskId !== task.id) invalidStages.push(`run task ID '${parsedRun.taskId}' does not match task '${task.id}'`);
  const processQuality = Math.min(1, Math.max(0, (stageScore * 0.7) + (parsedRun.stages.length === task.stages.length ? 0.2 : 0) + (parsedRun.status === "completed" ? 0.1 : 0)));
  const valid = missingStages.length === 0 && invalidStages.length === 0 && parsedRun.status === "completed";
  return { valid, completed: valid, stageScore, processQuality, missingStages, invalidStages, reason: valid ? "all stages and verifiers completed" : [...missingStages.map((id) => `missing stage: ${id}`), ...invalidStages].join("; ") || `run status is ${parsedRun.status}` };
}

export interface ScientificTaskRunOptions {
  onProgress?: (message: string) => void;
  onProcess?: (control: ProcessControl) => void;
  isCancelled?: () => boolean;
  /** Completed observations from a previous controller process; valid stages are resumed. */
  previous?: ScientificTaskRun;
}

async function executeScientificStage(stage: ScientificTaskStage, cwd: string, options: ScientificTaskRunOptions): Promise<ScientificStageObservation> {
  const deadline = Date.now() + stage.timeoutMinutes * 60_000;
  const commands = [stage.command, ...stage.alternateCommands];
  const attempts: NonNullable<ScientificStageObservation["attempts"]> = [];
  let finalObservation: ScientificStageObservation | undefined;
  const maxAttempts = 1 + stage.retries;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const command = commands[Math.min(attempt, commands.length - 1)] ?? stage.command;
    const route: "primary" | "alternate" = attempt === 0 || commands.length === 1 ? "primary" : "alternate";
    const result = await runProcessObserved(command, cwd, Math.max(1, deadline - Date.now()), options.onProcess);
    const artifacts: Record<string, string> = {};
    for (const artifact of stage.requiredArtifacts) {
      const path = containedPath(cwd, artifact, `stage '${stage.id}' artifact`);
      if (existsSync(path) && statSync(path).isFile() && !lstatSync(path).isSymbolicLink()) artifacts[artifact] = sha256File(path);
    }
    let executed = 0;
    let passed = 0;
    let failed = 0;
    for (const verificationCommand of stage.verificationCommands) {
      const remaining = deadline - Date.now();
      if (remaining < 1) break;
      executed += 1;
      const verification = await runProcessObserved(verificationCommand, cwd, remaining, undefined);
      if (verification.exitCode === 0) passed += 1; else failed += 1;
    }
    let files: Record<string, string> = {};
    let snapshotError: string | undefined;
    try { files = fileSnapshot(cwd, stage.snapshotPaths, `stage '${stage.id}' snapshot`); } catch (error) { snapshotError = error instanceof Error ? error.message : String(error); }
    const stageFailed = result.exitCode !== 0 || failed > 0 || artifactsMissing(stage, artifacts) || Boolean(snapshotError);
    const attemptObservation = { attempt: attempt + 1, route, command: [...command], exitCode: result.exitCode, durationMs: result.durationMs, verification: { declared: stage.verificationCommands.length, executed, passed, failed }, stdoutTail: result.stdout.slice(-4_000), stderrTail: `${result.stderr}${snapshotError ? `\nSnapshot failed: ${snapshotError}` : ""}`.slice(-4_000) };
    attempts.push(attemptObservation);
    finalObservation = { stageId: stage.id, status: !stageFailed ? "completed" : "failed", exitCode: result.exitCode, durationMs: attempts.reduce((sum, item) => sum + item.durationMs, 0), verification: attemptObservation.verification, artifacts, snapshot: { id: snapshotId(files), files }, stdoutTail: attemptObservation.stdoutTail, stderrTail: attemptObservation.stderrTail };
    if (!stageFailed || options.isCancelled?.()) break;
    if (attempt + 1 < maxAttempts) options.onProgress?.(`Scientific task · ${stage.id} failed on ${route}; trying ${attempt + 2}/${maxAttempts}`);
  }
  if (!finalObservation) throw new Error(`Scientific stage '${stage.id}' produced no observation.`);
  return attempts.length > 1 ? { ...finalObservation, attempts } : finalObservation;
}

/** Execute stages in order, verifying and snapshotting every boundary for restart/resume. */
export async function runScientificTask(taskValue: unknown, root: string, options: ScientificTaskRunOptions = {}): Promise<ScientificTaskRun> {
  const task = ScientificTaskSchema.parse(taskValue);
  const fingerprint = taskFingerprint(task);
  const previous = options.previous ? ScientificTaskRunSchema.parse(options.previous) : undefined;
  if (previous && (previous.taskId !== task.id || previous.taskFingerprint !== fingerprint)) throw new Error(`Previous scientific task report does not match task contract '${task.id}'.`);
  const startedAt = new Date().toISOString();
  const stages: ScientificStageObservation[] = [];
  for (const stage of task.stages) {
    const cwd = containedPath(root, stage.cwd, `stage '${stage.id}' cwd`);
    const previousStage = previous?.stages.find((observation) => observation.stageId === stage.id);
    if (previousStage && resumableObservation(task, stage, cwd, previousStage)) {
      stages.push({ ...previousStage, status: "resumed" });
      options.onProgress?.(`Scientific task · ${stage.id} · resumed from verified snapshot`);
      continue;
    }
    if (options.isCancelled?.()) return { schemaVersion: 1, taskId: task.id, taskFingerprint: fingerprint, startedAt, status: "interrupted", stages };
    options.onProgress?.(`Scientific task · ${stage.id} · ${stage.title}`);
    const observation = await executeScientificStage(stage, cwd, options);
    stages.push(observation);
    if (observation.status === "failed" || options.isCancelled?.()) break;
  }
  const status = stages.length === task.stages.length && stages.every((stage) => !verifyObservation(task, stage)) ? "completed" : options.isCancelled?.() ? "interrupted" : "failed";
  return { schemaVersion: 1, taskId: task.id, taskFingerprint: fingerprint, startedAt, ...(status === "completed" ? { completedAt: new Date().toISOString() } : {}), status, stages };
}

function artifactsMissing(stage: ScientificTaskStage, artifacts: Record<string, string>): boolean {
  return stage.requiredArtifacts.some((artifact) => !artifacts[artifact]);
}

async function runProcessObserved(command: string[], cwd: string, timeoutMs: number, onProcess?: (control: ProcessControl) => void): Promise<ProcessResultLike> {
  const guard = guardAutonomousCommand(command);
  if (!guard.allowed) {
    return {
      command,
      cwd,
      exitCode: 126,
      durationMs: 0,
      stdout: "",
      stderr: `Permission denied by Evidra: ${guard.reason ?? "command is not permitted"}`,
    };
  }
  try {
    return await runProcess(command, cwd, timeoutMs, undefined, onProcess);
  } catch (error) {
    return {
      command,
      cwd,
      exitCode: 127,
      durationMs: 0,
      stdout: "",
      stderr: `Process could not start: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

type ProcessResultLike = Awaited<ReturnType<typeof runProcess>>;
