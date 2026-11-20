import { existsSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import type { CompetitionConfig } from "./types.js";
import { loadUnitScores, pairedBootstrap, type PairedBootstrapResult, type UnitScoreTable } from "./unit-scores.js";
import { analyzeUnitLoss, lossAnalysisBrief, type LossAnalysisReport, type LossRun } from "./loss-analysis.js";
import type { RatchetPolicy } from "./ratchet.js";

/**
 * Glue between the campaign controller and the pure analysis modules: where
 * unit-score artifacts live, how they are loaded, and how the director's
 * pre-ideation loss analysis is assembled from the runs already on record.
 */

type UnitScoreConfig = NonNullable<CompetitionConfig["evaluator"]["unitScores"]>;

export const UNIT_SCORE_ARTIFACT_PREFIX = "unit-scores";

/** Evaluator unit-score output to preserve for a run, as {artifact name: absolute source path}. */
export function unitScoreFiles(config: Pick<CompetitionConfig, "evaluator">, cwd: string | undefined): Record<string, string> {
  const unitScores = config.evaluator.unitScores;
  if (!unitScores || !cwd) return {};
  const source = isAbsolute(unitScores.path) ? unitScores.path : resolve(cwd, unitScores.path);
  if (!existsSync(source)) return {};
  return { [`${UNIT_SCORE_ARTIFACT_PREFIX}${extname(source).toLowerCase() || ".csv"}`]: source };
}

/** The unit-score artifact among a run's recorded artifacts, if any. */
export function unitScoresArtifactPath(artifacts: unknown): string | undefined {
  if (!artifacts || typeof artifacts !== "object") return undefined;
  const entry = Object.entries(artifacts as Record<string, unknown>).find(([name, path]) => name.startsWith(UNIT_SCORE_ARTIFACT_PREFIX) && typeof path === "string");
  const path = entry?.[1] as string | undefined;
  return path && existsSync(path) ? path : undefined;
}

function pythonFor(config: Pick<CompetitionConfig, "evaluator">): string | undefined {
  const explicit = config.evaluator.unitScores?.python;
  if (explicit) return explicit;
  const interpreter = config.evaluator.command[0];
  return interpreter && /python/i.test(basename(interpreter)) ? interpreter : undefined;
}

const tableCache = new Map<string, UnitScoreTable>();

/** Load a unit-score artifact with the competition's column settings; artifacts are immutable, so cache by path. */
export function loadRunUnitScores(path: string, config: Pick<CompetitionConfig, "evaluator">): UnitScoreTable {
  const cached = tableCache.get(path);
  if (cached) return cached;
  const unitScores: Partial<UnitScoreConfig> = config.evaluator.unitScores ?? {};
  const table = loadUnitScores(path, { idColumn: unitScores.idColumn, scoreColumn: unitScores.scoreColumn, segmentColumns: unitScores.segmentColumns, python: pythonFor(config), logpColumn: unitScores.logpColumn, fallbackColumn: unitScores.fallbackColumn, scaleColumn: unitScores.scaleColumn });
  if (tableCache.size > 16) tableCache.delete(tableCache.keys().next().value as string);
  tableCache.set(path, table);
  return table;
}

export function unitScoreDirection(config: Pick<CompetitionConfig, "evaluator" | "metric">): "maximize" | "minimize" {
  return config.evaluator.unitScores?.direction ?? config.metric.direction;
}

/** Paired evidence between two runs' unit-score artifacts, or an explanation of why there is none. */
export function pairedRatchetEvidence(config: Pick<CompetitionConfig, "evaluator" | "metric">, referencePath: string | undefined, candidatePath: string | undefined, policy: RatchetPolicy): { paired?: PairedBootstrapResult; perSegment?: Record<string, PairedBootstrapResult>; note?: string } {
  if (!config.evaluator.unitScores) return { note: "evaluator.unitScores is not configured" };
  if (!referencePath || !candidatePath) return { note: `unit scores missing for the ${referencePath ? "candidate" : "reference"}` };
  try {
    const reference = loadRunUnitScores(referencePath, config);
    const candidate = loadRunUnitScores(candidatePath, config);
    const options = { direction: unitScoreDirection(config), iterations: policy.iterations, confidence: policy.confidence, clusterBy: policy.clusterBy, trim: policy.trim };
    const paired = pairedBootstrap(reference.units, candidate.units, options);
    const column = policy.segmentColumn;
    const wanted = [...(policy.requireSegments ?? []), ...(policy.guardSegments ?? [])];
    if (!column || !wanted.length) return { paired };
    const perSegment: Record<string, PairedBootstrapResult> = {};
    for (const segment of wanted) {
      const pick = (units: typeof reference.units) => units.filter((unit) => String(unit.segments[column]) === segment);
      const candidateUnits = pick(candidate.units);
      if (candidateUnits.length) perSegment[segment] = pairedBootstrap(pick(reference.units), candidateUnits, options);
    }
    return { paired, perSegment };
  } catch (error) {
    return { note: `unit scores unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

interface AnalysisStore {
  eventsByType(type: string): Array<{ payload: unknown; createdAt?: string }>;
  runs(): Array<{ id: string; payload: unknown }>;
  experiments(): Array<{ id: string; payload: unknown; createdAt?: string }>;
}

/**
 * The director's loss analysis: the champion (or baseline) as the primary
 * run, compared with the baseline and the most recent completed runs that
 * wrote unit scores. Returns undefined when no run has unit scores.
 */
export function campaignLossAnalysis(store: AnalysisStore, config: Pick<CompetitionConfig, "evaluator" | "metric">, championExperimentId: string | undefined, maxRuns = 4): { report: LossAnalysisReport; brief: Record<string, unknown> } | { error: string } | undefined {
  if (!config.evaluator.unitScores) return undefined;
  const runs: Array<{ id: string; label: string; path: string }> = [];
  const runById = new Map(store.runs().map((run) => [run.id, run.payload as { artifacts?: unknown; status?: unknown }]));
  const champion = championExperimentId ? store.experiments().find((entry) => entry.id === championExperimentId) : undefined;
  const championRunId = (champion?.payload as { runId?: unknown } | undefined)?.runId;
  const championPath = typeof championRunId === "string" ? unitScoresArtifactPath(runById.get(championRunId)?.artifacts) : undefined;
  if (championPath && typeof championRunId === "string") runs.push({ id: championExperimentId!, label: "champion", path: championPath });
  const baseline = store.eventsByType("baseline.completed").at(-1)?.payload as { runId?: unknown; artifactPaths?: unknown } | undefined;
  const baselinePath = unitScoresArtifactPath(baseline?.artifactPaths);
  if (baselinePath) runs.push({ id: typeof baseline?.runId === "string" ? baseline.runId : "baseline", label: "baseline", path: baselinePath });
  const recent = [...store.experiments()].sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
  for (const entry of recent) {
    if (runs.length >= maxRuns) break;
    if (entry.id === championExperimentId) continue;
    const runId = (entry.payload as { runId?: unknown }).runId;
    const path = typeof runId === "string" ? unitScoresArtifactPath(runById.get(runId)?.artifacts) : undefined;
    if (path && !runs.some((run) => run.path === path)) runs.push({ id: entry.id, label: "recent", path });
  }
  if (!runs.length) return undefined;
  try {
    const lossRuns: LossRun[] = runs.map((run) => ({ id: run.id, label: run.label, table: loadRunUnitScores(run.path, config) }));
    const report = analyzeUnitLoss(lossRuns, { direction: unitScoreDirection(config), foldBy: config.evaluator.unitScores?.foldBy });
    return { report, brief: lossAnalysisBrief(report) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
