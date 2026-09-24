import { createHash } from "node:crypto";
import type { ExperimentExecutorKind } from "./types.js";

export interface CampaignTimeState {
  startedAt: string;
  status: string;
  pausedAt?: string;
  pausedDurationMinutes?: number;
}

export const CAMPAIGN_CHECKPOINT_STEPS = ["cycle-start", "research-lanes", "research-director", "research-critic", "experiment-execution", "cycle-complete", "campaign-terminal"] as const;
export type CampaignCheckpointStep = typeof CAMPAIGN_CHECKPOINT_STEPS[number];

export interface CampaignCheckpoint {
  currentCycle: number;
  currentStep: CampaignCheckpointStep;
  checkpointedAt: string;
}

/** Validate optional checkpoint metadata without rejecting legacy campaigns. */
export function readCampaignCheckpoint(value: unknown): CampaignCheckpoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.currentCycle !== "number" || !Number.isInteger(candidate.currentCycle) || candidate.currentCycle < 0) return undefined;
  if (!CAMPAIGN_CHECKPOINT_STEPS.includes(candidate.currentStep as CampaignCheckpointStep)) return undefined;
  if (typeof candidate.checkpointedAt !== "string" || !Number.isFinite(Date.parse(candidate.checkpointedAt))) return undefined;
  return { currentCycle: candidate.currentCycle, currentStep: candidate.currentStep as CampaignCheckpointStep, checkpointedAt: candidate.checkpointedAt };
}

/** Resume the interrupted cycle; only a fully completed cycle advances the counter. */
export function nextCampaignCycle(checkpoint?: CampaignCheckpoint): number {
  if (!checkpoint) return 0;
  return checkpoint.currentStep === "cycle-complete" ? checkpoint.currentCycle + 1 : checkpoint.currentCycle;
}

/** Attach a validated checkpoint to any campaign-shaped payload. */
export function withCampaignCheckpoint<T extends object>(campaign: T, step: CampaignCheckpointStep, cycle: number, checkpointedAt = new Date().toISOString()): T & CampaignCheckpoint {
  if (!Number.isInteger(cycle) || cycle < 0) throw new Error("Campaign checkpoint cycle must be a non-negative integer.");
  if (!Number.isFinite(Date.parse(checkpointedAt))) throw new Error("Campaign checkpoint timestamp must be a valid date.");
  return { ...campaign, currentCycle: cycle, currentStep: step, checkpointedAt };
}

/**
 * The execution settings that must travel with a durable campaign.  Keeping
 * these beside the campaign state means a resumed controller does not
 * silently switch provider, executor, or safety policy because the terminal
 * that launched it is different.
 */
export interface CampaignRuntimeConfig {
  mode: "research" | "challenge";
  provider: "codex" | "local";
  model: string;
  /** Optional local Ollama route used when Codex is exhausted or unavailable. */
  fallbackModel?: string;
  thinking: string;
  lanes: number;
  /** Optional hard wall-clock budget per specialist lane. */
  laneBudgetMinutes?: number;
  autonomy: "safe" | "fast" | "yolo";
  limitPolicy: "auto" | "wait" | "fallback" | "stop";
  executor: ExperimentExecutorKind;
}

export type DurableCampaignRuntime = CampaignRuntimeConfig & { fingerprint: string };

/** Resolve the durable campaign mode, falling back to legacy scheduler state. */
export function resolveCampaignMode(campaignMode: unknown, schedulerMode: unknown): "research" | "challenge" {
  if (campaignMode === "research" || campaignMode === "challenge") return campaignMode;
  return schedulerMode === "challenge" ? "challenge" : "research";
}

