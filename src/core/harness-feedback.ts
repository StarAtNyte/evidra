import { redactSecrets } from "./redaction.js";

export type HarnessFeedbackRole = "unclassified" | "feedback" | "selection" | "held_out";

export function parseHarnessFeedbackRole(value: unknown): HarnessFeedbackRole {
  if (value === undefined) return "unclassified";
  if (value === "unclassified" || value === "feedback" || value === "selection" || value === "held_out") return value;
  throw new Error("adaptationRole must be unclassified, feedback, selection, or held_out.");
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, limit = 96): string | undefined => typeof value === "string" ? redactSecrets(value).slice(-limit) : undefined;

/** Persist only bounded failure diagnostics; raw successful outputs never enter feedback. */
export function projectHarnessFailureFeedback(source: unknown[]): { runs: unknown[]; totalRunCount: number; omittedFailureRuns: number } {
  const projected = { runs: [] as unknown[], totalRunCount: source.length, omittedFailureRuns: 0 };
  let failures = 0;
  for (const value of source) {
    const run = record(value), result = record(run.result);
    if (!(typeof run.failureClass === "string" && run.failureClass || typeof result.exitCode === "number" && Number.isInteger(result.exitCode) && result.exitCode !== 0)) continue;
    failures += 1;
    projected.runs.push({ harness: text(run.harness), failureClass: text(run.failureClass), result: {
      exitCode: typeof result.exitCode === "number" && Number.isInteger(result.exitCode) ? result.exitCode : undefined,
      stderr: text(result.stderr, 512),
    } });
    if (projected.runs.length > 6) projected.runs.shift();
    projected.omittedFailureRuns = failures - projected.runs.length;
    while (Buffer.byteLength(JSON.stringify(projected), "utf8") > 4096 && projected.runs.length) {
      projected.runs.shift();
      projected.omittedFailureRuns = failures - projected.runs.length;
    }
  }
  return projected;
}

/** Bounded revision diagnostics, independent of the immutable benchmark records. */
export function formatHarnessFeedback(evidence: unknown[]): string {
  const packet: { schemaVersion: number; omittedHeldOut: number; omittedReports: number; reports: unknown[] } = { schemaVersion: 1, omittedHeldOut: 0, omittedReports: 0, reports: [] };
  const eligible = evidence.filter((value) => {
    if (record(value).adaptationRole === "held_out") { packet.omittedHeldOut += 1; return false; }
    return true;
  });
  packet.omittedReports = Math.max(0, eligible.length - 3);
  for (const value of eligible.slice(-3)) {
    const report = record(value), trials = Array.isArray(report.trials) ? report.trials : [], runs = Array.isArray(report.runs) ? report.runs : [];
    const role = report.adaptationRole === "feedback" || report.adaptationRole === "selection" ? report.adaptationRole : "unclassified";
    const selected = {
      protocolFingerprint: text(report.protocolFingerprint), startedAt: text(report.startedAt), role,
      trialCount: trials.length, runCount: runs.length,
      totalRunCount: typeof report.totalRunCount === "number" && Number.isInteger(report.totalRunCount) && report.totalRunCount >= runs.length ? report.totalRunCount : undefined,
      omittedFailureRuns: typeof report.omittedFailureRuns === "number" && Number.isInteger(report.omittedFailureRuns) && report.omittedFailureRuns >= 0 ? report.omittedFailureRuns : undefined,
      scorecards: (Array.isArray(report.scorecards) ? report.scorecards : []).slice(0, 3).map((value) => {
        const score = record(value);
        return { harness: text(score.harness), competitiveScore: typeof score.competitiveScore === "number" && Number.isFinite(score.competitiveScore) ? score.competitiveScore : undefined,
          failureProfile: Object.fromEntries(Object.entries(record(score.failureProfile)).slice(0, 3).filter(([, count]) => typeof count === "number" && Number.isFinite(count)).map(([name, count]) => [text(name, 48), count])) };
      }),
      comparisons: (Array.isArray(report.comparisons) ? report.comparisons : []).slice(0, 3).map((value) => {
        const comparison = record(value);
        return { incumbent: text(comparison.incumbent), challengerWins: typeof comparison.challengerWins === "boolean" ? comparison.challengerWins : undefined, reason: text(comparison.reason, 128) };
      }),
      trials: trials.slice(0, 6).map((value) => {
        const trial = record(value);
        return { harness: text(trial.harness), task: text(trial.task), seed: text(String(trial.seed ?? "")), validRun: typeof trial.validRun === "boolean" ? trial.validRun : undefined, failureClass: text(trial.failureClass), candidateMetric: typeof trial.candidateMetric === "number" && Number.isFinite(trial.candidateMetric) ? trial.candidateMetric : undefined };
      }),
      runs: runs.slice(0, 6).map((value) => {
        const run = record(value), result = record(run.result);
        return { harness: text(run.harness), failureClass: text(run.failureClass), exitCode: typeof result.exitCode === "number" && Number.isInteger(result.exitCode) ? result.exitCode : undefined,
          ...(role === "feedback" ? { stderrExcerpt: text(result.stderr, 512) } : {}) };
      }),
    };
    packet.reports.push(selected);
    const oversized = (): boolean => Buffer.byteLength(JSON.stringify(packet), "utf8") > 8000;
    while (oversized() && packet.reports.length > 1) { packet.reports.shift(); packet.omittedReports += 1; }
    while (oversized() && selected.runs.length > 1) selected.runs.pop();
    while (oversized() && selected.trials.length > 1) selected.trials.pop();
    while (oversized() && selected.scorecards.length > 1) selected.scorecards.pop();
    while (oversized() && selected.comparisons.length > 1) selected.comparisons.pop();
    if (oversized()) { packet.reports.pop(); packet.omittedReports += 1; }
  }
  return JSON.stringify(packet);
}
