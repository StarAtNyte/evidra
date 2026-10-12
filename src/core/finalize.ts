import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ResearchStore } from "./store.js";
import type { ProcessResult } from "./types.js";

export interface FinalCandidate {
  experimentId: string;
  runId: string;
  metric: number;
  accepted: boolean;
  worktreePath: string;
}

/** Choose the campaign's own final output: the best validated experiment, or,
 * when nothing passed validation, the best completed run that still beats the
 * baseline. The choice is the controller's, so a locked run never needs a
 * person to pick among its intermediate outputs. */
export function selectFinalCandidate(store: ResearchStore, metricName: string, direction: "maximize" | "minimize", baselineMetric?: number): FinalCandidate | undefined {
  const accepted = new Set(store.eventsByType("experiment.validation.assessed")
    .filter((event) => Boolean((event.payload as { acceptance?: { accepted?: unknown } }).acceptance?.accepted))
    .map((event) => (event.payload as { experimentId?: unknown }).experimentId)
    .filter((id): id is string => typeof id === "string"));
  const runs = new Map(store.runs().map((run) => [run.id, run]));
  const better = (a: number, b: number): boolean => direction === "maximize" ? a > b : a < b;
  const candidates: FinalCandidate[] = [];
  for (const experiment of store.experiments()) {
    const payload = experiment.payload as { runId?: unknown; worktreePath?: unknown; parent?: unknown };
    if (typeof payload.runId !== "string" || typeof payload.worktreePath !== "string" || !existsSync(payload.worktreePath)) continue;
    const run = runs.get(payload.runId);
    const runPayload = run?.payload as { exitCode?: unknown; metrics?: Record<string, unknown> } | undefined;
    const metric = Number(runPayload?.metrics?.[metricName]);
    if (!run || runPayload?.exitCode !== 0 || !Number.isFinite(metric)) continue;
    const isAccepted = accepted.has(experiment.id) || (typeof payload.parent === "string" && accepted.has(payload.parent));
    candidates.push({ experimentId: experiment.id, runId: run.id, metric, accepted: isAccepted, worktreePath: payload.worktreePath });
  }
  const pick = (pool: FinalCandidate[]): FinalCandidate | undefined => pool.reduce<FinalCandidate | undefined>((best, item) => !best || better(item.metric, best.metric) ? item : best, undefined);
  const validated = pick(candidates.filter((item) => item.accepted));
  if (validated) return validated;
  const fallback = pick(candidates);
  if (fallback && (baselineMetric === undefined || better(fallback.metric, baselineMetric))) return fallback;
  return undefined;
}

export interface FinalizeRecord extends FinalCandidate {
  command: string[];
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  finishedAt: string;
}

/** Run the manifest's finalize command inside the chosen experiment's worktree
 * and persist the outcome as campaign evidence. */
export async function runCampaignFinalize(input: {
  store: ResearchStore;
  stateDirectory: string;
  root: string;
  workspaceRoot: string;
  candidate: FinalCandidate;
  command: string[];
  timeoutMs: number;
  environment: NodeJS.ProcessEnv;
  run: (command: string[], cwd: string, timeoutMs: number, environment: NodeJS.ProcessEnv) => Promise<ProcessResult>;
}): Promise<FinalizeRecord> {
  const cwd = join(input.candidate.worktreePath, relative(input.root, input.workspaceRoot));
  input.store.appendEvent("campaign.finalize.started", { ...input.candidate, command: input.command, cwd });
  const started = Date.now();
  let result: ProcessResult | undefined;
  let failure: string | undefined;
  try { result = await input.run(input.command, cwd, input.timeoutMs, input.environment); }
  catch (error) { failure = error instanceof Error ? error.message : String(error); }
  const record: FinalizeRecord = {
    ...input.candidate,
    command: input.command,
    cwd,
    exitCode: result?.exitCode ?? null,
    durationMs: Date.now() - started,
    stdoutTail: (result?.stdout ?? "").slice(-8_000),
    stderrTail: (failure ?? result?.stderr ?? "").slice(-8_000),
    finishedAt: new Date().toISOString(),
  };
  const directory = join(input.stateDirectory, "final");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "final.json"), `${JSON.stringify(record, null, 2)}\n`);
  input.store.appendEvent(record.exitCode === 0 ? "campaign.finalize.completed" : "campaign.finalize.failed", record);
  return record;
}