/** Stable integrity binding for the safety-relevant campaign route. */
export function campaignRuntimeFingerprint(runtime: CampaignRuntimeConfig): string {
  const canonical = JSON.stringify({
    mode: runtime.mode,
    provider: runtime.provider,
    model: runtime.model,
    ...(runtime.fallbackModel ? { fallbackModel: runtime.fallbackModel } : {}),
    thinking: runtime.thinking,
    lanes: runtime.lanes,
    ...(runtime.laneBudgetMinutes !== undefined ? { laneBudgetMinutes: runtime.laneBudgetMinutes } : {}),
    autonomy: runtime.autonomy,
    limitPolicy: runtime.limitPolicy,
    executor: runtime.executor,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function readCampaignRuntime(value: unknown): CampaignRuntimeConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const runtime = (value as { runtime?: unknown }).runtime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return undefined;
  const candidate = runtime as Record<string, unknown>;
  if (!(["research", "challenge"] as const).includes(candidate.mode as "research" | "challenge")) return undefined;
  if (!( ["codex", "local"] as const).includes(candidate.provider as "codex" | "local")) return undefined;
  if (typeof candidate.model !== "string" || !candidate.model) return undefined;
  if (typeof candidate.thinking !== "string" || !candidate.thinking) return undefined;
  if (typeof candidate.lanes !== "number" || !Number.isInteger(candidate.lanes) || candidate.lanes < 1 || candidate.lanes > 6) return undefined;
  if (candidate.laneBudgetMinutes !== undefined && (typeof candidate.laneBudgetMinutes !== "number" || !Number.isFinite(candidate.laneBudgetMinutes) || candidate.laneBudgetMinutes <= 0)) return undefined;
  if (!( ["safe", "fast", "yolo"] as const).includes(candidate.autonomy as "safe" | "fast" | "yolo")) return undefined;
  if (!( ["auto", "wait", "fallback", "stop"] as const).includes(candidate.limitPolicy as "auto" | "wait" | "fallback" | "stop")) return undefined;
  if (!( ["local", "container", "modal", "slurm"] as const).includes(candidate.executor as ExperimentExecutorKind)) return undefined;
  return {
    mode: candidate.mode as CampaignRuntimeConfig["mode"],
    provider: candidate.provider as CampaignRuntimeConfig["provider"],
    model: candidate.model,
    ...(typeof candidate.fallbackModel === "string" && candidate.fallbackModel ? { fallbackModel: candidate.fallbackModel } : {}),
    thinking: candidate.thinking,
    lanes: candidate.lanes,
    ...(candidate.laneBudgetMinutes !== undefined ? { laneBudgetMinutes: candidate.laneBudgetMinutes } : {}),
    autonomy: candidate.autonomy as CampaignRuntimeConfig["autonomy"],
    limitPolicy: candidate.limitPolicy as CampaignRuntimeConfig["limitPolicy"],
    executor: candidate.executor as CampaignRuntimeConfig["executor"],
  };
}

/** Read a runtime only when its durable integrity binding is present and correct. */
export function readDurableCampaignRuntime(value: unknown): DurableCampaignRuntime | undefined {
  const runtime = readCampaignRuntime(value);
  if (!runtime || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const envelope = value as { runtime?: unknown; runtimeFingerprint?: unknown };
  const candidate = envelope.runtime;
  const nestedFingerprint = candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? (candidate as { fingerprint?: unknown }).fingerprint
    : undefined;
  const fingerprint = typeof nestedFingerprint === "string" ? nestedFingerprint : envelope.runtimeFingerprint;
  if (typeof fingerprint !== "string" || fingerprint !== campaignRuntimeFingerprint(runtime)) return undefined;
  return { ...runtime, fingerprint };
}

/** Attach an immutable route fingerprint while preserving an existing valid route. */
export function bindCampaignRuntime<T extends object>(campaign: T, fallback: CampaignRuntimeConfig): T & { runtime: DurableCampaignRuntime; runtimeFingerprint: string } {
  const existing = readDurableCampaignRuntime(campaign);
  const runtime = existing ?? fallback;
  const fingerprint = campaignRuntimeFingerprint(runtime);
  return { ...campaign, runtime: { ...runtime, fingerprint }, runtimeFingerprint: fingerprint };
}

/** Wall-clock campaign usage excluding durable paused intervals. */
export function campaignElapsedMinutes(campaign: CampaignTimeState, now = Date.now()): number {
  const started = Date.parse(campaign.startedAt);
  if (!Number.isFinite(started)) return 0;
  const accumulatedPause = Math.max(0, campaign.pausedDurationMinutes ?? 0) * 60_000;
  const activePause = campaign.status === "paused" && campaign.pausedAt
    ? Math.max(0, now - Date.parse(campaign.pausedAt))
    : 0;
  return Math.max(0, (now - started - accumulatedPause - activePause) / 60_000);
}

/** Remaining wall-clock budget for a durable campaign, excluding paused time. */
export function campaignRemainingMs(campaign: CampaignTimeState & { budgetMinutes: number }, now = Date.now()): number {
  if (!Number.isFinite(campaign.budgetMinutes) || campaign.budgetMinutes < 0) return 0;
  return Math.max(0, (campaign.budgetMinutes - campaignElapsedMinutes(campaign, now)) * 60_000);
}

/**
 * Allocate one model stage from the remaining campaign budget. This keeps
 * short smoke campaigns bounded while allowing tool-heavy turns in serious
 * multi-hour campaigns to finish instead of inheriting an arbitrary tiny cap.
 */
export function researchTurnTimeoutMs(remainingBudgetMs: number, maxTimeoutMs = 30 * 60_000): number {
  if (!Number.isFinite(remainingBudgetMs) || remainingBudgetMs <= 0) return 0;
  const ceiling = Math.max(1_000, Number.isFinite(maxTimeoutMs) ? maxTimeoutMs : 30 * 60_000);
  // The minimum applies only while meaningful budget remains. Once a short
  // campaign is nearly exhausted, the hard campaign budget must win over a
  // provider-stage convenience floor.
  return Math.max(1, Math.min(ceiling, Math.floor(remainingBudgetMs / 4)));
}

export function pauseCampaign<T extends CampaignTimeState>(campaign: T, now = new Date().toISOString()): T {
  if (campaign.status === "paused") return campaign;
  return { ...campaign, status: "paused", pausedAt: now };
}

export function resumeCampaign<T extends CampaignTimeState>(campaign: T, now = new Date().toISOString()): T {
  if (campaign.status === "completed" || campaign.status === "setup") return campaign;
  if (campaign.status !== "paused" || !campaign.pausedAt) return { ...campaign, status: "running" };
  const pausedMs = Math.max(0, Date.parse(now) - Date.parse(campaign.pausedAt));
  return {
    ...campaign,
    status: "running",
    pausedDurationMinutes: (campaign.pausedDurationMinutes ?? 0) + pausedMs / 60_000,
    pausedAt: undefined,
  };
}
