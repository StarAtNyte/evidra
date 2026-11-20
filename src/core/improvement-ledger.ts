import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A persistent record of every ratchet step, accepted or rejected, so a
 * campaign's improvements (and its near misses) stay auditable after the
 * session ends. Each entry is hash-chained to the previous one
 * (kernel-autoresearch's ledger idea) so silent edits are detectable, and
 * files are replaced atomically (write temp, fsync, rename) so a crash never
 * leaves a half-written ledger.
 */
export interface ImprovementEntry {
  seq: number;
  recordedAt: string;
  campaignStartedAt?: string;
  experimentId: string;
  runId?: string;
  stage: "screen" | "full" | "holdout";
  title?: string;
  family?: string;
  techniqueClass?: string;
  metricName: string;
  direction: "maximize" | "minimize";
  referenceId?: string;
  referenceMetric?: number | null;
  candidateMetric?: number | null;
  /** Oriented so positive is better. */
  improvement?: number | null;
  accepted: boolean;
  verdict: string;
  mode: string;
  reason: string;
  ci?: { lower: number; upper: number; confidence: number; matched: number; probabilityImproved: number };
  /** Per-stratum gate evidence (for example per dataset). */
  segments?: Array<{ segment: string; role: string; lower?: number; upper?: number; meanImprovement?: number; matched?: number; passed: boolean | null }>;
  /** Measured run resources and the hosted-limit check (peak RSS, wall). */
  resources?: { peakRssMb?: number; wallSeconds?: number; predictedHostedWallSeconds?: number; ok: boolean; reasons: string[] };
  prev: string;
  sha: string;
}

export type ImprovementInput = Omit<ImprovementEntry, "seq" | "recordedAt" | "prev" | "sha"> & { recordedAt?: string };

const GENESIS = "genesis";

function entryHash(entry: Omit<ImprovementEntry, "sha">): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = openSync(temporary, "w");
  try {
    writeSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
}

export function ledgerPaths(stateDirectory: string): { json: string; markdown: string } {
  return { json: join(stateDirectory, "improvements.json"), markdown: join(stateDirectory, "IMPROVEMENTS.md") };
}

export function readImprovementLedger(stateDirectory: string): ImprovementEntry[] {
  const { json } = ledgerPaths(stateDirectory);
  if (!existsSync(json)) return [];
  try {
    const parsed = JSON.parse(readFileSync(json, "utf8")) as { entries?: unknown };
    return Array.isArray(parsed.entries) ? parsed.entries as ImprovementEntry[] : [];
  } catch {
    return [];
  }
}

/** Verify the hash chain; returns the first broken sequence number, if any. */
export function verifyImprovementLedger(entries: readonly ImprovementEntry[]): { valid: boolean; brokenAt?: number } {
  let prev = GENESIS;
  for (const entry of entries) {
    const { sha, ...rest } = entry;
    if (entry.prev !== prev || entryHash(rest) !== sha) return { valid: false, brokenAt: entry.seq };
    prev = sha;
  }
  return { valid: true };
}

/** Append one ratchet step; idempotent on (experimentId, stage, runId) so a resumed campaign does not double-count. */
export function appendImprovement(stateDirectory: string, input: ImprovementInput): ImprovementEntry {
  const entries = readImprovementLedger(stateDirectory);
  const existing = entries.find((entry) => entry.experimentId === input.experimentId && entry.stage === input.stage && entry.runId === input.runId);
  if (existing) return existing;
  const base: Omit<ImprovementEntry, "sha"> = {
    ...input,
    seq: (entries.at(-1)?.seq ?? 0) + 1,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    prev: entries.at(-1)?.sha ?? GENESIS,
  };
  const entry: ImprovementEntry = { ...base, sha: entryHash(base) };
  const next = [...entries, entry];
  const paths = ledgerPaths(stateDirectory);
  writeFileAtomic(paths.json, `${JSON.stringify({ schemaVersion: 1, entries: next }, null, 2)}\n`);
  writeFileAtomic(paths.markdown, renderImprovementLedger(next));
  return entry;
}

function formatNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toPrecision(6)).toString() : "-";
}

/** Markdown view: cumulative accepted improvements first, then every step. */
export function renderImprovementLedger(entries: readonly ImprovementEntry[]): string {
  const accepted = entries.filter((entry) => entry.accepted && entry.stage === "full");
  const cumulative = accepted.reduce((sum, entry) => sum + (typeof entry.improvement === "number" && Number.isFinite(entry.improvement) ? entry.improvement : 0), 0);
  const chain = verifyImprovementLedger(entries);
  const lines = [
    "# Improvements ledger",
    "",
    `Every ratchet step Evidra took, accepted or rejected. ${accepted.length} accepted full-evaluation step(s), cumulative improvement ${formatNumber(cumulative)}. Hash chain: ${chain.valid ? "intact" : `BROKEN at #${chain.brokenAt}`}.`,
    "",
    "## Accepted",
    "",
    "| # | date | experiment | family / class | metric | reference -> candidate | improvement | evidence |",
    "|---|---|---|---|---|---|---|---|",
    ...accepted.map((entry) => `| ${entry.seq} | ${entry.recordedAt.slice(0, 16)} | ${entry.experimentId}${entry.title ? ` (${entry.title.replace(/\|/g, "/")})` : ""} | ${entry.family ?? "-"} / ${entry.techniqueClass ?? "-"} | ${entry.metricName} | ${formatNumber(entry.referenceMetric)} -> ${formatNumber(entry.candidateMetric)} | ${formatNumber(entry.improvement)} | ${entry.mode}${entry.ci ? ` CI [${formatNumber(entry.ci.lower)}, ${formatNumber(entry.ci.upper)}] n=${entry.ci.matched}` : ""} |`),
    "",
    "## All steps",
    "",
    "| # | stage | experiment | class | candidate | improvement | verdict | peak RSS / wall | reason |",
    "|---|---|---|---|---|---|---|---|---|",
    ...entries.map((entry) => `| ${entry.seq} | ${entry.stage} | ${entry.experimentId} | ${entry.techniqueClass ?? "-"} | ${formatNumber(entry.candidateMetric)} | ${formatNumber(entry.improvement)} | ${entry.accepted ? "**" : ""}${entry.verdict}${entry.accepted ? "**" : ""} | ${entry.resources ? `${entry.resources.peakRssMb !== undefined ? `${(entry.resources.peakRssMb / 1024).toFixed(1)} GB` : "-"} / ${entry.resources.wallSeconds !== undefined ? `${Math.round(entry.resources.wallSeconds)} s` : "-"}${entry.resources.ok ? "" : " OVER"}` : "-"} | ${entry.reason.replace(/\|/g, "/").slice(0, 160)} |`),
    "",
  ];
  return lines.join("\n");
}
